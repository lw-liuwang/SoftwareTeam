import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { workspacePrimitiveSchema } from "../src/db/migrations/038_workspace_primitive.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SoftwareTeamSpecExporter } from "../src/domain/software-team-spec-exporter.js";
import { LegacySoftwareTeamSpecSchema as SoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import { LegacySoftwareTeamSpecCodec as SoftwareTeamSpecCodec } from "../src/domain/software-team-spec-codec.js";
import { SoftwareTeamSpecSchema as PodSoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import { SoftwareTeamSpecCodec as PodSoftwareTeamSpecCodec } from "../src/domain/software-team-spec-codec.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SoftwareTeamNotFoundError } from "../src/domain/errors.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  const db = createFullTestDb();
  migrate(db, [workspacePrimitiveSchema]);
  return db;
}

describe("SoftwareTeamSpecExporter", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let exporter: SoftwareTeamSpecExporter;

  beforeEach(() => {
    db = setupDb();
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    exporter = new SoftwareTeamSpecExporter({ softwareTeamRepo, sessionRegistry });
  });

  afterEach(() => {
    db.close();
  });

  function seedSoftwareTeam() {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r99");
    const n1 = softwareTeamRepo.addNode(softwareTeam.id, "orchestrator", {
      role: "orchestrator",
      runtime: "claude-code",
      model: "opus",
      cwd: "/repo",
      surfaceHint: "tab:main",
      workspace: "review",
      packageRefs: ["github:example/pkg@v1"],
    });
    const n2 = softwareTeamRepo.addNode(softwareTeam.id, "worker", {
      role: "worker",
      runtime: "codex",
      cwd: "/repo",
    });
    softwareTeamRepo.addEdge(softwareTeam.id, n1.id, n2.id, "delegates_to");
    // Add a binding to n1 (should be excluded from export)
    sessionRegistry.updateBinding(n1.id, { tmuxSession: "r99-orchestrator", cmuxSurface: "s-1" });
    return { softwareTeam, n1, n2 };
  }

  it("export SoftwareTeam with nodes and edges -> valid SoftwareTeamSpec", () => {
    const { softwareTeam } = seedSoftwareTeam();
    const spec = exporter.exportSoftwareTeam(softwareTeam.id);

    expect(spec.name).toBe("r99");
    expect(spec.schemaVersion).toBe(1);
    expect(spec.nodes).toHaveLength(2);
    expect(spec.edges).toHaveLength(1);
  });

  it("exported spec passes schema validation", () => {
    const { softwareTeam } = seedSoftwareTeam();
    const spec = exporter.exportSoftwareTeam(softwareTeam.id);

    const result = SoftwareTeamSpecSchema.validate(SoftwareTeamSpecCodec.parse(SoftwareTeamSpecCodec.serialize(spec)));
    expect(result.valid).toBe(true);
  });

  it("exported node ids are logical_ids (not DB PKs)", () => {
    const { softwareTeam, n1 } = seedSoftwareTeam();
    const spec = exporter.exportSoftwareTeam(softwareTeam.id);

    // Node ids should be logical_ids like "orchestrator", not ULIDs
    expect(spec.nodes[0]!.id).toBe("orchestrator");
    expect(spec.nodes[1]!.id).toBe("worker");
    // Definitely not DB primary keys
    expect(spec.nodes[0]!.id).not.toBe(n1.id);
  });

  it("exported edges use logical_ids for from/to", () => {
    const { softwareTeam } = seedSoftwareTeam();
    const spec = exporter.exportSoftwareTeam(softwareTeam.id);

    expect(spec.edges[0]!.from).toBe("orchestrator");
    expect(spec.edges[0]!.to).toBe("worker");
    expect(spec.edges[0]!.kind).toBe("delegates_to");
  });

  it("export excludes session IDs, resume tokens, binding data", () => {
    const { softwareTeam, n1 } = seedSoftwareTeam();
    // Add a session with resume data
    const sess = sessionRegistry.registerSession(n1.id, "r99-orchestrator");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ? WHERE id = ?")
      .run("claude_name", "secret-token", sess.id);

    const spec = exporter.exportSoftwareTeam(softwareTeam.id);
    const yaml = SoftwareTeamSpecCodec.serialize(spec);

    // None of these should appear in the exported spec
    expect(yaml).not.toContain("secret-token");
    expect(yaml).not.toContain(sess.id);
    expect(yaml).not.toContain("tmux_session");
    expect(yaml).not.toContain("cmux_surface");
    expect(yaml).not.toContain(n1.id); // DB PK
  });

  it("export includes role, runtime, model, cwd, surfaceHint, packageRefs", () => {
    const { softwareTeam } = seedSoftwareTeam();
    const spec = exporter.exportSoftwareTeam(softwareTeam.id);

    const orch = spec.nodes.find((n) => n.id === "orchestrator")!;
    expect(orch.role).toBe("orchestrator");
    expect(orch.runtime).toBe("claude-code");
    expect(orch.model).toBe("opus");
    expect(orch.cwd).toBe("/repo");
    expect(orch.surfaceHint).toBe("tab:main");
    expect(orch.packageRefs).toEqual(["github:example/pkg@v1"]);
  });

  it("export includes restorePolicy from latest session (newest wins)", () => {
    const { softwareTeam, n1 } = seedSoftwareTeam();
    // Add two sessions with explicit timestamps and different policies
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("sess-old", n1.id, "r99-orchestrator", "exited", "relaunch_fresh", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("sess-new", n1.id, "r99-orchestrator", "running", "checkpoint_only", "2026-03-23 02:00:00");

    const spec = exporter.exportSoftwareTeam(softwareTeam.id);
    const orch = spec.nodes.find((n) => n.id === "orchestrator")!;
    expect(orch.restorePolicy).toBe("checkpoint_only"); // newest session wins
  });

  it("export restorePolicy falls back to node.restore_policy when no session", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r98");
    softwareTeamRepo.addNode(softwareTeam.id, "worker", {
      runtime: "codex",
      restorePolicy: "relaunch_fresh",
    });

    const spec = exporter.exportSoftwareTeam(softwareTeam.id);
    expect(spec.nodes[0]!.restorePolicy).toBe("relaunch_fresh");
  });

  it("export with multiple sessions: latest by createdAt wins", () => {
    const { softwareTeam, n2 } = seedSoftwareTeam();
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s1", n2.id, "r99-worker", "exited", "checkpoint_only", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s2", n2.id, "r99-worker", "running", "relaunch_fresh", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s3", n2.id, "r99-worker", "idle", "resume_if_possible", "2026-03-23 02:00:00");

    const spec = exporter.exportSoftwareTeam(softwareTeam.id);
    const worker = spec.nodes.find((n) => n.id === "worker")!;
    expect(worker.restorePolicy).toBe("relaunch_fresh"); // s2 is newest
  });

  it("same-second sessions: tiebreaker by id (ULID) for deterministic result", () => {
    const { softwareTeam, n1 } = seedSoftwareTeam();
    // Two sessions with identical createdAt but different IDs and policies
    // ULID "B..." sorts after "A..." so sess-b is the "latest"
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("AAAA_sess_first", n1.id, "r99-orchestrator", "running", "relaunch_fresh", "2026-03-23 05:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("ZZZZ_sess_second", n1.id, "r99-orchestrator", "running", "checkpoint_only", "2026-03-23 05:00:00");

    const spec = exporter.exportSoftwareTeam(softwareTeam.id);
    const orch = spec.nodes.find((n) => n.id === "orchestrator")!;
    // ZZZZ sorts after AAAA, so checkpoint_only should win
    expect(orch.restorePolicy).toBe("checkpoint_only");
  });

  it("export nonexistent SoftwareTeam -> throws SoftwareTeamNotFoundError", () => {
    expect(() => exporter.exportSoftwareTeam("nonexistent")).toThrow(SoftwareTeamNotFoundError);
  });

  it("export node with null runtime -> throws explicit error", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r97");
    // Insert node with no runtime via raw SQL to bypass addNode defaults
    db.prepare("INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)")
      .run("node-no-rt", softwareTeam.id, "broken-node");

    expect(() => exporter.exportSoftwareTeam(softwareTeam.id)).toThrow(/runtime.*required/i);
  });

  it("export edge with unmapped sourceId -> throws", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r96");
    const n1 = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });
    // Temporarily disable FK to insert corrupted edge
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO edges (id, software_team_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)")
      .run("bad-edge", softwareTeam.id, "nonexistent-source", n1.id, "delegates_to");
    db.pragma("foreign_keys = ON");

    expect(() => exporter.exportSoftwareTeam(softwareTeam.id)).toThrow(/unmapped.*source/i);
  });

  it("export edge with unmapped targetId -> throws", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r95");
    const n1 = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO edges (id, software_team_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)")
      .run("bad-edge", softwareTeam.id, n1.id, "nonexistent-target", "delegates_to");
    db.pragma("foreign_keys = ON");

    expect(() => exporter.exportSoftwareTeam(softwareTeam.id)).toThrow(/unmapped.*target/i);
  });

  it("round-trip: export -> serialize -> parse -> validate all pass", () => {
    const { softwareTeam } = seedSoftwareTeam();
    const spec = exporter.exportSoftwareTeam(softwareTeam.id);
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const parsed = SoftwareTeamSpecCodec.parse(yaml);
    const result = SoftwareTeamSpecSchema.validate(parsed);
    expect(result.valid).toBe(true);
  });

  it("constructor throws on mismatched db handles", () => {
    const otherDb = setupDb();
    const otherRepo = new SoftwareTeamRepository(otherDb);

    expect(() => new SoftwareTeamSpecExporter({ softwareTeamRepo: otherRepo, sessionRegistry }))
      .toThrow(/same db handle/);

    otherDb.close();
  });
});

describe("SoftwareTeamSpecExporter (pod-aware)", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let podRepo: PodRepository;
  let exporter: SoftwareTeamSpecExporter;

  beforeEach(() => {
    db = setupDb();
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    podRepo = new PodRepository(db);
    exporter = new SoftwareTeamSpecExporter({ softwareTeamRepo, sessionRegistry, podRepo });
  });

  afterEach(() => { db.close(); });

  function seedPodSoftwareTeam() {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("pod-test");
    const devPod = podRepo.createPod(softwareTeam.id, "dev", "Dev", { summary: "dev pod" });
    const archPod = podRepo.createPod(softwareTeam.id, "arch", "Arch", { summary: "arch pod" });
    const n1 = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code", podId: devPod.id, agentRef: "local:agents/impl", profile: "tdd", cwd: "." });
    const n2 = softwareTeamRepo.addNode(softwareTeam.id, "dev.qa", { runtime: "codex", podId: devPod.id, agentRef: "local:agents/qa", profile: "default", cwd: "." });
    const n3 = softwareTeamRepo.addNode(softwareTeam.id, "arch.reviewer", { runtime: "claude-code", podId: archPod.id, agentRef: "local:agents/reviewer", profile: "default", cwd: "." });
    softwareTeamRepo.addEdge(softwareTeam.id, n1.id, n2.id, "can_observe");
    softwareTeamRepo.addEdge(softwareTeam.id, n1.id, n3.id, "escalates_to");
    return { softwareTeam, devPod, archPod, n1, n2, n3 };
  }

  it("exports pod-aware SoftwareTeam with pods, members, and edges", () => {
    const { softwareTeam } = seedPodSoftwareTeam();
    const spec = exporter.exportSoftwareTeam(softwareTeam.id) as import("../src/domain/types.js").SoftwareTeamSpec;
    expect(spec.version).toBe("0.2");
    expect(spec.workspace).toBeUndefined();
    expect(spec.pods).toHaveLength(2);
    const devPod = spec.pods.find((p) => p.id === "dev")!;
    expect(devPod).toBeDefined();
    expect(devPod.members).toHaveLength(2);
    expect(devPod.members.map((m) => m.id).sort()).toEqual(["impl", "qa"]);
    expect(devPod.members[0]!.agentRef).toContain("agents/");
  });

  it("exports the persisted workspace declaration", () => {
    const { softwareTeam } = seedPodSoftwareTeam();
    const workspace: import("../src/domain/types.js").WorkspaceSpec = {
      workspaceRoot: "/workspace",
      repos: [
        { name: "app", path: "/workspace/app", kind: "project" },
        { name: "docs", path: "/workspace/docs", kind: "knowledge" },
      ],
      defaultRepo: "app",
      knowledgeRoot: "/workspace/docs",
    };
    softwareTeamRepo.setSoftwareTeamWorkspace(softwareTeam.id, workspace);

    const spec = exporter.exportSoftwareTeam(softwareTeam.id) as import("../src/domain/types.js").SoftwareTeamSpec;
    expect(spec.workspace).toEqual(workspace);

    const parsed = PodSoftwareTeamSpecCodec.parse(PodSoftwareTeamSpecCodec.serialize(spec));
    expect(PodSoftwareTeamSpecSchema.validate(parsed).valid).toBe(true);
    expect(PodSoftwareTeamSpecSchema.normalize(parsed as Record<string, unknown>).workspace).toEqual(workspace);
  });

  it("pod-local edges use member-local ids", () => {
    const { softwareTeam } = seedPodSoftwareTeam();
    const spec = exporter.exportSoftwareTeam(softwareTeam.id) as import("../src/domain/types.js").SoftwareTeamSpec;
    const devPod = spec.pods.find((p) => p.id === "dev")!;
    expect(devPod.edges).toHaveLength(1);
    expect(devPod.edges[0]!.from).toBe("impl");
    expect(devPod.edges[0]!.to).toBe("qa");
  });

  it("cross-pod edges use qualified podId.memberId", () => {
    const { softwareTeam } = seedPodSoftwareTeam();
    const spec = exporter.exportSoftwareTeam(softwareTeam.id) as import("../src/domain/types.js").SoftwareTeamSpec;
    expect(spec.edges).toHaveLength(1);
    expect(spec.edges[0]!.from).toBe("dev.impl");
    expect(spec.edges[0]!.to).toBe("arch.reviewer");
  });

  it("exports empty pods using persisted pod namespace instead of pod ULID", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("empty-pod-test");
    const pod = podRepo.createPod(softwareTeam.id, "research", "Research", { summary: "empty pod" });

    const spec = exporter.exportSoftwareTeam(softwareTeam.id) as import("../src/domain/types.js").SoftwareTeamSpec;
    expect(spec.pods).toHaveLength(1);
    expect(spec.pods[0]!.id).toBe("research");
    expect(spec.pods[0]!.id).not.toBe(pod.id);
  });

  it("round-trip: export -> serialize -> parse -> validate passes", () => {
    const { softwareTeam } = seedPodSoftwareTeam();
    const spec = exporter.exportSoftwareTeam(softwareTeam.id) as import("../src/domain/types.js").SoftwareTeamSpec;
    const yaml = PodSoftwareTeamSpecCodec.serialize(spec);
    const parsed = PodSoftwareTeamSpecCodec.parse(yaml);
    const result = PodSoftwareTeamSpecSchema.validate(parsed);
    expect(result.valid).toBe(true);
  });
});
