import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import type { TmuxOptionDefaultsApplier } from "../src/domain/tmux-option-defaults.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmuxAdapter(overrides?: {
  createSession?: (name: string, cwd?: string, env?: Record<string, string>) => Promise<TmuxResult>;
  killSession?: (name: string) => Promise<TmuxResult>;
  listPanes?: (target: string) => Promise<Array<{ id: string }>>;
}): TmuxAdapter {
  return {
    createSession: overrides?.createSession ?? (async () => ({ ok: true as const })),
    killSession: overrides?.killSession ?? (async () => ({ ok: true as const })),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: overrides?.listPanes ?? (async () => []),
    hasSession: async () => false,
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

describe("NodeLauncher", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = setupDb();
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function createLauncher(
    tmux?: TmuxAdapter,
    sessionEnv?: Record<string, string | undefined>,
    tmuxOptionDefaults?: TmuxOptionDefaultsApplier,
  ) {
    return new NodeLauncher({
      db,
      softwareTeamRepo,
      sessionRegistry,
      eventBus,
      tmuxAdapter: tmux ?? mockTmuxAdapter(),
      sessionEnv,
      tmuxOptionDefaults,
    });
  }

  function seedSoftwareTeamWithNode() {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev1-impl", {
      role: "worker",
      runtime: "claude-code",
    });
    return { softwareTeam, node };
  }

  it("a missing pane at registration immediately projects attention", async () => {
    const { softwareTeam } = seedSoftwareTeamWithNode();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // SQLite keeps its real clock; freeze registration safely after that floor.
      vi.setSystemTime(Date.now() + 60_000);
      const result = await createLauncher().launchNode(softwareTeam.id, "dev1-impl");
      expect(result.ok).toBe(true);
      expect(getNodeInventory(db, softwareTeam.id)[0]).toMatchObject({
        startupStatus: "attention_required", identityVerdict: { verdict: "pane_missing", reason: "pane_pid_gone" },
      });
    } finally { vi.useRealTimers(); }
  });

  it("happy path: derives name, creates tmux, persists session+binding+event in one txn, notifies", async () => {
    const { softwareTeam, node } = seedSoftwareTeamWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));

    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const result = await launcher.launchNode(softwareTeam.id, "dev1-impl");

    expect(result.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledOnce();

    // DB: session exists
    const sessions = sessionRegistry.getSessionsForSoftwareTeam(softwareTeam.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe("running");

    // DB: binding exists
    const fullSoftwareTeam = softwareTeamRepo.getSoftwareTeam(softwareTeam.id);
    const launchedNode = fullSoftwareTeam!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(launchedNode!.binding).not.toBeNull();

    // DB: event exists
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(events).toHaveLength(1);

    // Subscriber notified
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("node.launched");
  });

  it("adds runtime-scoped launch env (OMP provider keys) to that runtime's seats only", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r02");
    softwareTeamRepo.addNode(softwareTeam.id, "omp-worker", { role: "worker", runtime: "omp" });
    softwareTeamRepo.addNode(softwareTeam.id, "claude-worker", { role: "worker", runtime: "claude-code" });
    const envs: Record<string, Record<string, string> | undefined> = {};
    const launcher = new NodeLauncher({
      db, softwareTeamRepo, sessionRegistry, eventBus,
      tmuxAdapter: mockTmuxAdapter({ createSession: async (name, _cwd, env) => { envs[name] = env; return { ok: true }; } }),
      sessionEnv: { SOFTWARETEAM_HOME: "/home" },
      runtimeSessionEnv: { omp: { MISTRAL_API_KEY: "omp-only" } },
    });
    const omp = await launcher.launchNode(softwareTeam.id, "omp-worker");
    const claude = await launcher.launchNode(softwareTeam.id, "claude-worker");
    expect(omp.ok && claude.ok).toBe(true);
    if (!omp.ok || !claude.ok) return;
    expect(envs[omp.sessionName]).toMatchObject({ SOFTWARETEAM_HOME: "/home", MISTRAL_API_KEY: "omp-only" });
    expect(envs[claude.sessionName]).toMatchObject({ SOFTWARETEAM_HOME: "/home" });
    expect(envs[claude.sessionName]).not.toHaveProperty("MISTRAL_API_KEY");
  });

  it("launchNode commits the created session's sole live pane with its session and binding", async () => {
    const { softwareTeam, node } = seedSoftwareTeamWithNode();
    const listPanes = vi.fn(async () => [{ id: "%fresh" }]);
    const launcher = createLauncher(mockTmuxAdapter({ listPanes }));

    const result = await launcher.launchNode(softwareTeam.id, "dev1-impl", { occupantKind: "fresh" });

    expect(result.ok).toBe(true);
    expect(listPanes).toHaveBeenCalledWith(result.ok ? result.sessionName : "");
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%fresh");
    expect(sessionRegistry.currentOccupantTenure(node.id)?.kind).toBe("fresh");
  });

  it("derived session name is correct (softwareTeam.name + '-' + logicalId)", async () => {
    const { softwareTeam } = seedSoftwareTeamWithNode();
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    await launcher.launchNode(softwareTeam.id, "dev1-impl");

    expect(createSpy.mock.calls[0]![0]).toBe("r01-dev1-impl");
  });

  it("passes runtime hook env to tmux session creation without putting it in provider config", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    softwareTeamRepo.addNode(softwareTeam.id, "dev-qa", {
      role: "worker",
      runtime: "codex",
    });
    const createSpy = vi.fn<(name: string, cwd?: string, env?: Record<string, string>) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }), {
      SOFTWARETEAM_URL: "http://127.0.0.1:7644",
      SOFTWARETEAM_ACTIVITY_HOOK_TOKEN: "secret-token",
    });

    await launcher.launchNode(softwareTeam.id, "dev-qa");

    expect(createSpy.mock.calls[0]![2]).toEqual({
      SOFTWARETEAM_NODE_ID: expect.any(String),
      SOFTWARETEAM_SESSION_NAME: "r00-test-software-team-dev-qa",
      SOFTWARETEAM_RUNTIME: "codex",
      SOFTWARETEAM_OCCUPANT_GENERATION: expect.any(String),
      SOFTWARETEAM_URL: "http://127.0.0.1:7644",
      SOFTWARETEAM_ACTIVITY_HOOK_TOKEN: "secret-token",
    });
  });

  it("carries the exact prelaunch reservation into tmux and registers that same generation", async () => {
    const { softwareTeam, node } = seedSoftwareTeamWithNode();
    let launchEnv: Record<string, string> | undefined;
    const launcher = createLauncher(
      mockTmuxAdapter({
        createSession: async (_name, _cwd, env) => {
          launchEnv = env;
          return { ok: true };
        },
      }),
      { SOFTWARETEAM_OCCUPANT_GENERATION: "stale-ambient-generation" },
    );

    const result = await launcher.launchNode(softwareTeam.id, "dev1-impl");

    expect(result.ok).toBe(true);
    expect(launchEnv?.SOFTWARETEAM_OCCUPANT_GENERATION).toMatch(/^[0-9a-f-]{36}$/i);
    expect(launchEnv?.SOFTWARETEAM_OCCUPANT_GENERATION).not.toBe("stale-ambient-generation");
    expect(sessionRegistry.currentOccupantTenure(node.id)?.generationUuid)
      .toBe(launchEnv?.SOFTWARETEAM_OCCUPANT_GENERATION);
  });

  it("keeps launch fail-open and omits generation when the tenure ledger is unavailable", async () => {
    const { softwareTeam } = seedSoftwareTeamWithNode();
    db.exec("DROP TABLE occupant_tenures");
    let launchEnv: Record<string, string> | undefined;
    const launcher = createLauncher(mockTmuxAdapter({
      createSession: async (_name, _cwd, env) => {
        launchEnv = env;
        return { ok: true };
      },
    }));

    const result = await launcher.launchNode(softwareTeam.id, "dev1-impl");

    expect(result.ok).toBe(true);
    expect(launchEnv).not.toHaveProperty("SOFTWARETEAM_OCCUPANT_GENERATION");
    expect(sessionRegistry.getSessionsForSoftwareTeam(softwareTeam.id)).toHaveLength(1);
  });

  it("explicit sessionName override used when provided", async () => {
    const { softwareTeam } = seedSoftwareTeamWithNode();
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    await launcher.launchNode(softwareTeam.id, "dev1-impl", { sessionName: "r99-custom1-worker" });

    expect(createSpy.mock.calls[0]![0]).toBe("r99-custom1-worker");
  });

  it("valid logical IDs 'orchestrator' and 'worker' produce launchable names", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    softwareTeamRepo.addNode(softwareTeam.id, "orchestrator", { role: "orchestrator" });
    softwareTeamRepo.addNode(softwareTeam.id, "worker", { role: "worker" });
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const r1 = await launcher.launchNode(softwareTeam.id, "orchestrator");
    const r2 = await launcher.launchNode(softwareTeam.id, "worker");

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(createSpy.mock.calls[0]![0]).toBe("r01-orchestrator");
    expect(createSpy.mock.calls[1]![0]).toBe("r01-worker");
  });

  it("non-managed SoftwareTeam name is normalized to a managed session name", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("badname");
    softwareTeamRepo.addNode(softwareTeam.id, "worker");
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const result = await launcher.launchNode(softwareTeam.id, "worker");

    expect(result.ok).toBe(true);
    expect(createSpy.mock.calls[0]![0]).toBe("r00-badname-worker");
  });

  it("node not found -> error", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r01");
    const launcher = createLauncher();

    const result = await launcher.launchNode(softwareTeam.id, "nonexistent");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("node_not_found");
    }
  });

  it("node already bound -> error", async () => {
    const { softwareTeam, node } = seedSoftwareTeamWithNode();
    // Pre-bind the node
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl" });
    const launcher = createLauncher();

    const result = await launcher.launchNode(softwareTeam.id, "dev1-impl");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("already_bound");
    }
  });

  it("tmux createSession fails -> no DB rows", async () => {
    const { softwareTeam } = seedSoftwareTeamWithNode();
    const killSpy = vi.fn(async () => ({ ok: true as const }));
    const launcher = createLauncher(
      mockTmuxAdapter({
        createSession: async () => ({
          ok: false as const,
          code: "duplicate_session",
          message: "duplicate session",
        }),
        killSession: killSpy,
      })
    );

    const result = await launcher.launchNode(softwareTeam.id, "dev1-impl");

    expect(result.ok).toBe(false);

    // No session/binding/event rows
    const sessions = sessionRegistry.getSessionsForSoftwareTeam(softwareTeam.id);
    expect(sessions).toHaveLength(0);
    const fullSoftwareTeam = softwareTeamRepo.getSoftwareTeam(softwareTeam.id);
    const node = fullSoftwareTeam!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(node!.binding).toBeNull();
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(events).toHaveLength(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("DB transaction fails after session+binding but before event -> rollback all, killSession attempted", async () => {
    const { softwareTeam } = seedSoftwareTeamWithNode();
    const killSpy = vi.fn<(name: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });

    // Sabotage the events table so persistWithinTransaction fails AFTER
    // session + binding inserts have already executed within the transaction.
    // This proves rollback removes the session and binding rows too.
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, software_team_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    const launcher = createLauncher(
      mockTmuxAdapter({
        createSession: async () => ({ ok: true as const }),
        killSession: killSpy,
      })
    );

    const result = await launcher.launchNode(softwareTeam.id, "dev1-impl");

    expect(result.ok).toBe(false);
    // killSession was attempted (tmux cleanup)
    expect(killSpy).toHaveBeenCalledOnce();
    // No partial session rows (rolled back)
    const sessions = db.prepare("SELECT * FROM sessions").all();
    expect(sessions).toHaveLength(0);
    // No partial binding rows (rolled back)
    const bindings = db.prepare("SELECT * FROM bindings").all();
    expect(bindings).toHaveLength(0);
    // No event rows (insert failed)
    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });

  it("event row exists in DB after launch (atomic with session+binding)", async () => {
    const { softwareTeam } = seedSoftwareTeamWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(softwareTeam.id, "dev1-impl");

    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched' AND software_team_id = ?")
      .all(softwareTeam.id) as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.type).toBe("node.launched");
    expect(payload.softwareTeamId).toBe(softwareTeam.id);
    expect(payload.logicalId).toBe("dev1-impl");
  });

  it("emitted event has correct softwareTeamId, nodeId, logicalId, sessionName", async () => {
    const { softwareTeam, node } = seedSoftwareTeamWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));
    const launcher = createLauncher();

    await launcher.launchNode(softwareTeam.id, "dev1-impl");

    expect(notifications).toHaveLength(1);
    const event = notifications[0]!;
    expect(event.type).toBe("node.launched");
    if (event.type === "node.launched") {
      expect(event.softwareTeamId).toBe(softwareTeam.id);
      expect(event.nodeId).toBe(node.id);
      expect(event.logicalId).toBe("dev1-impl");
      expect(event.sessionName).toBe("r01-dev1-impl");
    }
  });

  it("after launch, getSoftwareTeam shows binding for node", async () => {
    const { softwareTeam } = seedSoftwareTeamWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(softwareTeam.id, "dev1-impl");

    const fullSoftwareTeam = softwareTeamRepo.getSoftwareTeam(softwareTeam.id);
    const node = fullSoftwareTeam!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(node!.binding).not.toBeNull();
    expect(node!.binding!.tmuxSession).toBe("r01-dev1-impl");
  });

  it("after launch, getSessionsForSoftwareTeam shows session with correct name", async () => {
    const { softwareTeam } = seedSoftwareTeamWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(softwareTeam.id, "dev1-impl");

    const sessions = sessionRegistry.getSessionsForSoftwareTeam(softwareTeam.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionName).toBe("r01-dev1-impl");
  });

  it("returns the newly created session when older sessions already exist for the node", async () => {
    const { softwareTeam, node } = seedSoftwareTeamWithNode();
    const older = sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateStatus(older.id, "exited");

    const launcher = createLauncher();
    const result = await launcher.launchNode(softwareTeam.id, "dev1-impl");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.session.id).not.toBe(older.id);
    expect(result.session.status).toBe("running");

    const sessions = sessionRegistry.getSessionsForSoftwareTeam(softwareTeam.id).filter((s) => s.nodeId === node.id);
    const newest = sessions.reduce((latest, session) => (session.id > latest.id ? session : latest));
    expect(result.session.id).toBe(newest.id);
  });

  it("exactly 1 event row and exactly 1 subscriber notification (no duplication)", async () => {
    const { softwareTeam } = seedSoftwareTeamWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));
    const launcher = createLauncher();

    await launcher.launchNode(softwareTeam.id, "dev1-impl");

    // Exactly 1 DB row
    const eventRows = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(eventRows).toHaveLength(1);

    // Exactly 1 subscriber notification
    expect(notifications).toHaveLength(1);
  });

  it("canonical session name with @ accepted when passed as opts.sessionName", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("auth-feats");
    softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const result = await launcher.launchNode(softwareTeam.id, "dev.impl", {
      sessionName: "dev-impl@auth-feats",
    });

    expect(result.ok).toBe(true);
    expect(createSpy.mock.calls[0]![0]).toBe("dev-impl@auth-feats");

    // Session persisted with canonical name
    const sessions = sessionRegistry.getSessionsForSoftwareTeam(softwareTeam.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionName).toBe("dev-impl@auth-feats");
  });

  it("constructor throws if services use mismatched db handles", () => {
    const otherDb = createDb();
    migrate(otherDb, [coreSchema, bindingsSessionsSchema, eventsSchema]);
    const otherRepo = new SoftwareTeamRepository(otherDb);

    expect(
      () =>
        new NodeLauncher({
          db,
          softwareTeamRepo: otherRepo, // different handle
          sessionRegistry,
          eventBus,
          tmuxAdapter: mockTmuxAdapter(),
        })
    ).toThrow(/same db handle/);

    otherDb.close();
  });

  describe("transcript integration", () => {
    it("starts the transcript rotation timer on successful launch when TranscriptStore is enabled", async () => {
      const {
        getActiveRotationCount,
        clearAllTranscriptRotationsForTest,
      } = await import("../src/domain/transcript-rotation.js");
      clearAllTranscriptRotationsForTest();
      const { softwareTeam } = seedSoftwareTeamWithNode();
      const tmux = mockTmuxAdapter({
        createSession: async () => ({ ok: true as const }),
      });

      const { TranscriptStore } = await import("../src/domain/transcript-store.js");
      const transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/test-transcripts", enabled: true });
      vi.spyOn(transcriptStore, "ensureTranscriptDir").mockReturnValue(true);

      const launcher = new NodeLauncher({
        db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, transcriptStore,
      });

      const result = await launcher.launchNode(softwareTeam.id, "dev1-impl");
      expect(result.ok).toBe(true);
      // Rotation timer registered for the launched session.
      expect(getActiveRotationCount()).toBeGreaterThan(0);
      if (result.ok) {
        expect(result.warnings).toBeUndefined();
      }
      clearAllTranscriptRotationsForTest();
    });

    it("warns and still succeeds when the transcript directory cannot be created", async () => {
      const { softwareTeam } = seedSoftwareTeamWithNode();
      const tmux = mockTmuxAdapter({
        createSession: async () => ({ ok: true as const }),
      });

      const { TranscriptStore } = await import("../src/domain/transcript-store.js");
      const transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/test-transcripts", enabled: true });
      vi.spyOn(transcriptStore, "ensureTranscriptDir").mockReturnValue(false);

      const launcher = new NodeLauncher({
        db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, transcriptStore,
      });

      const result = await launcher.launchNode(softwareTeam.id, "dev1-impl");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.warnings).toBeDefined();
        expect(result.warnings!.length).toBe(1);
        expect(result.warnings![0]).toContain("Transcript directory creation failed");
      }
    });
  });

  describe("env var projection", () => {
    it("passes SOFTWARETEAM_NODE_ID and SOFTWARETEAM_SESSION_NAME to createSession", async () => {
      const { softwareTeam, node } = seedSoftwareTeamWithNode();
      const createSpy = vi.fn<(name: string, cwd?: string, env?: Record<string, string>) => Promise<TmuxResult>>()
        .mockResolvedValue({ ok: true });
      const tmux = mockTmuxAdapter({ createSession: createSpy });
      const launcher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });

      const result = await launcher.launchNode(softwareTeam.id, "dev1-impl");
      expect(result.ok).toBe(true);
      expect(createSpy).toHaveBeenCalledOnce();

      const envArg = createSpy.mock.calls[0]![2];
      expect(envArg).toBeDefined();
      expect(envArg!.SOFTWARETEAM_NODE_ID).toBe(node.id);
      expect(envArg!.SOFTWARETEAM_SESSION_NAME).toContain("dev1-impl");
    });
  });

  // OPR.0.4.6.02 S1 — the shared tmux option-defaults applier is invoked on the
  // JUST-CREATED session, and its warnings fold into the launch result.
  describe("tmux option defaults (OPR.0.4.6.02 S1)", () => {
    it("applies option defaults to the created session and folds applier warnings", async () => {
      const { softwareTeam } = seedSoftwareTeamWithNode();
      const applyToFreshSession = vi.fn(async () => ['tmux "mouse" option not set for r01-dev1-impl: boom']);
      const applier = { applyToFreshSession } as unknown as TmuxOptionDefaultsApplier;

      const result = await createLauncher(undefined, undefined, applier).launchNode(softwareTeam.id, "dev1-impl");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      // Applied exactly once, to the just-created session name (never a pre-existing one).
      expect(applyToFreshSession).toHaveBeenCalledTimes(1);
      expect(applyToFreshSession).toHaveBeenCalledWith(result.sessionName);
      // The applier's non-fatal warnings ride the launch result.
      expect(result.warnings).toContain('tmux "mouse" option not set for r01-dev1-impl: boom');
    });

    it("folds the session's own non-fatal warnings (the #771 identity cleanup) into the launch result", async () => {
      const { softwareTeam } = seedSoftwareTeamWithNode();
      const createSession = vi.fn(async () => ({ ok: true as const, warnings: ["identity cleanup skipped: boom"] }));
      const result = await createLauncher(mockTmuxAdapter({ createSession })).launchNode(softwareTeam.id, "dev1-impl");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.warnings).toContain("identity cleanup skipped: boom");
    });

    it("without an applier injected, launch succeeds and applies nothing (existing-behavior safety)", async () => {
      const { softwareTeam } = seedSoftwareTeamWithNode();
      const result = await createLauncher().launchNode(softwareTeam.id, "dev1-impl");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.warnings).toBeUndefined();
    });
  });

});
