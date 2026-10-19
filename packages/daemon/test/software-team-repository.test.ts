import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

describe("SoftwareTeamRepository", () => {
  let db: Database.Database;
  let repo: SoftwareTeamRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new SoftwareTeamRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("createSoftwareTeam persists and returns typed SoftwareTeam with id", () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    expect(softwareTeam.id).toBeDefined();
    expect(typeof softwareTeam.id).toBe("string");
    expect(softwareTeam.id.length).toBeGreaterThan(0);
    expect(softwareTeam.name).toBe("test-software-team");
    expect(softwareTeam.createdAt).toBeDefined();
  });

  it("addNode persists with softwareTeam FK, returns typed Node", () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    const node = repo.addNode(softwareTeam.id, "orchestrator", {
      role: "orchestrator",
      runtime: "claude-code",
      model: "opus",
    });
    expect(node.id).toBeDefined();
    expect(node.softwareTeamId).toBe(softwareTeam.id);
    expect(node.logicalId).toBe("orchestrator");
    expect(node.role).toBe("orchestrator");
    expect(node.runtime).toBe("claude-code");
    expect(node.model).toBe("opus");
  });

  it("addNode to nonexistent SoftwareTeam throws", () => {
    expect(() => repo.addNode("nonexistent", "worker")).toThrow();
  });

  it("addNode with duplicate logical_id in same SoftwareTeam throws", () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    repo.addNode(softwareTeam.id, "worker");
    expect(() => repo.addNode(softwareTeam.id, "worker")).toThrow();
  });

  it("addEdge validates both nodes exist and belong to same softwareTeam", () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    const n1 = repo.addNode(softwareTeam.id, "orchestrator");
    const n2 = repo.addNode(softwareTeam.id, "worker");
    const edge = repo.addEdge(softwareTeam.id, n1.id, n2.id, "delegates_to");
    expect(edge.id).toBeDefined();
    expect(edge.sourceId).toBe(n1.id);
    expect(edge.targetId).toBe(n2.id);
    expect(edge.kind).toBe("delegates_to");
  });

  it("addEdge cross-software-team rejected", () => {
    const rig1 = repo.createSoftwareTeam("software-team-one");
    const rig2 = repo.createSoftwareTeam("software-team-two");
    const n1 = repo.addNode(rig1.id, "worker-a");
    const n2 = repo.addNode(rig2.id, "worker-b");
    expect(() =>
      repo.addEdge(rig1.id, n1.id, n2.id, "delegates_to")
    ).toThrow(/same softwareTeam/);
  });

  it("getSoftwareTeam returns full graph with nodes, edges, and bindings", () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    const n1 = repo.addNode(softwareTeam.id, "orchestrator", { role: "orchestrator" });
    const n2 = repo.addNode(softwareTeam.id, "worker", { role: "worker" });
    repo.addEdge(softwareTeam.id, n1.id, n2.id, "delegates_to");

    // Add a binding to n1 only
    db.prepare(
      "INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)"
    ).run("bind-1", n1.id, "r01-orch1-lead");

    const full = repo.getSoftwareTeam(softwareTeam.id);
    expect(full).not.toBeNull();
    expect(full!.softwareTeam.name).toBe("test-software-team");
    expect(full!.nodes).toHaveLength(2);
    expect(full!.edges).toHaveLength(1);
    expect(full!.edges[0]!.kind).toBe("delegates_to");

    // n1 has a binding
    const orchNode = full!.nodes.find((n) => n.logicalId === "orchestrator");
    expect(orchNode!.binding).not.toBeNull();
    expect(orchNode!.binding!.tmuxSession).toBe("r01-orch1-lead");
  });

  it("getSoftwareTeam: unbound nodes have binding: null (not undefined/omitted)", () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    repo.addNode(softwareTeam.id, "worker");

    const full = repo.getSoftwareTeam(softwareTeam.id);
    const workerNode = full!.nodes.find((n) => n.logicalId === "worker");
    // Must be explicitly null, not undefined
    expect(workerNode).toHaveProperty("binding");
    expect(workerNode!.binding).toBeNull();
  });

  it("listSoftwareTeams returns all softwareTeams", () => {
    repo.createSoftwareTeam("software-team-a");
    repo.createSoftwareTeam("software-team-b");
    repo.createSoftwareTeam("software-team-c");
    const softwareTeams = repo.listSoftwareTeams();
    expect(softwareTeams).toHaveLength(3);
    const names = softwareTeams.map((r) => r.name);
    expect(names).toContain("software-team-a");
    expect(names).toContain("software-team-b");
    expect(names).toContain("software-team-c");
  });

  it("finds an older live project when a later generation was re-archived", () => {
    const live = repo.createSoftwareTeam("same-name");
    const predecessor = repo.createSoftwareTeam("same-name");
    db.prepare("UPDATE software_teams SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00Z", live.id);
    db.prepare("UPDATE software_teams SET created_at = ? WHERE id = ?").run("2026-01-02T00:00:00Z", predecessor.id);
    for (const softwareTeam of [live, predecessor]) {
      repo.setServicesRecord(softwareTeam.id, {
        kind: "compose",
        specJson: "{}",
        softwareTeamRoot: "/tmp",
        composeFile: "compose.yaml",
        projectName: "shared-project",
      });
    }
    expect(repo.archiveSoftwareTeam(predecessor.id)).toBe(true);

    expect(repo.getLiveServicesSuccessor(predecessor.id, "shared-project")).toEqual({ id: live.id, name: "same-name" });
  });

  it("deleteSoftwareTeam cascades — nodes and edges gone", () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    const n1 = repo.addNode(softwareTeam.id, "orchestrator");
    const n2 = repo.addNode(softwareTeam.id, "worker");
    repo.addEdge(softwareTeam.id, n1.id, n2.id, "delegates_to");

    repo.deleteSoftwareTeam(softwareTeam.id);

    expect(repo.getSoftwareTeam(softwareTeam.id)).toBeNull();
    expect(repo.listSoftwareTeams()).toHaveLength(0);
  });

  // -- P3-T00: Extended node fields --

  it("addNode persists extended fields", () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    const node = repo.addNode(softwareTeam.id, "worker", {
      role: "worker",
      runtime: "claude-code",
      surfaceHint: "tab:workers",
      workspace: "review",
      restorePolicy: "checkpoint_only",
      packageRefs: ["github:example/pkg@v1", "local:./my-pkg"],
    });

    expect(node.surfaceHint).toBe("tab:workers");
    expect(node.workspace).toBe("review");
    expect(node.restorePolicy).toBe("checkpoint_only");
    expect(node.packageRefs).toEqual(["github:example/pkg@v1", "local:./my-pkg"]);
  });

  it("getSoftwareTeam returns nodes with extended fields (parsed packageRefs)", () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    repo.addNode(softwareTeam.id, "worker", {
      surfaceHint: "tab:main",
      packageRefs: ["pkg-a", "pkg-b"],
    });

    const full = repo.getSoftwareTeam(softwareTeam.id);
    const node = full!.nodes[0]!;
    expect(node.surfaceHint).toBe("tab:main");
    expect(node.packageRefs).toEqual(["pkg-a", "pkg-b"]);
    expect(Array.isArray(node.packageRefs)).toBe(true);
  });

  it("addNode with no extended fields: surfaceHint=null, workspace=null, restorePolicy=null, packageRefs=[]", () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    const node = repo.addNode(softwareTeam.id, "worker");

    expect(node.surfaceHint).toBeNull();
    expect(node.workspace).toBeNull();
    expect(node.restorePolicy).toBeNull();
    expect(node.packageRefs).toEqual([]);
  });
});

describe("Wiring regression", () => {
  it("createFullTestDb schema includes 007 columns", async () => {
    const { createFullTestDb } = await import("./helpers/test-app.js");
    const db = createFullTestDb();
    const cols = db.prepare("PRAGMA table_info(nodes)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("surface_hint");
    expect(names).toContain("workspace");
    expect(names).toContain("restore_policy");
    expect(names).toContain("package_refs");
    db.close();
  });
});

// L2 findLatestUsableSnapshot
describe("SoftwareTeamRepository.findLatestUsableSnapshot (L2)", () => {
  let db: Database.Database;
  let repo: SoftwareTeamRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new SoftwareTeamRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedSnapshot(
    softwareTeamId: string,
    snapshotId: string,
    sessions: Array<{ nodeId: string; resumeToken: string | null }>,
    createdAt?: string,
  ): void {
    const data = {
      softwareTeam: { id: softwareTeamId, name: "software-team-name", createdAt: "2026-04-28T00:00:00Z", updatedAt: "2026-04-28T00:00:00Z" },
      nodes: [],
      edges: [],
      sessions: sessions.map((s, i) => ({
        id: `sess-snap-${i}`,
        nodeId: s.nodeId,
        sessionName: `tmux-${s.nodeId}`,
        status: "detached",
        resumeType: s.resumeToken ? "claude" : null,
        resumeToken: s.resumeToken,
        restorePolicy: "resume_if_possible",
        lastSeenAt: null,
        createdAt: "2026-04-28T00:00:00Z",
        origin: "launched" as const,
        startupStatus: "ready" as const,
        startupCompletedAt: null,
      })),
      checkpoints: {},
    };
    if (createdAt) {
      db.prepare("INSERT INTO snapshots (id, software_team_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(snapshotId, softwareTeamId, "manual", "complete", JSON.stringify(data), createdAt);
    } else {
      db.prepare("INSERT INTO snapshots (id, software_team_id, kind, status, data) VALUES (?, ?, ?, ?, ?)")
        .run(snapshotId, softwareTeamId, "manual", "complete", JSON.stringify(data));
    }
  }

  it("returns null when no snapshot exists for softwareTeam", () => {
    const softwareTeam = repo.createSoftwareTeam("no-snap");
    expect(repo.findLatestUsableSnapshot(softwareTeam.id)).toBeNull();
  });

  it("returns null when only snapshots have null resume tokens for all nodes", () => {
    const softwareTeam = repo.createSoftwareTeam("null-tokens");
    seedSnapshot(softwareTeam.id, "snap-1", [
      { nodeId: "node-a", resumeToken: null },
      { nodeId: "node-b", resumeToken: null },
    ]);
    expect(repo.findLatestUsableSnapshot(softwareTeam.id)).toBeNull();
  });

  it("returns latest snapshot when at least one session has a non-null resume token", () => {
    const softwareTeam = repo.createSoftwareTeam("usable");
    seedSnapshot(softwareTeam.id, "snap-1", [
      { nodeId: "node-a", resumeToken: "tok-a" },
      { nodeId: "node-b", resumeToken: null },
    ]);

    const result = repo.findLatestUsableSnapshot(softwareTeam.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("snap-1");
    expect(result!.data.sessions?.find((s) => s.nodeId === "node-a")?.resumeToken).toBe("tok-a");
  });

  it("returns the snapshot even when only some nodes have valid tokens (per-node lifecycleState handles individual recoverability)", () => {
    const softwareTeam = repo.createSoftwareTeam("partial");
    seedSnapshot(softwareTeam.id, "snap-1", [
      { nodeId: "node-a", resumeToken: "tok-a" }, // recoverable
      { nodeId: "node-b", resumeToken: null },     // detached
      { nodeId: "node-c", resumeToken: null },     // detached
    ]);

    const result = repo.findLatestUsableSnapshot(softwareTeam.id);
    expect(result).not.toBeNull();
    expect(result!.data.sessions).toHaveLength(3);
  });

  it("returns the latest snapshot when multiple usable snapshots exist (ORDER BY created_at DESC, id DESC)", () => {
    const softwareTeam = repo.createSoftwareTeam("multi-snap");
    seedSnapshot(softwareTeam.id, "snap-old", [{ nodeId: "node-a", resumeToken: "tok-old" }], "2026-04-27 00:00:00");
    seedSnapshot(softwareTeam.id, "snap-new", [{ nodeId: "node-a", resumeToken: "tok-new" }], "2026-04-28 00:00:00");

    const result = repo.findLatestUsableSnapshot(softwareTeam.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("snap-new");
  });
});
