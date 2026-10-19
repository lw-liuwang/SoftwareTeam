// #141: a YAML re-import archives the stopped earlier generation, whose pod members keep the session names the
// live replacement now owns. Shrinking the archived pod must neither be blocked by, nor reroute, the replacement's
// queue work, and must not kill its session. The owning pod's own refusal and --fallback stay. Fake tmux only.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SoftwareTeamLifecycleService } from "../src/domain/software-team-lifecycle-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const SOFTWARE_TEAM = "first-project";
const SEAT = `crew-lead@${SOFTWARE_TEAM}`;
const FALLBACK = "orch-lead@ops-software-team";

describe("#141 shrinking an archived generation's pod vs the live replacement's work", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let queueRepo: QueueRepository;
  let killSession: ReturnType<typeof vi.fn>;
  let lifecycle: SoftwareTeamLifecycleService;
  let stale: { softwareTeamId: string; podId: string };
  let live: { softwareTeamId: string; podId: string; sessionId: string };

  function generation(status: "running" | "exited") {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam(SOFTWARE_TEAM);
    const pod = new PodRepository(db).createPod(softwareTeam.id, "crew", "Crew");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "crew.lead", { runtime: "claude-code", podId: pod.id });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, status);
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT });
    return { softwareTeamId: softwareTeam.id, podId: pod.id, sessionId: session.id };
  }

  const openWork = () => queueRepo.create({ sourceSession: FALLBACK, destinationSession: SEAT, body: "replacement's work" });
  const liveStatus = () => (db.prepare("SELECT status FROM sessions WHERE id = ?").get(live.sessionId) as { status: string }).status;

  beforeEach(() => {
    db = createFullTestDb();
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    queueRepo = new QueueRepository(db, eventBus, { validateSoftwareTeam: () => true });
    killSession = vi.fn(async () => ({ ok: true as const }));
    lifecycle = new SoftwareTeamLifecycleService({
      db, softwareTeamRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus, queueRepo,
      // hasSession answers only the --fallback destination check; the fallback seat is the one "live" session.
      tmuxAdapter: { killSession, hasSession: vi.fn(async (name: string) => name === FALLBACK) } as unknown as TmuxAdapter,
    });
    // The P1 shape: the stopped generation was archived and the replacement re-created the same seat.
    stale = generation("exited");
    softwareTeamRepo.archiveSoftwareTeam(stale.softwareTeamId);
    live = generation("running");
    // A running seat elsewhere that can take explicitly rerouted work.
    const ops = softwareTeamRepo.createSoftwareTeam("ops-software-team");
    const orch = softwareTeamRepo.addNode(ops.id, "orch.lead", { runtime: "claude-code" });
    sessionRegistry.updateStatus(sessionRegistry.registerSession(orch.id, FALLBACK).id, "running");
  });
  afterEach(() => db.close());

  it("shrinking the archived pod is not blocked by the replacement's open work and keeps its session", async () => {
    const work = await openWork();

    const result = await lifecycle.shrinkPod(stale.softwareTeamId, stale.podId);

    expect(result).toMatchObject({ ok: true, status: "ok", sessionsKilled: 0, reroutedQitemIds: [] });
    expect(result.ok && result.nodes[0]).toMatchObject({ status: "removed", sessionKeptFor: `crew.lead@${SOFTWARE_TEAM}` });
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: SEAT, state: "pending" });
    expect(killSession).not.toHaveBeenCalled();
    expect(liveStatus()).toBe("running");
  });

  it("with --fallback, the replacement's open work does not move", async () => {
    const work = await openWork();

    const result = await lifecycle.shrinkPod(stale.softwareTeamId, stale.podId, { fallbackDestination: FALLBACK });

    expect(result).toMatchObject({ ok: true, status: "ok", reroutedQitemIds: [] });
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: SEAT, state: "pending" });
    expect(killSession).not.toHaveBeenCalled();
    expect(liveStatus()).toBe("running");
  });

  it("control: shrinking the live pod still refuses its own open work without --fallback", async () => {
    const work = await openWork();

    const result = await lifecycle.shrinkPod(live.softwareTeamId, live.podId);

    expect(result).toMatchObject({ ok: false, code: "active_qitems", activeQitemIds: [work.qitemId] });
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: SEAT, state: "pending" });
    expect(killSession).not.toHaveBeenCalled();
  });

  it("control: shrinking the live pod with --fallback reroutes its own work and kills its session once", async () => {
    const work = await openWork();

    const result = await lifecycle.shrinkPod(live.softwareTeamId, live.podId, { fallbackDestination: FALLBACK });

    expect(result).toMatchObject({ ok: true, status: "ok", sessionsKilled: 1, reroutedQitemIds: [work.qitemId] });
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: FALLBACK });
    expect(killSession).toHaveBeenCalledExactlyOnceWith(SEAT);
  });
});

// Members of the shrink target can share one session name. Another target member doesn't take that name's work out of
// the up-front check: the shrink still refuses without --fallback and reroutes once with it. Only an unarchived owner
// OUTSIDE the target does, and it must be found even when a target member's binding would come first.
describe("#141 shrink target members sharing a session name", () => {
  const SHARED = "shared@shared-software-team";
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let queueRepo: QueueRepository;
  let killSession: ReturnType<typeof vi.fn>;
  let lifecycle: SoftwareTeamLifecycleService;
  let target: { softwareTeamId: string; podId: string };

  beforeEach(() => {
    db = createFullTestDb();
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    queueRepo = new QueueRepository(db, eventBus, { validateSoftwareTeam: () => true });
    killSession = vi.fn(async () => ({ ok: true as const }));
    lifecycle = new SoftwareTeamLifecycleService({
      db, softwareTeamRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus, queueRepo,
      tmuxAdapter: { killSession, hasSession: vi.fn(async (name: string) => name === FALLBACK) } as unknown as TmuxAdapter,
    });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("shared-software-team");
    const pod = new PodRepository(db).createPod(softwareTeam.id, "crew", "Crew");
    for (const id of ["crew.a", "crew.b"]) {
      const node = softwareTeamRepo.addNode(softwareTeam.id, id, { runtime: "claude-code", podId: pod.id });
      sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, SHARED).id, "running");
      sessionRegistry.updateBinding(node.id, { tmuxSession: SHARED });
    }
    target = { softwareTeamId: softwareTeam.id, podId: pod.id };
    const ops = softwareTeamRepo.createSoftwareTeam("ops-software-team");
    const orch = softwareTeamRepo.addNode(ops.id, "orch.lead", { runtime: "claude-code" });
    sessionRegistry.updateStatus(sessionRegistry.registerSession(orch.id, FALLBACK).id, "running");
  });
  afterEach(() => db.close());

  const openWork = () => queueRepo.create({ sourceSession: FALLBACK, destinationSession: SHARED, body: "target's work" });
  const membersLeft = () => softwareTeamRepo.getSoftwareTeam(target.softwareTeamId)!.nodes.length;

  it("without --fallback the shrink refuses up front; every member and the work stay", async () => {
    const work = await openWork();

    const result = await lifecycle.shrinkPod(target.softwareTeamId, target.podId);

    expect(result).toMatchObject({ ok: false, code: "active_qitems", activeQitemIds: [work.qitemId] });
    expect(membersLeft()).toBe(2);
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: SHARED, state: "pending" });
    expect(killSession).not.toHaveBeenCalled();
  });

  it("with --fallback the work is rerouted once and the shrink completes", async () => {
    const work = await openWork();

    const result = await lifecycle.shrinkPod(target.softwareTeamId, target.podId, { fallbackDestination: FALLBACK });

    expect(result).toMatchObject({ ok: true, status: "ok", reroutedQitemIds: [work.qitemId] });
    expect(membersLeft()).toBe(0);
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: FALLBACK });
    expect(killSession).toHaveBeenCalledExactlyOnceWith(SHARED);
  });

  it.each(["binding", "session row"])("an unarchived owner outside the target (by %s) still keeps its work out of the check", async (via) => {
    // The target members' bindings exist first, so a lookup that returned one of them before excluding it would miss this owner.
    const other = softwareTeamRepo.addNode(softwareTeamRepo.createSoftwareTeam("other-software-team").id, "dev.other", { runtime: "claude-code" });
    if (via === "binding") sessionRegistry.updateBinding(other.id, { tmuxSession: SHARED });
    else sessionRegistry.updateStatus(sessionRegistry.registerSession(other.id, SHARED).id, "running");
    const work = await openWork();

    const result = await lifecycle.shrinkPod(target.softwareTeamId, target.podId);

    expect(result).toMatchObject({ ok: true, status: "ok", sessionsKilled: 0, reroutedQitemIds: [] });
    expect(queueRepo.getById(work.qitemId)).toMatchObject({ destinationSession: SHARED, state: "pending" });
    expect(killSession).not.toHaveBeenCalled();
  });
});
