// S4-start-last-respects-down — the per-seat difference between a softwareTeam taken down with `SoftwareTeam down`
// and one whose tmux sessions were lost (the boot reconciler marks each session detached). Both
// project the same software-team-level lifecycle, so `SoftwareTeam start --last` reads the seats from
// GET /api/software-teams/:softwareTeamId/nodes (intentionallyStopped, recorded by `SoftwareTeam down` since #1254).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SoftwareTeamTeardownOrchestrator } from "../src/domain/software-team-teardown.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { deriveSoftwareTeamLifecycleState } from "../src/domain/ps-projection.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";

// Every tmux session is gone: what a `SoftwareTeam down` kill and lost tmux sessions both leave behind.
function goneTmux(): TmuxAdapter {
  return {
    killSession: vi.fn(async () => ({ ok: true })),
    probeSession: vi.fn(async () => ({ state: "absent" })),
    hasSession: vi.fn(async () => false),
  } as unknown as TmuxAdapter;
}

describe("SoftwareTeam down leaves seats exited; when tmux is lost, the boot reconciler marks them detached", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => { db.close(); });

  function seedRunningSoftwareTeam(name: string): string {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam(name);
    for (const logicalId of ["dev.impl", "dev.qa"]) {
      const node = softwareTeamRepo.addNode(softwareTeam.id, logicalId);
      const session = sessionRegistry.registerSession(node.id, `${logicalId.replace(".", "-")}@${name}`);
      sessionRegistry.updateStatus(session.id, "running");
    }
    return softwareTeam.id;
  }

  const seatStatuses = (softwareTeamId: string) => getNodeInventory(db, softwareTeamId).map((n) => n.sessionStatus);
  const softwareTeamLifecycle = (softwareTeamId: string) => deriveSoftwareTeamLifecycleState(getNodeInventory(db, softwareTeamId).map((n) => n.lifecycleState));

  it("reports exited after SoftwareTeam down and detached after a boot reconcile, with the same SoftwareTeam lifecycle", async () => {
    const downed = seedRunningSoftwareTeam("downed");
    const crashed = seedRunningSoftwareTeam("crashed");
    const tmux = goneTmux();

    await new SoftwareTeamTeardownOrchestrator({
      db, softwareTeamRepo, sessionRegistry, tmuxAdapter: tmux, eventBus,
      snapshotCapture: { captureSnapshot: vi.fn(() => ({ id: "snap-1" })), db } as unknown as SnapshotCapture,
    }).teardown(downed);
    const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    await reconciler.reconcile(crashed);

    expect(seatStatuses(downed)).toEqual(["exited", "exited"]);
    expect(seatStatuses(crashed)).toEqual(["detached", "detached"]);
    // The software-team-level projection cannot tell them apart, which is why the CLI reads the seats.
    expect(softwareTeamLifecycle(downed)).toBe(softwareTeamLifecycle(crashed));
  });

  it("a later boot reconcile does not turn a downed softwareTeam's exited seats into detached", async () => {
    const downed = seedRunningSoftwareTeam("downed");
    const tmux = goneTmux();
    await new SoftwareTeamTeardownOrchestrator({
      db, softwareTeamRepo, sessionRegistry, tmuxAdapter: tmux, eventBus,
      snapshotCapture: { captureSnapshot: vi.fn(() => ({ id: "snap-1" })), db } as unknown as SnapshotCapture,
    }).teardown(downed);

    const result = await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).reconcile(downed);

    expect(result.detached).toBe(0);
    expect(seatStatuses(downed)).toEqual(["exited", "exited"]);
  });
});
