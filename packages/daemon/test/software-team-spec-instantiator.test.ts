import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SoftwareTeamSpecPreflight } from "../src/domain/software-team-spec-preflight.js";
import { SoftwareTeamInstantiator } from "../src/domain/software-team-spec-instantiator.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { LegacySoftwareTeamSpec as SoftwareTeamSpec, PersistedEvent } from "../src/domain/types.js"; // TODO: AS-T08b — migrate to pod-aware SoftwareTeamSpec
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: vi.fn(async () => false),
  } as unknown as TmuxAdapter;
}

function validSpec(overrides?: Partial<SoftwareTeamSpec>): SoftwareTeamSpec {
  return {
    schemaVersion: 1,
    name: "r99",
    version: "1.0.0",
    nodes: [
      { id: "orchestrator", runtime: "claude-code", role: "orchestrator", cwd: "/" },
      { id: "worker-a", runtime: "codex", role: "worker", cwd: "/" },
      { id: "worker-b", runtime: "claude-code", role: "worker", cwd: "/" },
    ],
    edges: [
      { from: "orchestrator", to: "worker-a", kind: "delegates_to" },
      { from: "orchestrator", to: "worker-b", kind: "delegates_to" },
    ],
    ...overrides,
  };
}

describe("SoftwareTeamInstantiator", () => {
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

  function createInstantiator(opts?: { tmux?: TmuxAdapter }) {
    const tmux = opts?.tmux ?? mockTmux();
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const preflight = new SoftwareTeamSpecPreflight({ softwareTeamRepo, tmuxAdapter: tmux, exec: async () => "", cmuxExec: async () => "" });
    return new SoftwareTeamInstantiator({ db, softwareTeamRepo, sessionRegistry, eventBus, nodeLauncher, preflight });
  }

  it("valid spec -> SoftwareTeam created with correct name", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      expect(softwareTeam).not.toBeNull();
      expect(softwareTeam!.softwareTeam.name).toBe("r99");
    }
  });

  it("nodes with correct logical_ids, roles, runtimes, extended fields", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", role: "worker", surfaceHint: "tab:main", packageRefs: ["pkg-a"] }],
      edges: [],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      const node = softwareTeam!.nodes[0]!;
      expect(node.logicalId).toBe("worker");
      expect(node.role).toBe("worker");
      expect(node.runtime).toBe("claude-code");
      expect(node.surfaceHint).toBe("tab:main");
      expect(node.packageRefs).toEqual(["pkg-a"]);
    }
  });

  it("edges with correct from/to/kind", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      expect(softwareTeam!.edges).toHaveLength(2);
      expect(softwareTeam!.edges[0]!.kind).toBe("delegates_to");
    }
  });

  it("topological launch order (delegates_to, exact)", async () => {
    const tmux = mockTmux();
    const inst = createInstantiator({ tmux });
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      expect(order[0]).toBe("orchestrator");
      expect(order.indexOf("orchestrator")).toBeLessThan(order.indexOf("worker-a"));
      expect(order.indexOf("orchestrator")).toBeLessThan(order.indexOf("worker-b"));
    }
  });

  it("spawned_by constrains order", async () => {
    const spec = validSpec({
      nodes: [
        { id: "child", runtime: "claude-code", cwd: "/" },
        { id: "parent", runtime: "claude-code", cwd: "/" },
      ],
      edges: [{ from: "child", to: "parent", kind: "spawned_by" }],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      expect(order.indexOf("parent")).toBeLessThan(order.indexOf("child"));
    }
  });

  it("alphabetical tiebreaker at same depth", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      expect(order.indexOf("worker-a")).toBeLessThan(order.indexOf("worker-b"));
    }
  });

  it("can_observe does NOT constrain order", async () => {
    const spec = validSpec({
      nodes: [
        { id: "orchestrator", runtime: "claude-code", role: "orchestrator", cwd: "/" },
        { id: "worker-a", runtime: "claude-code", cwd: "/" },
        { id: "worker-b", runtime: "claude-code", cwd: "/" },
      ],
      edges: [
        { from: "orchestrator", to: "worker-a", kind: "delegates_to" },
        { from: "orchestrator", to: "worker-b", kind: "delegates_to" },
        { from: "worker-b", to: "worker-a", kind: "can_observe" },
      ],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      // worker-a before worker-b by alphabetical, can_observe does NOT reverse
      expect(order.indexOf("worker-a")).toBeLessThan(order.indexOf("worker-b"));
    }
  });

  it("launch failure -> node 'failed', remaining processed", async () => {
    const tmux = mockTmux();
    let callCount = 0;
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return { ok: false as const, code: "duplicate", message: "err" };
      return { ok: true as const };
    });
    const inst = createInstantiator({ tmux });
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const statuses = result.result.nodes.map((n) => n.status);
      expect(statuses).toContain("failed");
      expect(statuses.filter((s) => s === "launched").length).toBeGreaterThan(0);
    }
  });

  it("softwareTeam.imported persisted after launches with softwareTeamId, specName, specVersion", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    const events = db.prepare("SELECT payload FROM events WHERE type = 'softwareTeam.imported'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.specName).toBe("r99");
    expect(payload.specVersion).toBe("1.0.0");
    if (result.ok) expect(payload.softwareTeamId).toBe(result.result.softwareTeamId);
  });

  it("partial failure: softwareTeam.imported still fires", async () => {
    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, code: "err", message: "fail" })
      .mockResolvedValueOnce({ ok: true });
    const inst = createInstantiator({ tmux });
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    const events = db.prepare("SELECT type FROM events WHERE type = 'softwareTeam.imported'").all();
    expect(events).toHaveLength(1);
  });

  it("validation_failed outcome: { ok: false, code, errors[] }", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate({ schemaVersion: 1, name: "", version: "", nodes: [], edges: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect((result as { errors: string[] }).errors.length).toBeGreaterThan(0);
    }
    // No softwareTeam created
    expect(softwareTeamRepo.listSoftwareTeams()).toHaveLength(0);
  });

  it("preflight_failed outcome: { ok: false, code, errors[], warnings[] }", async () => {
    // Create name collision
    softwareTeamRepo.createSoftwareTeam("r99");
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("preflight_failed");
    }
  });

  it("constructor throws on mismatched db handles", () => {
    const otherDb = setupDb();
    const otherRepo = new SoftwareTeamRepository(otherDb);
    const tmux = mockTmux();
    expect(() => new SoftwareTeamInstantiator({
      db, softwareTeamRepo: otherRepo, sessionRegistry, eventBus,
      nodeLauncher: new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      preflight: new SoftwareTeamSpecPreflight({ softwareTeamRepo, tmuxAdapter: tmux, exec: async () => "", cmuxExec: async () => "" }),
    })).toThrow(/same db handle/);
    otherDb.close();
  });

  it("constructor throws on mismatched preflight db handle", () => {
    const otherDb = setupDb();
    const otherRepo = new SoftwareTeamRepository(otherDb);
    const tmux = mockTmux();
    const otherPreflight = new SoftwareTeamSpecPreflight({ softwareTeamRepo: otherRepo, tmuxAdapter: tmux, exec: async () => "", cmuxExec: async () => "" });
    expect(() => new SoftwareTeamInstantiator({
      db, softwareTeamRepo, sessionRegistry, eventBus,
      nodeLauncher: new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      preflight: otherPreflight,
    })).toThrow(/preflight.*same db handle/);
    otherDb.close();
  });

  it("per-node status in InstantiateResult", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes).toHaveLength(3);
      for (const node of result.result.nodes) {
        expect(node.logicalId).toBeDefined();
        expect(["launched", "failed"]).toContain(node.status);
      }
    }
  });

  it("DB SoftwareTeam retrievable via getSoftwareTeam after instantiate", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      expect(softwareTeam).not.toBeNull();
      expect(softwareTeam!.nodes).toHaveLength(3);
      expect(softwareTeam!.edges).toHaveLength(2);
    }
  });

  it("extended fields persisted (surface_hint, package_refs)", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", surfaceHint: "tab:x", packageRefs: ["pkg"] }],
      edges: [],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      expect(softwareTeam!.nodes[0]!.surfaceHint).toBe("tab:x");
      expect(softwareTeam!.nodes[0]!.packageRefs).toEqual(["pkg"]);
    }
  });

  it("restorePolicy propagated to session metadata", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", restorePolicy: "checkpoint_only" }],
      edges: [],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sessions = sessionRegistry.getSessionsForSoftwareTeam(result.result.softwareTeamId);
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0]!.restorePolicy).toBe("checkpoint_only");
    }
  });

  it("default restorePolicy -> resume_if_possible", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/" }],
      edges: [],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sessions = sessionRegistry.getSessionsForSoftwareTeam(result.result.softwareTeamId);
      expect(sessions[0]!.restorePolicy).toBe("resume_if_possible");
    }
  });

  it("atomic materialization: edge failure -> no partial softwareTeam/nodes", async () => {
    // Sabotage edges table so edge insert fails inside the materialization transaction
    db.exec("CREATE TRIGGER block_edge BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT, 'blocked'); END;");

    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(false);

    // No partial softwareTeam or nodes should remain
    expect(softwareTeamRepo.listSoftwareTeams()).toHaveLength(0);

    db.exec("DROP TRIGGER block_edge");
  });

  it("InstantiateResult success shape: softwareTeamId, specName, specVersion, nodes[]", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.softwareTeamId).toBeDefined();
      expect(result.result.specName).toBe("r99");
      expect(result.result.specVersion).toBe("1.0.0");
      expect(Array.isArray(result.result.nodes)).toBe(true);
    }
  });

  it("softwareTeam.imported event type in SoftwareTeamEvent union", async () => {
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));
    const inst = createInstantiator();
    await inst.instantiate(validSpec());
    const imported = notifications.find((e) => e.type === "softwareTeam.imported");
    expect(imported).toBeDefined();
    if (imported && imported.type === "softwareTeam.imported") {
      expect(imported.specName).toBe("r99");
      expect(imported.specVersion).toBe("1.0.0");
    }
  });

  it("event persistence fails after launches -> ok: true, softwareTeam + sessions exist, no event", async () => {
    const inst = createInstantiator();
    const spec = validSpec({ nodes: [{ id: "worker", runtime: "claude-code", cwd: "/" }], edges: [] });

    // Let the materialization transaction succeed, then sabotage events for the post-launch emit
    const origEmit = eventBus.emit.bind(eventBus);
    let emitCount = 0;
    vi.spyOn(eventBus, "emit").mockImplementation((event) => {
      emitCount++;
      // Block only the softwareTeam.imported emit (not node.launched from NodeLauncher)
      if (event.type === "softwareTeam.imported") {
        throw new Error("event persistence failed");
      }
      return origEmit(event);
    });

    const result = await inst.instantiate(spec);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // SoftwareTeam exists
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      expect(softwareTeam).not.toBeNull();
      // Sessions exist
      const sessions = sessionRegistry.getSessionsForSoftwareTeam(result.result.softwareTeamId);
      expect(sessions.length).toBeGreaterThan(0);
      // No softwareTeam.imported event row
      const importedEvents = db.prepare("SELECT * FROM events WHERE type = 'softwareTeam.imported'").all();
      expect(importedEvents).toHaveLength(0);
    }
  });

  it("restorePolicy propagation fails -> ok: true (best-effort)", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", restorePolicy: "checkpoint_only" }],
      edges: [],
    });
    const inst = createInstantiator();

    // Sabotage sessions table after launch so restorePolicy UPDATE fails
    const origLaunchNode = inst["nodeLauncher"].launchNode.bind(inst["nodeLauncher"]);
    vi.spyOn(inst["nodeLauncher"], "launchNode").mockImplementation(async (...args: [string, string, unknown?]) => {
      const result = await origLaunchNode(...args);
      // Sabotage after successful launch
      if (result.ok) {
        db.exec("CREATE TRIGGER block_session_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
      }
      return result;
    });

    const result = await inst.instantiate(spec);

    // Should still return ok: true
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.softwareTeamId).toBeDefined();
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      expect(softwareTeam).not.toBeNull();
    }

    // Clean up trigger
    try { db.exec("DROP TRIGGER block_session_update"); } catch { /* may not exist */ }
  });

  it("dependency cycle -> instantiate_error", async () => {
    const spec = validSpec({
      nodes: [
        { id: "a", runtime: "claude-code", cwd: "/" },
        { id: "b", runtime: "claude-code", cwd: "/" },
      ],
      edges: [
        { from: "a", to: "b", kind: "delegates_to" },
        { from: "b", to: "a", kind: "delegates_to" },
      ],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("instantiate_error");
      expect(result.message).toContain("cycle");
    }

    // No softwareTeam should have been created (cycle detected before materialization)
    expect(softwareTeamRepo.listSoftwareTeams()).toHaveLength(0);
  });

  // -- Review Fix 2: Total launch failure cleanup --

  it("all launches fail -> instantiate_error, SoftwareTeam deleted, no softwareTeam.imported", async () => {
    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: false as const, code: "err", message: "all fail" }
    );
    const inst = createInstantiator({ tmux });
    const result = await inst.instantiate(validSpec());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("instantiate_error");
      expect(result.message).toContain("all node launches failed");
    }

    // SoftwareTeam should be deleted
    expect(softwareTeamRepo.listSoftwareTeams()).toHaveLength(0);

    // No softwareTeam.imported event
    const events = db.prepare("SELECT * FROM events WHERE type = 'softwareTeam.imported'").all();
    expect(events).toHaveLength(0);
  });

  it("partial launch failure -> ok: true, SoftwareTeam preserved", async () => {
    const tmux = mockTmux();
    let callCount = 0;
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return { ok: false as const, code: "err", message: "fail" };
      return { ok: true as const };
    });
    const inst = createInstantiator({ tmux });
    const result = await inst.instantiate(validSpec());

    expect(result.ok).toBe(true);
    if (result.ok) {
      // SoftwareTeam preserved
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      expect(softwareTeam).not.toBeNull();
    }
  });

  it("total failure -> no softwareTeam.imported event row", async () => {
    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: false as const, code: "err", message: "fail" }
    );
    const inst = createInstantiator({ tmux });
    await inst.instantiate(validSpec());

    const events = db.prepare("SELECT * FROM events WHERE type = 'softwareTeam.imported'").all();
    expect(events).toHaveLength(0);
  });

  it("launch warnings propagate into InstantiateResult.warnings", async () => {
    const tmux = mockTmux();
    // Mock launchNode to return warnings via NodeLauncher transcript integration
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    // Override launchNode to simulate transcript warning
    const originalLaunch = nodeLauncher.launchNode.bind(nodeLauncher);
    vi.spyOn(nodeLauncher, "launchNode").mockImplementation(async (...args) => {
      const result = await originalLaunch(...args);
      if (result.ok) {
        return { ...result, warnings: ["Transcript capture failed for test-session: pipe-pane failed"] };
      }
      return result;
    });

    const preflight = new SoftwareTeamSpecPreflight({ softwareTeamRepo, tmuxAdapter: tmux, exec: async () => "", cmuxExec: async () => "" });
    const inst = new SoftwareTeamInstantiator({ db, softwareTeamRepo, sessionRegistry, eventBus, nodeLauncher, preflight });
    const result = await inst.instantiate(validSpec());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.warnings).toBeDefined();
      expect(result.result.warnings!.length).toBeGreaterThan(0);
      expect(result.result.warnings![0]).toContain("Transcript capture failed");
    }
  });
});
