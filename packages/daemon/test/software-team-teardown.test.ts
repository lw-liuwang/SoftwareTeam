import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SoftwareTeamTeardownOrchestrator } from "../src/domain/software-team-teardown.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


function mockTmux(killResult?: { ok: boolean; code?: string; message?: string }): TmuxAdapter {
  return {
    killSession: vi.fn(async () => killResult ?? { ok: true }),
    createSession: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    hasSession: vi.fn(async () => false),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
    getPanePid: vi.fn(async () => null),
    getPaneCommand: vi.fn(async () => null),
    capturePaneContent: vi.fn(async () => null),
  } as unknown as TmuxAdapter;
}

function mockSnapshotCapture(db: Database.Database): SnapshotCapture {
  return {
    captureSnapshot: vi.fn(() => ({ id: "snap-1", softwareTeamId: "x", kind: "manual", status: "complete", data: "{}", createdAt: new Date().toISOString() })),
    db,
  } as unknown as SnapshotCapture;
}

describe("SoftwareTeamTeardownOrchestrator", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "software-team-teardown-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedSoftwareTeam(): { softwareTeamId: string; nodeId: string; sessionId: string } {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev");
    const session = sessionRegistry.registerSession(node.id, "r01-dev");
    sessionRegistry.updateStatus(session.id, "running");
    return { softwareTeamId: softwareTeam.id, nodeId: node.id, sessionId: session.id };
  }

  function seedSoftwareTeamWithNode(opts: { runtime: string; cwd: string; sessionStatus?: string }): { softwareTeamId: string; nodeId: string; sessionId: string } {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev", { runtime: opts.runtime, cwd: opts.cwd });
    const session = sessionRegistry.registerSession(node.id, "r01-dev");
    sessionRegistry.updateStatus(session.id, opts.sessionStatus ?? "running");
    return { softwareTeamId: softwareTeam.id, nodeId: node.id, sessionId: session.id };
  }

  function buildTeardown(tmux?: TmuxAdapter) {
    return new SoftwareTeamTeardownOrchestrator({
      db, softwareTeamRepo, sessionRegistry,
      tmuxAdapter: tmux ?? mockTmux(),
      snapshotCapture: mockSnapshotCapture(db),
      eventBus,
    });
  }

  // T1: Kills tmux sessions
  it.each([true, false])("reports service project retention with live sessions=%s", async (live) => {
    const softwareTeamId = live ? seedSoftwareTeam().softwareTeamId : softwareTeamRepo.createSoftwareTeam("archived").id;
    const kept = "kept project shared: still used by SoftwareTeam successor (software-team-2)";
    const td = new SoftwareTeamTeardownOrchestrator({
      db, softwareTeamRepo, sessionRegistry, tmuxAdapter: mockTmux(), snapshotCapture: mockSnapshotCapture(db), eventBus,
      serviceOrchestrator: { teardown: async () => ({ ok: true, kept }) } as never,
    });
    expect((await td.teardown(softwareTeamId)).errors).toContain(kept);
  });

  it("teardown kills tmux sessions", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const tmux = mockTmux();
    const td = buildTeardown(tmux);

    await td.teardown(softwareTeamId);

    expect(tmux.killSession).toHaveBeenCalledWith("r01-dev");
  });

  // T2: Bindings cleared
  it("bindings cleared after teardown", async () => {
    const { softwareTeamId, nodeId } = seedSoftwareTeam();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const td = buildTeardown();

    await td.teardown(softwareTeamId);

    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
  });

  // T3: Sessions marked exited
  it("sessions marked exited", async () => {
    const { softwareTeamId, sessionId } = seedSoftwareTeam();
    const td = buildTeardown();

    await td.teardown(softwareTeamId);

    const sessions = sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId);
    const latest = sessions.find((s) => s.id === sessionId);
    expect(latest?.status).toBe("exited");
  });

  it.each([true, false])("keeps the existing teardown result when additional intent bookkeeping throws (live=%s)", async live => {
    const { softwareTeamId, nodeId, sessionId } = seedSoftwareTeam();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    if (!live) sessionRegistry.markDetached(sessionId);
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: live ? "present" : "absent" }));
    const prepare = db.prepare.bind(db);
    const fault = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("s.intentionally_stopped = 0")) throw new Error("fixture eligibility query failed");
      return prepare(sql);
    });
    try {
      expect(await buildTeardown(tmux).teardown(softwareTeamId)).toEqual({
        softwareTeamId, sessionsKilled: live ? 1 : 0, snapshotId: live ? "snap-1" : null,
        deleted: false, deleteBlocked: false, alreadyStopped: !live, errors: [],
      });
      expect(sessionRegistry.getBindingForNode(nodeId) === null).toBe(live);
      expect(tmux.killSession).toHaveBeenCalledTimes(live ? 1 : 0);
    } finally {
      fault.mockRestore();
    }
  });

  it("kills live sessions before probing already-detached seats", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const detached = softwareTeamRepo.addNode(softwareTeamId, "old");
    const session = sessionRegistry.registerSession(detached.id, "r01-old");
    sessionRegistry.markDetached(session.id);
    const calls: string[] = [];
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async name => {
      calls.push(`probe ${name}`);
      return { state: name === "r01-dev" ? "present" : "absent" };
    });
    tmux.killSession = vi.fn(async name => { calls.push(`kill ${name}`); return { ok: true }; });
    await buildTeardown(tmux).teardown(softwareTeamId);
    expect(calls).toEqual(["probe r01-dev", "kill r01-dev", "probe r01-old"]);
  });

  it("records stop intent only for a confirmed successful teardown", async () => {
    const { softwareTeamId, nodeId, sessionId } = seedSoftwareTeam();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    await buildTeardown().teardown(softwareTeamId);
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "exited", intentionally_stopped: 1 });
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
    // Repeating down must not turn a deliberate stop into an ordinary exit.
    await buildTeardown().teardown(softwareTeamId);
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ intentionally_stopped: 1 });
  });

  it.each(["detached", "exited"])("records explicit down of an unbound %s seat only after confirmed absence", async status => {
    const { softwareTeamId, sessionId } = seedSoftwareTeam();
    sessionRegistry.updateStatus(sessionId, status);
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: "absent" }));
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ intentionally_stopped: 0 });
    expect(await buildTeardown(tmux).teardown(softwareTeamId)).toMatchObject({ alreadyStopped: true, sessionsKilled: 0 });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "exited", intentionally_stopped: 1 });
  });

  it("records down after reconciliation leaves a detached session's original binding", async () => {
    const { softwareTeamId, nodeId, sessionId } = seedSoftwareTeam();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev", tmuxPane: "%1" });
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: "absent" }));
    const { Reconciler } = await import("../src/domain/reconciler.js");
    await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).reconcile(softwareTeamId);
    expect(sessionRegistry.getBindingForNode(nodeId)).not.toBeNull();
    await buildTeardown(tmux).teardown(softwareTeamId);
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "exited", intentionally_stopped: 1 });
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it.each(["present", "transport_unavailable", "throw", "no-probe"])("keeps an unconfirmed detached seat unchanged: %s", async state => {
    const { softwareTeamId, sessionId } = seedSoftwareTeam();
    sessionRegistry.updateStatus(sessionId, "detached");
    const tmux = mockTmux();
    if (state !== "no-probe") tmux.probeSession = vi.fn(async () => {
      if (state === "throw") throw new Error("fixture unavailable");
      return state === "present" ? { state: "present" } : { state: "transport_unavailable", cause: "fixture unavailable" };
    });
    await buildTeardown(tmux).teardown(softwareTeamId);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "detached", intentionally_stopped: 0 });
  });

  it("preserves a detached node's binding, including a binding created while its absence probe awaited", async () => {
    const { softwareTeamId, nodeId, sessionId } = seedSoftwareTeam();
    sessionRegistry.updateStatus(sessionId, "detached");
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => {
      sessionRegistry.updateBinding(nodeId, { tmuxSession: "new-owner", tmuxPane: "%new" });
      return { state: "absent" };
    });
    await buildTeardown(tmux).teardown(softwareTeamId);
    expect(sessionRegistry.getBindingForNode(nodeId)).toMatchObject({ tmuxSession: "new-owner", tmuxPane: "%new" });
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "detached", intentionally_stopped: 0 });
    vi.mocked(tmux.probeSession).mockClear();
    await buildTeardown(tmux).teardown(softwareTeamId);
    expect(tmux.probeSession).not.toHaveBeenCalled();
  });

  it("does not mark an older detached session after a new session appears during the probe", async () => {
    const { softwareTeamId, nodeId, sessionId } = seedSoftwareTeam();
    sessionRegistry.updateStatus(sessionId, "detached");
    db.prepare("UPDATE sessions SET created_at = '2000-01-01' WHERE id = ?").run(sessionId);
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => {
      const newer = sessionRegistry.registerSession(nodeId, "r01-new");
      sessionRegistry.updateStatus(newer.id, "running");
      return { state: "absent" };
    });
    await buildTeardown(tmux).teardown(softwareTeamId);
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "detached", intentionally_stopped: 0 });
    expect(sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId).find(s => s.sessionName === "r01-new")?.status).toBe("running");
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  // T4: SoftwareTeam preserved
  it("SoftwareTeam record preserved without --delete", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const td = buildTeardown();

    const result = await td.teardown(softwareTeamId);

    expect(result.deleted).toBe(false);
    expect(softwareTeamRepo.getSoftwareTeam(softwareTeamId)).toBeTruthy();
  });

  // T5: --delete removes softwareTeam
  it("--delete removes SoftwareTeam after stop", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const td = buildTeardown();

    const result = await td.teardown(softwareTeamId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(softwareTeamRepo.getSoftwareTeam(softwareTeamId)).toBeNull();
  });

  // T6: --snapshot
  it("--snapshot captures before teardown", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const td = buildTeardown();

    const result = await td.teardown(softwareTeamId, { snapshot: true });

    expect(result.snapshotId).toBe("snap-1");
  });

  it("refreshes resume metadata before snapshot capture", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const refresh = vi.fn(async () => {});
    const td = new SoftwareTeamTeardownOrchestrator({
      db, softwareTeamRepo, sessionRegistry,
      tmuxAdapter: mockTmux(),
      snapshotCapture: mockSnapshotCapture(db),
      eventBus,
      resumeMetadataRefresher: { refresh } as unknown as import("../src/domain/resume-metadata-refresher.js").ResumeMetadataRefresher,
    });

    await td.teardown(softwareTeamId);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("captures durable recovery state before stopping when live metadata discovery fails", async () => {
    const { softwareTeamId, nodeId, sessionId } = seedSoftwareTeamWithNode({ runtime: "codex", cwd: tmpDir });
    sessionRegistry.updateResumeToken(sessionId, "codex_id", "saved-thread", "operator");
    const missingTokenNode = softwareTeamRepo.addNode(softwareTeamId, "new-seat", { runtime: "codex", cwd: tmpDir });
    const missingTokenSession = sessionRegistry.registerSession(missingTokenNode.id, "new-seat@test-software-team");
    sessionRegistry.updateStatus(missingTokenSession.id, "running");
    const checkpointStore = new CheckpointStore(db);
    checkpointStore.createCheckpoint(nodeId, { summary: "latest work", nextStep: "finish review" });
    const snapshotRepo = new SnapshotRepository(db);
    const snapshotCapture = new SnapshotCapture({ db, softwareTeamRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const tmux = mockTmux();
    tmux.getPanePid = vi.fn(async () => 100);
    const refresher = new ResumeMetadataRefresher({ sessionRegistry, tmuxAdapter: tmux,
      listProcesses: async () => { throw new Error("process discovery timed out"); } });
    tmux.killSession = vi.fn(async () => {
      const captured = snapshotRepo.findLatestAutoPreDown(softwareTeamId);
      expect(captured?.data.sessions.find(s => s.id === sessionId)).toMatchObject({ status: "running", resumeToken: "saved-thread" });
      expect(captured?.data.checkpoints[nodeId]).toMatchObject({ summary: "latest work", nextStep: "finish review" });
      return { ok: true };
    });
    const td = new SoftwareTeamTeardownOrchestrator({ db, softwareTeamRepo, sessionRegistry, eventBus,
      tmuxAdapter: tmux, snapshotCapture, resumeMetadataRefresher: refresher });

    const result = await td.teardown(softwareTeamId);

    expect(result.snapshotId).toBe(snapshotRepo.findLatestAutoPreDown(softwareTeamId)?.id);
    expect(result.snapshotId).not.toBeNull();
    expect(result.sessionsKilled).toBe(2);
    expect(result.errors).toContain("Resume metadata refresh failed: process discovery timed out");
    expect(result.errors.some(error => error.startsWith("Snapshot failed:"))).toBe(false);
    expect(sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId).find(s => s.id === sessionId)?.status).toBe("exited");
  });

  it("reports refresh and capture failures separately and still stops the softwareTeam", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const snapshotCapture = mockSnapshotCapture(db);
    vi.mocked(snapshotCapture.captureSnapshot).mockImplementation(() => { throw new Error("snapshot storage unavailable"); });
    const tmux = mockTmux();
    const td = new SoftwareTeamTeardownOrchestrator({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, snapshotCapture,
      resumeMetadataRefresher: { refresh: async () => { throw new Error("discovery unavailable"); } } as unknown as ResumeMetadataRefresher });

    const result = await td.teardown(softwareTeamId);

    expect(snapshotCapture.captureSnapshot).toHaveBeenCalledWith(softwareTeamId, "auto-pre-down");
    expect(result).toMatchObject({ snapshotId: null, sessionsKilled: 1 });
    expect(result.errors).toEqual(["Resume metadata refresh failed: discovery unavailable", "Snapshot failed: snapshot storage unavailable"]);
  });

  // T7: --force (same as default in v1)
  it("--force kills sessions", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const tmux = mockTmux();
    const td = buildTeardown(tmux);

    await td.teardown(softwareTeamId, { force: true });

    expect(tmux.killSession).toHaveBeenCalled();
  });

  // T8: Nonexistent softwareTeam
  it("nonexistent SoftwareTeam throws", async () => {
    const td = buildTeardown();

    await expect(td.teardown("nonexistent")).rejects.toThrow(/not found/);
  });

  // T9: Already stopped
  it("already-stopped SoftwareTeam returns alreadyStopped=true", async () => {
    const { softwareTeamId, sessionId } = seedSoftwareTeam();
    sessionRegistry.updateStatus(sessionId, "exited"); // already stopped
    const td = buildTeardown();

    const result = await td.teardown(softwareTeamId);

    expect(result.alreadyStopped).toBe(true);
    expect(result.sessionsKilled).toBe(0);
  });

  // T10: software-team.stopped event
  it("software-team.stopped event emitted", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const td = buildTeardown();

    await td.teardown(softwareTeamId);

    const events = db.prepare("SELECT type FROM events WHERE type = 'software-team.stopped'").all() as Array<{ type: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  // T11: Multi-session node — only newest killed
  it("multiple session rows — only newest live session acted on", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r11");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev");
    // Old session (exited) - earlier timestamp + earlier id
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'exited', ?)")
      .run("sess-aaa", node.id, "r11-old", "2026-03-26 09:00:00");
    // New session (running) - later timestamp + later id
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'running', ?)")
      .run("sess-zzz", node.id, "r11-new", "2026-03-26 12:00:00");

    const tmux = mockTmux();
    const td = buildTeardown(tmux);

    await td.teardown(softwareTeam.id);

    // Only the new session should be killed
    expect(tmux.killSession).toHaveBeenCalledWith("r11-new");
    expect(tmux.killSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["claude-code", "CLAUDE.md"], ["claude-code", "CLAUDE.local.md"], ["codex", "AGENTS.md"],
  ])("preserves %s guidance when a sibling sharing %s cannot stop", async (runtime, fileName) => {
    const { softwareTeamId, nodeId, sessionId } = seedSoftwareTeamWithNode({ runtime, cwd: tmpDir });
    if (fileName === "CLAUDE.local.md") softwareTeamRepo.setSoftwareTeamClaudeManagedBlockFile(softwareTeamId, fileName);
    const sibling = softwareTeamRepo.addNode(softwareTeamId, "survivor", { runtime, cwd: tmpDir });
    const survivingSession = sessionRegistry.registerSession(sibling.id, "survivor@test-software-team");
    sessionRegistry.updateStatus(survivingSession.id, "running");
    const guidance = path.join(tmpDir, fileName);
    const content = "Operator notes\n<!-- BEGIN SoftwareTeam MANAGED BLOCK: role -->\nworking guidance\n<!-- END SoftwareTeam MANAGED BLOCK: role -->\n";
    fs.writeFileSync(guidance, content);
    const tmux = mockTmux();
    tmux.killSession = vi.fn(async target => target === "survivor@test-software-team"
      ? { ok: false, code: "kill_failed", message: "tmux error" } : { ok: true });

    const result = await buildTeardown(tmux).teardown(softwareTeamId, { delete: true });

    expect(result).toMatchObject({ sessionsKilled: 1, deleted: false, deleteBlocked: true });
    expect(sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId).find(s => s.id === sessionId)?.status).toBe("exited");
    expect(sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId).find(s => s.id === survivingSession.id)?.status).toBe("running");
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(sessionId)).toEqual({ intentionally_stopped: 1 });
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(survivingSession.id)).toEqual({ intentionally_stopped: 0 });
    expect(fs.readFileSync(guidance, "utf-8")).toBe(content);
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();

    // A later successful shutdown releases the file for ordinary cleanup.
    tmux.killSession = vi.fn(async () => ({ ok: true }));
    await buildTeardown(tmux).teardown(softwareTeamId);
    expect(fs.readFileSync(guidance, "utf-8")).toBe("Operator notes\n");
  });

  it.each(["kill_failed", "transport_unavailable"] as const)("keeps guidance when termination is unconfirmed: %s", async failure => {
    const { softwareTeamId, sessionId } = seedSoftwareTeamWithNode({ runtime: "codex", cwd: tmpDir });
    const guidance = path.join(tmpDir, "AGENTS.md");
    const content = "<!-- BEGIN SoftwareTeam MANAGED BLOCK: role -->\nworking guidance\n<!-- END SoftwareTeam MANAGED BLOCK: role -->\n";
    fs.writeFileSync(guidance, content);
    const tmux = mockTmux({ ok: false, code: "kill_failed", message: "tmux error" });
    if (failure === "transport_unavailable") tmux.probeSession = vi.fn(async () => ({ state: "transport_unavailable", cause: "socket unavailable" }));
    await buildTeardown(tmux).teardown(softwareTeamId);
    expect(sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId).find(s => s.id === sessionId)?.status).toBe("running");
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(sessionId)).toEqual({ intentionally_stopped: 0 });
    expect(fs.readFileSync(guidance, "utf-8")).toBe(content);
  });

  it("preserves another softwareTeam's shared guidance during ordinary teardown", async () => {
    const { softwareTeamId } = seedSoftwareTeamWithNode({ runtime: "codex", cwd: tmpDir });
    const other = softwareTeamRepo.createSoftwareTeam("other-software-team");
    const otherNode = softwareTeamRepo.addNode(other.id, "dev", { runtime: "codex", cwd: tmpDir });
    const session = sessionRegistry.registerSession(otherNode.id, "dev@other-software-team");
    sessionRegistry.updateStatus(session.id, "running");
    const guidance = path.join(tmpDir, "AGENTS.md");
    const content = "<!-- BEGIN SoftwareTeam MANAGED BLOCK: role -->\nshared guidance\n<!-- END SoftwareTeam MANAGED BLOCK: role -->\n";
    fs.writeFileSync(guidance, content);
    await buildTeardown().teardown(softwareTeamId);
    expect(fs.readFileSync(guidance, "utf-8")).toBe(content);
  });

  // T12: Kill failure + --delete -> blocked
  it("kill failure blocks --delete", async () => {
    const { softwareTeamId, nodeId } = seedSoftwareTeam();
    const tmux = mockTmux({ ok: false, code: "kill_failed", message: "tmux error" });
    const td = buildTeardown(tmux);

    const result = await td.teardown(softwareTeamId, { delete: true });

    expect(result.deleted).toBe(false);
    expect(result.errors.some((e) => e.includes("blocked"))).toBe(true);
    expect(softwareTeamRepo.getSoftwareTeam(softwareTeamId)).toBeTruthy();
    // Node should NOT be marked exited
    const sessions = sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId);
    expect(sessions.some((s) => s.status === "running")).toBe(true);
  });

  // T13: Stale session (tmux gone) -> benign
  it("stale session (tmux already gone) treated as success", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const tmux = mockTmux({ ok: false, code: "session_not_found" });
    const td = buildTeardown(tmux);

    const result = await td.teardown(softwareTeamId, { delete: true });

    expect(result.sessionsKilled).toBe(0);
    expect(result.deleted).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("deletes a failed launch whose recorded session is absent without asking the guard to kill it", async () => {
    const { softwareTeamId, nodeId } = seedSoftwareTeam();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const tmux = mockTmux({ ok: false, code: "guard_target_unknown", message: "ambiguous target" });
    tmux.probeSession = vi.fn(async () => ({ state: "absent" }));

    const result = await buildTeardown(tmux).teardown(softwareTeamId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(result.deleteBlocked).toBe(false);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(softwareTeamRepo.getSoftwareTeam(softwareTeamId)).toBeNull();
  });

  it("deletes an archived duplicate without killing the live softwareTeam's same-name session", async () => {
    const stale = seedSoftwareTeam();
    sessionRegistry.updateBinding(stale.nodeId, { tmuxSession: "r01-dev" });
    softwareTeamRepo.archiveSoftwareTeam(stale.softwareTeamId);
    const liveSoftwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const liveNode = softwareTeamRepo.addNode(liveSoftwareTeam.id, "dev");
    const liveSession = sessionRegistry.registerSession(liveNode.id, "r01-dev");
    sessionRegistry.updateStatus(liveSession.id, "running");
    sessionRegistry.updateBinding(liveNode.id, { tmuxSession: "r01-dev" });
    db.prepare("UPDATE nodes SET runtime = 'claude-code', cwd = ? WHERE id IN (?, ?)")
      .run(tmpDir, stale.nodeId, liveNode.id);
    const guidance = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(guidance, "<!-- BEGIN SoftwareTeam MANAGED BLOCK: role -->\nlive guidance\n<!-- END SoftwareTeam MANAGED BLOCK: role -->\n");
    const tmux = mockTmux({ ok: false, code: "guard_target_unknown", message: "owned by live softwareTeam" });
    tmux.probeSession = vi.fn(async () => ({ state: "present" }));

    const result = await buildTeardown(tmux).teardown(stale.softwareTeamId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(softwareTeamRepo.getSoftwareTeam(liveSoftwareTeam.id)).not.toBeNull();
    expect(sessionRegistry.getSessionsForSoftwareTeam(liveSoftwareTeam.id)[0]?.status).toBe("running");
    expect(sessionRegistry.getBindingForNode(liveNode.id)?.tmuxSession).toBe("r01-dev");
    expect(fs.readFileSync(guidance, "utf-8")).toContain("live guidance");
  });

  it("keeps the SoftwareTeam when tmux cannot confirm whether a session is absent", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: "transport_unavailable", cause: "permission denied" }));

    const result = await buildTeardown(tmux).teardown(softwareTeamId, { delete: true });

    expect(result.deleteBlocked).toBe(true);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(softwareTeamRepo.getSoftwareTeam(softwareTeamId)).not.toBeNull();
  });

  it("retains the binding when the tmux server is unreachable", async () => {
    const { softwareTeamId, nodeId, sessionId } = seedSoftwareTeam();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: "transport_unavailable", cause: "no server running on /tmp/tmux-501/default" }));

    const result = await buildTeardown(tmux).teardown(softwareTeamId, { delete: true });

    expect(result).toMatchObject({ deleted: false, deleteBlocked: true, sessionsKilled: 0 });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(softwareTeamRepo.getSoftwareTeam(softwareTeamId)).not.toBeNull();
    expect(sessionRegistry.getBindingForNode(nodeId)?.tmuxSession).toBe("r01-dev");
    expect(sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId).find((session) => session.id === sessionId)?.status).toBe("running");
  });

  it("retains the binding if the tmux server vanishes between probe and kill", async () => {
    const { softwareTeamId, nodeId, sessionId } = seedSoftwareTeam();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const tmux = mockTmux({ ok: false, code: "session_not_found", message: "no server running on /tmp/tmux-501/default" });
    tmux.probeSession = vi.fn(async () => ({ state: "present" }));

    const result = await buildTeardown(tmux).teardown(softwareTeamId, { delete: true });

    expect(result).toMatchObject({ deleted: false, deleteBlocked: true, sessionsKilled: 0 });
    expect(softwareTeamRepo.getSoftwareTeam(softwareTeamId)).not.toBeNull();
    expect(sessionRegistry.getBindingForNode(nodeId)?.tmuxSession).toBe("r01-dev");
    expect(sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId).find((session) => session.id === sessionId)?.status).toBe("running");
  });

  it("preserves guidance shared with a live SoftwareTeam under a different name", async () => {
    const stale = seedSoftwareTeam();
    sessionRegistry.updateStatus(stale.sessionId, "exited");
    softwareTeamRepo.archiveSoftwareTeam(stale.softwareTeamId);
    const live = softwareTeamRepo.createSoftwareTeam("other-name");
    const liveNode = softwareTeamRepo.addNode(live.id, "dev");
    db.prepare("UPDATE nodes SET runtime = 'claude-code', cwd = ? WHERE id IN (?, ?)")
      .run(tmpDir, stale.nodeId, liveNode.id);
    const guidance = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(guidance, "<!-- BEGIN SoftwareTeam MANAGED BLOCK: role -->\nlive guidance\n<!-- END SoftwareTeam MANAGED BLOCK: role -->\n");

    const result = await buildTeardown().teardown(stale.softwareTeamId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(fs.readFileSync(guidance, "utf-8")).toContain("live guidance");
  });

  it.each([
    ["claude-code", "CLAUDE.md"],
    ["claude-code", "CLAUDE.local.md"],
    ["codex", "AGENTS.md"],
  ])("preserves %s guidance shared through a symlinked working directory (%s)", async (runtime, fileName) => {
    const realCwd = path.join(tmpDir, "real-workspace");
    const aliasCwd = path.join(tmpDir, "alias-workspace");
    fs.mkdirSync(realCwd);
    fs.symlinkSync(realCwd, aliasCwd, process.platform === "win32" ? "junction" : "dir");
    const stale = seedSoftwareTeamWithNode({ runtime, cwd: aliasCwd, sessionStatus: "exited" });
    softwareTeamRepo.archiveSoftwareTeam(stale.softwareTeamId);
    const live = softwareTeamRepo.createSoftwareTeam("live-name");
    softwareTeamRepo.addNode(live.id, "dev", { runtime, cwd: realCwd });
    if (fileName === "CLAUDE.local.md") {
      softwareTeamRepo.setSoftwareTeamClaudeManagedBlockFile(stale.softwareTeamId, fileName);
      softwareTeamRepo.setSoftwareTeamClaudeManagedBlockFile(live.id, fileName);
    }
    const guidance = path.join(realCwd, fileName);
    fs.writeFileSync(guidance, "<!-- BEGIN SoftwareTeam MANAGED BLOCK: role -->\nlive guidance\n<!-- END SoftwareTeam MANAGED BLOCK: role -->\n");

    const result = await buildTeardown().teardown(stale.softwareTeamId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(fs.readFileSync(guidance, "utf-8")).toContain("live guidance");
  });

  it.each([
    ["claude-code", "CLAUDE.md"],
    ["claude-code", "CLAUDE.local.md"],
    ["codex", "AGENTS.md"],
  ])("preserves %s guidance created while teardown probes tmux (%s)", async (runtime, fileName) => {
    const stale = seedSoftwareTeamWithNode({ runtime, cwd: tmpDir });
    softwareTeamRepo.archiveSoftwareTeam(stale.softwareTeamId);
    const live = softwareTeamRepo.createSoftwareTeam("live-name");
    softwareTeamRepo.addNode(live.id, "dev", { runtime, cwd: tmpDir });
    if (fileName === "CLAUDE.local.md") {
      softwareTeamRepo.setSoftwareTeamClaudeManagedBlockFile(stale.softwareTeamId, fileName);
      softwareTeamRepo.setSoftwareTeamClaudeManagedBlockFile(live.id, fileName);
    }
    const guidance = path.join(tmpDir, fileName);
    expect(fs.existsSync(guidance)).toBe(false);
    let probeEntered!: () => void;
    let resumeProbe!: () => void;
    const entered = new Promise<void>((resolve) => { probeEntered = resolve; });
    const resume = new Promise<void>((resolve) => { resumeProbe = resolve; });
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => {
      probeEntered();
      await resume;
      return { state: "absent" } as const;
    });

    const teardown = buildTeardown(tmux).teardown(stale.softwareTeamId, { delete: true });
    await entered;
    fs.writeFileSync(guidance, "<!-- BEGIN SoftwareTeam MANAGED BLOCK: role -->\nlive guidance\n<!-- END SoftwareTeam MANAGED BLOCK: role -->\n");
    resumeProbe();
    const result = await teardown;

    expect(result.deleted).toBe(true);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(fs.readFileSync(guidance, "utf-8")).toContain("live guidance");
  });

  it("preserves guidance shared through a case alias on a case-insensitive volume", async () => {
    const realCwd = path.join(tmpDir, "Workspace");
    const caseAlias = path.join(tmpDir, "workspace");
    fs.mkdirSync(realCwd);
    // This alias exists only on a case-insensitive test volume.
    if (!fs.existsSync(caseAlias)) return;
    const stale = seedSoftwareTeamWithNode({ runtime: "codex", cwd: caseAlias, sessionStatus: "exited" });
    softwareTeamRepo.archiveSoftwareTeam(stale.softwareTeamId);
    const live = softwareTeamRepo.createSoftwareTeam("live-name");
    softwareTeamRepo.addNode(live.id, "dev", { runtime: "codex", cwd: realCwd });
    const guidance = path.join(realCwd, "AGENTS.md");
    fs.writeFileSync(guidance, "<!-- BEGIN SoftwareTeam MANAGED BLOCK: role -->\nlive guidance\n<!-- END SoftwareTeam MANAGED BLOCK: role -->\n");

    const result = await buildTeardown().teardown(stale.softwareTeamId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(fs.readFileSync(guidance, "utf-8")).toContain("live guidance");
  });

  it("removes stale guidance when a same-name SoftwareTeam uses a different path", async () => {
    const stale = seedSoftwareTeam();
    sessionRegistry.updateStatus(stale.sessionId, "exited");
    softwareTeamRepo.archiveSoftwareTeam(stale.softwareTeamId);
    const live = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const liveNode = softwareTeamRepo.addNode(live.id, "dev");
    db.prepare("UPDATE nodes SET runtime = 'claude-code', cwd = ? WHERE id = ?")
      .run(tmpDir, stale.nodeId);
    db.prepare("UPDATE nodes SET runtime = 'claude-code', cwd = ? WHERE id = ?")
      .run(path.join(tmpDir, "other"), liveNode.id);
    const guidance = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(guidance, "<!-- BEGIN SoftwareTeam MANAGED BLOCK: role -->\nstale guidance\n<!-- END SoftwareTeam MANAGED BLOCK: role -->\n");

    const result = await buildTeardown().teardown(stale.softwareTeamId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(fs.existsSync(guidance)).toBe(false);
  });

  it("removes only SoftwareTeam-managed blocks and preserves user + third-party content", async () => {
    const cwd = path.join(tmpDir, "claude-project");
    fs.mkdirSync(cwd, { recursive: true });
    const claudeMd = path.join(cwd, "CLAUDE.md");
    fs.writeFileSync(claudeMd, [
      "# User intro",
      "<!-- BEGIN SoftwareTeam MANAGED BLOCK: role -->",
      "managed role",
      "<!-- END SoftwareTeam MANAGED BLOCK: role -->",
      "<!-- BEGIN THIRD PARTY BLOCK -->",
      "third party",
      "<!-- END THIRD PARTY BLOCK -->",
      "tail",
    ].join("\n\n"));
    const { softwareTeamId } = seedSoftwareTeamWithNode({ runtime: "claude-code", cwd });
    const td = buildTeardown();

    await td.teardown(softwareTeamId);

    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(content).toContain("# User intro");
    expect(content).toContain("third party");
    expect(content).toContain("tail");
    expect(content).not.toContain("BEGIN SoftwareTeam MANAGED BLOCK");
  });

  it("deletes guidance file if only SoftwareTeam-managed content remains after teardown", async () => {
    const cwd = path.join(tmpDir, "codex-project");
    fs.mkdirSync(cwd, { recursive: true });
    const agentsMd = path.join(cwd, "AGENTS.md");
    fs.writeFileSync(agentsMd, [
      "<!-- BEGIN SoftwareTeam MANAGED BLOCK: role -->",
      "managed role",
      "<!-- END SoftwareTeam MANAGED BLOCK: role -->",
    ].join("\n"));
    const { softwareTeamId } = seedSoftwareTeamWithNode({ runtime: "codex", cwd, sessionStatus: "exited" });
    const td = buildTeardown();

    const result = await td.teardown(softwareTeamId);

    expect(result.alreadyStopped).toBe(true);
    expect(fs.existsSync(agentsMd)).toBe(false);
  });

  // T14: Per-node cleanup is atomic (status + binding together)
  it("per-node cleanup updates status and clears binding atomically", async () => {
    const { softwareTeamId, nodeId, sessionId } = seedSoftwareTeam();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const td = buildTeardown();

    await td.teardown(softwareTeamId);

    // Both should be updated (transaction succeeded)
    const sessions = sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId);
    expect(sessions.find((s) => s.id === sessionId)?.status).toBe("exited");
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
  });

  // T15: --delete event sabotage -> softwareTeam not deleted
  it("software-team.deleted event failure prevents SoftwareTeam deletion", async () => {
    const { softwareTeamId } = seedSoftwareTeam();
    const td = buildTeardown();

    // Sabotage event persistence
    const origPersist = eventBus.persistWithinTransaction.bind(eventBus);
    eventBus.persistWithinTransaction = (event) => {
      if (event.type === "software-team.deleted") throw new Error("event persist failed");
      return origPersist(event);
    };

    // Teardown + delete should fail on the event
    const result = await td.teardown(softwareTeamId, { delete: true });

    // Sessions killed but softwareTeam NOT deleted (atomic delete + event rolled back)
    expect(result.sessionsKilled).toBe(1);
    expect(result.deleted).toBe(false);
    expect(softwareTeamRepo.getSoftwareTeam(softwareTeamId)).toBeTruthy();
    expect(result.errors.some((e) => e.includes("event persist failed") || e.includes("deletion"))).toBe(true);

    eventBus.persistWithinTransaction = origPersist;
  });
});
