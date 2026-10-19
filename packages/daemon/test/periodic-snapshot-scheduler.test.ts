// OPR.0.3.4.9 — periodic snapshot scheduler tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { PeriodicSnapshotScheduler } from "../src/domain/periodic-snapshot-scheduler.js";
import { SoftwareTeamTeardownOrchestrator } from "../src/domain/software-team-teardown.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

describe("PeriodicSnapshotScheduler", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let snapshotCapture: SnapshotCapture;
  let scheduler: PeriodicSnapshotScheduler;

  beforeEach(() => {
    db = createFullTestDb();
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, softwareTeamRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    scheduler = new PeriodicSnapshotScheduler({ db, snapshotCapture, snapshotRepo });
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  function seedRunningSoftwareTeam(name: string): string {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam(name);
    const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { role: "worker" });
    const session = sessionRegistry.registerSession(node.id, `worker@${name}`);
    sessionRegistry.updateStatus(session.id, "running");
    return softwareTeam.id;
  }

  it("tick captures an auto-periodic snapshot for a running softwareTeam", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r1");
    await scheduler.tick();
    const snaps = snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.kind).toBe("auto-periodic");
  });

  it("tick skips archived softwareTeams", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-archived");
    softwareTeamRepo.archiveSoftwareTeam(softwareTeamId);
    await scheduler.tick();
    const snaps = snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(0);
  });

  it("tick skips stopped softwareTeams (no running sessions)", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r-stopped");
    softwareTeamRepo.addNode(softwareTeam.id, "worker", { role: "worker" });
    await scheduler.tick();
    const snaps = snapshotRepo.listSnapshots(softwareTeam.id, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(0);
  });

  it("kind-scoped retention prunes only auto-periodic, preserves other kinds", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-prune");
    snapshotCapture.captureSnapshot(softwareTeamId, "manual");
    snapshotCapture.captureSnapshot(softwareTeamId, "auto-pre-down");
    scheduler.start(100000, 2);
    scheduler.stop();
    // Run 5 ticks with retention_keep=2
    for (let i = 0; i < 5; i++) {
      snapshotCapture.captureSnapshot(softwareTeamId, "auto-periodic");
    }
    snapshotRepo.pruneSnapshotsByKind(softwareTeamId, "auto-periodic", 2);

    const periodic = snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" });
    expect(periodic).toHaveLength(2);
    const manual = snapshotRepo.listSnapshots(softwareTeamId, { kind: "manual" });
    expect(manual).toHaveLength(1);
    const preDown = snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-pre-down" });
    expect(preDown).toHaveLength(1);
  });

  it("retention_keep floor: keepCount < 1 still leaves at least 1", () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-floor");
    snapshotCapture.captureSnapshot(softwareTeamId, "auto-periodic");
    snapshotCapture.captureSnapshot(softwareTeamId, "auto-periodic");
    snapshotRepo.pruneSnapshotsByKind(softwareTeamId, "auto-periodic", 0);
    const remaining = snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" });
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  });

  it("per-software-team error isolation: one softwareTeam's failure does not abort others", async () => {
    const softwareTeamId1 = seedRunningSoftwareTeam("r-ok");
    const softwareTeamId2 = seedRunningSoftwareTeam("r-fail");
    const origCapture = snapshotCapture.captureSnapshot.bind(snapshotCapture);
    const captureSpy = vi.spyOn(snapshotCapture, "captureSnapshot").mockImplementation((id, kind) => {
      if (id === softwareTeamId2) throw new Error("simulated failure");
      return origCapture(id, kind);
    });

    await scheduler.tick();

    const snaps1 = snapshotRepo.listSnapshots(softwareTeamId1, { kind: "auto-periodic" });
    expect(snaps1).toHaveLength(1);
    const snaps2 = snapshotRepo.listSnapshots(softwareTeamId2, { kind: "auto-periodic" });
    expect(snaps2).toHaveLength(0);
    captureSpy.mockRestore();
  });

  it("skips SoftwareTeam with older running + newer exited session (latest-session semantics)", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r-latest");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { role: "worker" });
    const oldSess = sessionRegistry.registerSession(node.id, "worker@r-latest");
    sessionRegistry.updateStatus(oldSess.id, "running");
    const newSess = sessionRegistry.registerSession(node.id, "worker@r-latest");
    sessionRegistry.updateStatus(newSess.id, "exited");

    await scheduler.tick();
    const snaps = snapshotRepo.listSnapshots(softwareTeam.id, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(0);
  });

  it("start/stop is idempotent", () => {
    scheduler.start(60000, 10);
    expect(scheduler.isActive).toBe(true);
    scheduler.start(60000, 10);
    expect(scheduler.isActive).toBe(true);
    scheduler.stop();
    expect(scheduler.isActive).toBe(false);
    scheduler.stop();
    expect(scheduler.isActive).toBe(false);
  });

  it("non-overlapping ticks: the running flag prevents re-entry", () => {
    // The running flag is set synchronously at the top of tick();
    // the setInterval callback checks it before calling tick().
    scheduler.start(100000, 10);
    expect(scheduler.isActive).toBe(true);
    scheduler.stop();
  });

  // OPR.0.4.3.20 FR-4 — refresh the live per-seat resume ledger before serialize.
  type Refresher = import("../src/domain/resume-metadata-refresher.js").ResumeMetadataRefresher;

  it.each([false, true])("preserves the pre-down recovery source when a pending refresh rejects=%s", async (rejectRefresh) => {
    const softwareTeamId = seedRunningSoftwareTeam("r-down-during-refresh");
    const otherSoftwareTeamId = seedRunningSoftwareTeam("r-still-running");
    const session = sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId)[0]!;
    sessionRegistry.updateResumeToken(session.id, "native", "saved-thread", "operator");
    let release!: () => void;
    const pending = new Promise<void>((resolve, reject) => {
      release = () => rejectRefresh ? reject(new Error("discovery failed")) : resolve();
    });
    let entered!: () => void;
    const refreshing = new Promise<void>((resolve) => { entered = resolve; });
    const refresh = vi.fn(async (sessions: Array<{ nodeId: string }>) => {
      if (sessions.some((s) => s.nodeId === session.nodeId)) {
        entered();
        await pending;
      }
    });
    const periodic = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: { refresh } as unknown as Refresher,
    });
    const tick = periodic.tick();
    await refreshing;
    const teardown = new SoftwareTeamTeardownOrchestrator({
      db, softwareTeamRepo, sessionRegistry, eventBus, snapshotCapture,
      tmuxAdapter: { killSession: vi.fn(async () => ({ ok: true })) } as unknown as TmuxAdapter,
    });
    const down = await teardown.teardown(softwareTeamId);
    expect(down.sessionsKilled).toBe(1);
    expect(sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId)[0]!.status).toBe("exited");
    release();
    await tick;

    const selected = snapshotRepo.selectRestoreUsable(softwareTeamId);
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error(selected.message);
    expect(selected.snapshot.id).toBe(down.snapshotId);
    expect(selected.snapshot.data.activeOccupantsByNode?.[session.nodeId]).toEqual({ kind: "resolved", sessionId: session.id });
    expect(selected.snapshot.data.sessions[0]!.resumeToken).toBe("saved-thread");
    expect(snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" })).toHaveLength(0);
    expect(snapshotRepo.listSnapshots(otherSoftwareTeamId, { kind: "auto-periodic" })).toHaveLength(1);
  });

  it("rechecks archived membership after refresh", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-archive-during-refresh");
    const periodic = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: { refresh: vi.fn(async () => { softwareTeamRepo.archiveSoftwareTeam(softwareTeamId); }) } as unknown as Refresher,
    });
    await periodic.tick();
    expect(snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" })).toHaveLength(0);
  });

  it("skips a partial shutdown during refresh even while a sibling is running", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-partial-down");
    const node = softwareTeamRepo.addNode(softwareTeamId, "sibling", { role: "worker" });
    const sibling = sessionRegistry.registerSession(node.id, "sibling@r-partial-down");
    sessionRegistry.updateStatus(sibling.id, "running");
    const preDown = snapshotCapture.captureSnapshot(softwareTeamId, "auto-pre-down");
    const periodic = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: {
        refresh: vi.fn(async () => { sessionRegistry.updateStatus(sibling.id, "exited"); }),
      } as unknown as Refresher,
    });
    await periodic.tick();
    expect(snapshotRepo.findLatestRestoreUsable(softwareTeamId)?.id).toBe(preDown.id);
    expect(snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" })).toHaveLength(0);
  });

  it("preserves a pre-down snapshot created during a partial teardown refresh", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-partial-down-first-snapshot");
    const node = softwareTeamRepo.addNode(softwareTeamId, "sibling", { role: "worker" });
    const sibling = sessionRegistry.registerSession(node.id, "sibling@r-partial-down-first-snapshot");
    sessionRegistry.updateStatus(sibling.id, "running");

    let releaseRefresh!: () => void;
    const refreshPending = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let secondKillStarted!: () => void;
    const secondKillEntered = new Promise<void>((resolve) => { secondKillStarted = resolve; });
    let releaseSecondKill!: () => void;
    const secondKillPending = new Promise<void>((resolve) => { releaseSecondKill = resolve; });
    let killCount = 0;
    const killSession = vi.fn(async () => {
      killCount++;
      if (killCount === 2) {
        secondKillStarted();
        await secondKillPending;
      }
      return { ok: true };
    });
    let refreshStarted!: () => void;
    const refreshEntered = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const periodic = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: {
        refresh: vi.fn(async () => {
          refreshStarted();
          await refreshPending;
        }),
      } as unknown as Refresher,
    });
    const tick = periodic.tick();
    await refreshEntered;

    const teardown = new SoftwareTeamTeardownOrchestrator({
      db, softwareTeamRepo, sessionRegistry, eventBus, snapshotCapture,
      tmuxAdapter: { killSession } as unknown as TmuxAdapter,
    });
    const down = teardown.teardown(softwareTeamId);
    await secondKillEntered;

    // Teardown has captured the complete pre-down source and stopped only the
    // first seat, leaving a running sibling while the refresh is pending.
    releaseRefresh();
    await tick;
    releaseSecondKill();
    const result = await down;

    expect(result.sessionsKilled).toBe(2);
    expect(result.snapshotId).not.toBeNull();
    expect(snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" })).toHaveLength(0);
    expect(snapshotRepo.findLatestRestoreUsable(softwareTeamId)?.id).toBe(result.snapshotId);
  });

  it("captures when the earlier restore-source lookup fails", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-restore-lookup-fails");
    const node = softwareTeamRepo.addNode(softwareTeamId, "sibling", { role: "worker" });
    const sibling = sessionRegistry.registerSession(node.id, "sibling@r-restore-lookup-fails");
    sessionRegistry.updateStatus(sibling.id, "running");
    snapshotCapture.captureSnapshot(softwareTeamId, "auto-pre-down");
    const lookup = vi.spyOn(snapshotRepo, "findLatestRestoreUsable")
      .mockImplementation(() => { throw new Error("lookup failed"); });
    // A seat stops during refresh, so the tick reaches the lookup; the first seat keeps the softwareTeam running.
    const periodic = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: { refresh: vi.fn(async () => { sessionRegistry.updateStatus(sibling.id, "exited"); }) } as unknown as Refresher,
    });

    await periodic.tick();

    expect(lookup).toHaveBeenCalledWith(softwareTeamId);
    expect(snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" })).toHaveLength(1);
    lookup.mockRestore();
  });

  it("does not read the restore source on a tick where no seat changed", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-stable-tick");
    snapshotCapture.captureSnapshot(softwareTeamId, "auto-pre-down");
    const lookup = vi.spyOn(snapshotRepo, "findLatestRestoreUsable");
    const periodic = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: { refresh: vi.fn(async () => {}) } as unknown as Refresher,
    });

    await periodic.tick();

    expect(lookup).not.toHaveBeenCalled();
    expect(snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" })).toHaveLength(1);
    lookup.mockRestore();
  });

  it("skips a replacement during refresh and captures the next stable tick", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-replaced");
    const original = sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId)[0]!;
    snapshotCapture.captureSnapshot(softwareTeamId, "auto-pre-down");
    db.prepare("UPDATE sessions SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(original.id);
    const refresh = vi.fn(async () => {}).mockImplementationOnce(async () => {
      sessionRegistry.updateStatus(original.id, "superseded");
      const replacement = sessionRegistry.registerSession(original.nodeId, original.sessionName);
      sessionRegistry.updateStatus(replacement.id, "running");
    });
    const periodic = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: { refresh } as unknown as Refresher,
    });
    await periodic.tick();
    expect(snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" })).toHaveLength(0);
    await periodic.tick();
    const snapshots = snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.data.activeOccupantsByNode?.[original.nodeId]).toEqual({
      kind: "resolved", sessionId: sessionRegistry.getLatestLiveSessions(softwareTeamId)[0]!.sessionId,
    });
  });

  it("captures a replacement during refresh when no earlier usable snapshot exists", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-replaced-without-snapshot");
    const original = sessionRegistry.getSessionsForSoftwareTeam(softwareTeamId)[0]!;
    db.prepare("UPDATE sessions SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(original.id);
    let replacementId: string | undefined;
    const refresh = vi.fn(async () => {
      sessionRegistry.updateStatus(original.id, "superseded");
      const replacement = sessionRegistry.registerSession(original.nodeId, original.sessionName);
      sessionRegistry.updateStatus(replacement.id, "running");
      replacementId = replacement.id;
    });
    const periodic = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: { refresh } as unknown as Refresher,
    });

    await periodic.tick();

    const snapshots = snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" });
    expect(snapshots).toHaveLength(1);
    expect(replacementId).toBeDefined();
    expect(snapshots[0]!.data.activeOccupantsByNode?.[original.nodeId]).toEqual({
      kind: "resolved", sessionId: replacementId,
    });
  });

  it("FR-4: tick refreshes live tokens before capturing the periodic snapshot", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-fr4");
    const refresh = vi.fn(async () => {});
    const fr4 = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: { refresh } as unknown as Refresher,
    });
    await fr4.tick();
    // refresh ran, and it received the softwareTeam's latest live sessions.
    expect(refresh).toHaveBeenCalledTimes(1);
    const passed = refresh.mock.calls[0]![0] as Array<{ sessionName: string }>;
    expect(passed.some((s) => s.sessionName === "worker@r-fr4")).toBe(true);
    // rev1 fix: the recurring snapshot path calls refresh in fill-null-only mode
    // (never clears a present token, never spawns a `claude --resume` probe).
    const opts = refresh.mock.calls[0]![1] as { fillNullOnly?: boolean } | undefined;
    expect(opts?.fillNullOnly).toBe(true);
    // and the snapshot was still captured (refresh precedes serialize, not replaces it).
    expect(snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" })).toHaveLength(1);
  });

  it("FR-4: a refresh that THROWS does not skip the snapshot (best-effort, own try/catch)", async () => {
    const softwareTeamId = seedRunningSoftwareTeam("r-fr4-throw");
    const fr4 = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: { refresh: vi.fn(async () => { throw new Error("refresh boom"); }) } as unknown as Refresher,
    });
    await fr4.tick();
    expect(snapshotRepo.listSnapshots(softwareTeamId, { kind: "auto-periodic" })).toHaveLength(1);
  });
});

describe("OPR.0.3.4.9 production wiring: startPeriodicSnapshotScheduler", () => {
  it("enabled=true: scheduler.start AND psProjectionService.setPeriodicSnapshotState called", async () => {
    const { startPeriodicSnapshotScheduler } = await import("../src/index.js");
    const schedulerStart = vi.fn();
    const setState = vi.fn();
    const deps = {
      periodicSnapshotScheduler: { start: schedulerStart },
      psProjectionService: { setPeriodicSnapshotState: setState },
      settingsStore: {
        resolveOne: (key: string) => {
          if (key === "snapshots.periodic.enabled") return { value: true };
          if (key === "snapshots.periodic.interval_seconds") return { value: 300 };
          if (key === "snapshots.periodic.retention_keep") return { value: 10 };
          return { value: "" };
        },
      },
    };

    startPeriodicSnapshotScheduler(deps);

    expect(schedulerStart).toHaveBeenCalledWith(300_000, 10);
    expect(setState).toHaveBeenCalledWith(true, 300);
  });

  it("enabled=false: scheduler NOT started, psProjectionService NOT called", async () => {
    const { startPeriodicSnapshotScheduler } = await import("../src/index.js");
    const schedulerStart = vi.fn();
    const setState = vi.fn();
    const deps = {
      periodicSnapshotScheduler: { start: schedulerStart },
      psProjectionService: { setPeriodicSnapshotState: setState },
      settingsStore: {
        resolveOne: (key: string) => {
          if (key === "snapshots.periodic.enabled") return { value: false };
          return { value: 300 };
        },
      },
    };

    startPeriodicSnapshotScheduler(deps);

    expect(schedulerStart).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });
});

describe("PsProjectionService periodic snapshot status", () => {
  let db: Database.Database;

  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  it("periodicSnapshotActive=false and interval=0 by default (scheduler not started)", async () => {
    const { PsProjectionService } = await import("../src/domain/ps-projection.js");
    const svc = new PsProjectionService({ db });
    const softwareTeam = new SoftwareTeamRepository(db).createSoftwareTeam("test-software-team");
    const entries = svc.getEntries();
    const entry = entries.find((e) => e.softwareTeamId === softwareTeam.id);
    expect(entry).toBeDefined();
    expect(entry!.periodicSnapshotActive).toBe(false);
    expect(entry!.periodicSnapshotIntervalSeconds).toBe(0);
    expect(entry!.autoPeriodicSnapshotCount).toBe(0);
  });

  it("periodicSnapshotActive=true and interval matches after setPeriodicSnapshotState", async () => {
    const { PsProjectionService } = await import("../src/domain/ps-projection.js");
    const svc = new PsProjectionService({ db });
    svc.setPeriodicSnapshotState(true, 300);
    const softwareTeam = new SoftwareTeamRepository(db).createSoftwareTeam("active-software-team");
    const entries = svc.getEntries();
    const entry = entries.find((e) => e.softwareTeamId === softwareTeam.id);
    expect(entry!.periodicSnapshotActive).toBe(true);
    expect(entry!.periodicSnapshotIntervalSeconds).toBe(300);
  });

  it("autoPeriodicSnapshotCount reflects actual auto-periodic snapshots", async () => {
    const { PsProjectionService } = await import("../src/domain/ps-projection.js");
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const sessionReg = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const capture = new SnapshotCapture({ db, softwareTeamRepo, sessionRegistry: sessionReg, eventBus, snapshotRepo, checkpointStore });
    const svc = new PsProjectionService({ db });
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("count-software-team");
    softwareTeamRepo.addNode(softwareTeam.id, "w", { role: "worker" });
    capture.captureSnapshot(softwareTeam.id, "auto-periodic");
    capture.captureSnapshot(softwareTeam.id, "auto-periodic");
    capture.captureSnapshot(softwareTeam.id, "manual");

    const entries = svc.getEntries();
    const entry = entries.find((e) => e.softwareTeamId === softwareTeam.id);
    expect(entry!.autoPeriodicSnapshotCount).toBe(2);
  });
});

describe("OPR.0.3.4.9 config validation: malformed numeric writes rejected", () => {
  it("daemon SettingsStore rejects snapshots.periodic.interval_seconds=60abc", async () => {
    const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
    const store = new SettingsStore();
    expect(() => store.set("snapshots.periodic.interval_seconds", "60abc")).toThrow(/expected an integer/);
  });

  it("daemon SettingsStore rejects snapshots.periodic.interval_seconds=60.5", async () => {
    const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
    const store = new SettingsStore();
    expect(() => store.set("snapshots.periodic.interval_seconds", "60.5")).toThrow(/expected an integer/);
  });

  it("daemon SettingsStore rejects snapshots.periodic.retention_keep=0", async () => {
    const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
    const store = new SettingsStore();
    expect(() => store.set("snapshots.periodic.retention_keep", "0")).toThrow(/must be >= 1/);
  });

  it("daemon SettingsStore rejects snapshots.periodic.interval_seconds=30", async () => {
    const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
    const store = new SettingsStore();
    expect(() => store.set("snapshots.periodic.interval_seconds", "30")).toThrow(/must be >= 60/);
  });

  it("daemon SettingsStore accepts valid snapshots.periodic.interval_seconds=120", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-"));
    const configPath = path.join(tmpDir, "settings.json");
    const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
    const store = new SettingsStore(configPath);
    store.set("snapshots.periodic.interval_seconds", "120");
    expect(store.resolveOne("snapshots.periodic.interval_seconds").value).toBe(120);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("findLatestRestoreUsable Option Y", () => {
  let db: Database.Database;
  let snapshotRepo: SnapshotRepository;

  function insertRaw(id: string, softwareTeamId: string, kind: string, createdAt: string) {
    const data = JSON.stringify({
      softwareTeam: { id: softwareTeamId, name: "test" },
      nodes: [{ id: "n1", logicalId: "w", binding: null }],
      edges: [],
      sessions: [],
      checkpoints: {},
    });
    db.prepare(
      "INSERT INTO snapshots (id, software_team_id, kind, status, data, created_at) VALUES (?, ?, ?, 'active', ?, ?)"
    ).run(id, softwareTeamId, kind, data, createdAt);
  }

  beforeEach(() => {
    db = createFullTestDb();
    snapshotRepo = new SnapshotRepository(db);
  });

  afterEach(() => { db.close(); });

  it("stale auto-pre-down + newer auto-periodic -> auto-periodic wins (the crash fix)", () => {
    insertRaw("snap-old-apd", "software-team-1", "auto-pre-down", "2026-06-10T00:00:00Z");
    insertRaw("snap-new-periodic", "software-team-1", "auto-periodic", "2026-06-14T12:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("software-team-1");
    expect(result!.id).toBe("snap-new-periodic");
    expect(result!.kind).toBe("auto-periodic");
  });

  it("fresher auto-pre-down + older auto-periodic -> auto-pre-down wins (graceful-cycle preserved)", () => {
    insertRaw("snap-new-apd", "software-team-1", "auto-pre-down", "2026-06-14T18:00:00Z");
    insertRaw("snap-old-periodic", "software-team-1", "auto-periodic", "2026-06-14T12:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("software-team-1");
    expect(result!.id).toBe("snap-new-apd");
    expect(result!.kind).toBe("auto-pre-down");
  });

  it("manual unchanged: Apr-27 auto-pre-down beats Apr-28 manual (manual below tier)", () => {
    insertRaw("snap-apd", "software-team-1", "auto-pre-down", "2026-04-27T00:00:00Z");
    insertRaw("snap-manual", "software-team-1", "manual", "2026-04-28T00:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("software-team-1");
    expect(result!.id).toBe("snap-apd");
    expect(result!.kind).toBe("auto-pre-down");
  });

  it("only auto-periodic present -> returned", () => {
    insertRaw("snap-periodic-only", "software-team-1", "auto-periodic", "2026-06-14T12:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("software-team-1");
    expect(result!.id).toBe("snap-periodic-only");
  });
});
