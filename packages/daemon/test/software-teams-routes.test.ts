import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";

function insertStartupContextRow(db: Database.Database, nodeId: string) {
  db.prepare(
    "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run(nodeId, "[]", "[]", "[]", "claude-code");
}

describe("SoftwareTeam CRUD routes", () => {
  let db: Database.Database;
  let app: Hono;
  let repo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotRepo: SnapshotRepository;
  let snapshotCapture: SnapshotCapture;
  let restoreOrchestrator: RestoreOrchestrator;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    repo = setup.softwareTeamRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotRepo = setup.snapshotRepo;
    snapshotCapture = setup.snapshotCapture;
    restoreOrchestrator = setup.restoreOrchestrator;
  });

  afterEach(() => {
    db.close();
  });

  it("POST /api/software-teams -> 201 + created SoftwareTeam with id and name", async () => {
    const res = await app.request("/api/software-teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-software-team" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("test-software-team");
  });

  it("GET /api/software-teams -> list of softwareTeams", async () => {
    repo.createSoftwareTeam("software-team-a");
    repo.createSoftwareTeam("software-team-b");

    const res = await app.request("/api/software-teams");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].name).toBeDefined();
  });

  it("GET /api/software-teams/:id -> full graph with nodes, edges, bindings", async () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    const n1 = repo.addNode(softwareTeam.id, "orchestrator", { role: "orchestrator" });
    const n2 = repo.addNode(softwareTeam.id, "worker", { role: "worker" });
    repo.addEdge(softwareTeam.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.softwareTeam.name).toBe("test-software-team");
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0].kind).toBe("delegates_to");
  });

  it("GET /api/software-teams/:id -> unbound nodes have binding: null (not omitted)", async () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    repo.addNode(softwareTeam.id, "worker", { role: "worker" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const worker = body.nodes.find((n: { logicalId: string }) => n.logicalId === "worker");
    expect(worker).toBeDefined();
    expect(worker).toHaveProperty("binding");
    expect(worker.binding).toBeNull();
  });

  it("GET /api/software-teams/:id with nonexistent id -> 404", async () => {
    const res = await app.request("/api/software-teams/nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/software-teams/:id -> 204", async () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(repo.getSoftwareTeam(softwareTeam.id)).toBeNull();
  });

  it("DELETE /api/software-teams/:id -> software-team.deleted event row in DB", async () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const events = db
      .prepare("SELECT type, payload FROM events WHERE type = 'software-team.deleted'")
      .all() as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.softwareTeamId).toBe(softwareTeam.id);
  });

  it("DELETE /api/software-teams/:id with nonexistent id -> 204 + no software-team.deleted event", async () => {
    const res = await app.request("/api/software-teams/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(204);

    const events = db
      .prepare("SELECT * FROM events WHERE type = 'software-team.deleted'")
      .all();
    expect(events).toHaveLength(0);
  });

  it("DELETE /api/software-teams/:id with sabotaged events -> SoftwareTeam still exists + no event row", async () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");

    // Sabotage events table so event insert fails inside the transaction
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, software_team_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    const res = await app.request(`/api/software-teams/${softwareTeam.id}`, { method: "DELETE" });
    // Should fail (transaction rolled back)
    expect(res.status).toBe(500);

    // SoftwareTeam still exists (rollback)
    expect(repo.getSoftwareTeam(softwareTeam.id)).not.toBeNull();

    // No partial event row
    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });

  it("POST /api/software-teams with invalid body -> 400", async () => {
    const res = await app.request("/api/software-teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("archives a mixed healthy-plus-missing SoftwareTeam without force, as on main", async () => {
    const softwareTeam = repo.createSoftwareTeam("mixed-archive");
    const healthy = repo.addNode(softwareTeam.id, "dev.healthy", { runtime: "codex" });
    const missing = repo.addNode(softwareTeam.id, "dev.missing", { runtime: "codex" });
    const healthySession = sessionRegistry.registerSession(healthy.id, "dev-healthy@mixed-archive");
    const missingSession = sessionRegistry.registerSession(missing.id, "dev-missing@mixed-archive");
    for (const session of [healthySession, missingSession]) sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(missing.id, {
      tmuxSession: missingSession.sessionName, tmuxPane: "%1", attachmentType: "tmux",
    });
    new SeatIdentityStore(db).upsert({
      nodeId: missing.id,
      sessionName: missingSession.sessionName,
      verdict: "pane_missing",
      evidenceSource: "tmux_session",
      reason: "session_missing",
      evidence: { registeredPane: "%1", observedPid: null, observedCommand: null, matchedLayer: null },
      observedAt: new Date(Date.now() + 1).toISOString(),
    });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(repo.getSoftwareTeamSummaries({ archivedOnly: true }).map((entry) => entry.id)).toContain(softwareTeam.id);
  });

  it("requires force for a live seat plus stored-detached missing seat", async () => {
    const softwareTeam = repo.createSoftwareTeam("stored-detached-archive");
    const healthy = repo.addNode(softwareTeam.id, "dev.healthy", { runtime: "codex" });
    const missing = repo.addNode(softwareTeam.id, "dev.missing", { runtime: "codex" });
    const healthySession = sessionRegistry.registerSession(healthy.id, "dev-healthy@stored-detached-archive");
    const missingSession = sessionRegistry.registerSession(missing.id, "dev-missing@stored-detached-archive");
    sessionRegistry.updateStatus(healthySession.id, "running");
    sessionRegistry.updateStatus(missingSession.id, "detached");
    sessionRegistry.updateBinding(missing.id, {
      tmuxSession: missingSession.sessionName, tmuxPane: "%1", attachmentType: "tmux",
    });
    new SeatIdentityStore(db).upsert({
      nodeId: missing.id, sessionName: missingSession.sessionName,
      verdict: "pane_missing", evidenceSource: "tmux_session", reason: "session_missing",
      evidence: { registeredPane: "%1", observedPid: null, observedCommand: null, matchedLayer: null },
      observedAt: new Date(Date.now() + 1).toISOString(),
    });

    const archive = (force: boolean) => app.request(`/api/software-teams/${softwareTeam.id}/archive`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }),
    });
    expect((await archive(false)).status).toBe(409);
    expect((await archive(true)).status).toBe(200);
  });

  it("POST /api/software-teams/:id/attach-self binds an external_cli agent to an existing node", async () => {
    const softwareTeam = repo.createSoftwareTeam("softwareteam-buildout");
    const node = repo.addNode(softwareTeam.id, "orch1.lead", { runtime: "claude-code" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logicalId: "orch1.lead",
        displayName: "orch1-lead@softwareteam-buildout",
        cwd: "/Users/example/code/softwareteam",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodeId).toBe(node.id);
    expect(body.attachmentType).toBe("external_cli");
    expect(body.env.SOFTWARETEAM_NODE_ID).toBe(node.id);
    expect(body.env.SOFTWARETEAM_SESSION_NAME).toBe("orch1-lead@softwareteam-buildout");
  });

  it.each(["claude-code", "codex"])("attach-self checks the optional existing-node runtime guard %s", async (runtime) => {
    const softwareTeam = repo.createSoftwareTeam("runtime-guard");
    const node = repo.addNode(softwareTeam.id, "dev.worker", { runtime: "claude-code" });
    const res = await app.request(`/api/software-teams/${softwareTeam.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logicalId: "dev.worker", runtime, displayName: "worker@runtime-guard" }),
    });
    if (runtime === "claude-code") {
      expect(res.status).toBe(201);
      expect((await res.json()).nodeId).toBe(node.id);
      expect(sessionRegistry.getBindingForNode(node.id)).toBeTruthy();
    } else {
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("runtime_mismatch");
      expect(sessionRegistry.getBindingForNode(node.id)).toBeFalsy();
    }
  });

  it("POST /api/software-teams/:id/attach-self can self-attach a tmux-backed shell without discovery", async () => {
    const softwareTeam = repo.createSoftwareTeam("softwareteam-buildout");
    const node = repo.addNode(softwareTeam.id, "dev1.impl2", { runtime: "claude-code" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logicalId: "dev1.impl2",
        attachmentType: "tmux",
        tmuxSession: "dev1-impl2@softwareteam-buildout",
        tmuxWindow: "@12",
        tmuxPane: "%34",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodeId).toBe(node.id);
    expect(body.attachmentType).toBe("tmux");
    expect(body.env.SOFTWARETEAM_NODE_ID).toBe(node.id);
    expect(body.env.SOFTWARETEAM_SESSION_NAME).toBe("dev1-impl2@softwareteam-buildout");

    const softwareTeamAfter = repo.getSoftwareTeam(softwareTeam.id);
    const attached = softwareTeamAfter?.nodes.find((candidate) => candidate.logicalId === "dev1.impl2");
    expect(attached?.binding?.attachmentType).toBe("tmux");
    expect(attached?.binding?.tmuxSession).toBe("dev1-impl2@softwareteam-buildout");
    expect(attached?.binding?.tmuxWindow).toBe("@12");
    expect(attached?.binding?.tmuxPane).toBe("%34");
    expect(attached?.binding?.externalSessionName).toBeNull();
  });

  it("POST /api/software-teams/:id/attach-self creates a new pod member when podNamespace + memberName are provided", async () => {
    const softwareTeam = repo.createSoftwareTeam("softwareteam-buildout");
    db.prepare("INSERT INTO pods (id, software_team_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-orch1", softwareTeam.id, "orch1", "Orchestrator");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        podNamespace: "orch1",
        memberName: "lead",
        runtime: "claude-code",
        displayName: "orch1-lead@softwareteam-buildout",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.logicalId).toBe("orch1.lead");

    const softwareTeamAfter = repo.getSoftwareTeam(softwareTeam.id);
    const node = softwareTeamAfter?.nodes.find((candidate) => candidate.logicalId === "orch1.lead");
    expect(node).toBeDefined();
    expect(node?.binding?.attachmentType).toBe("external_cli");
  });

  it("POST /api/software-teams/:id/attach-self rejects both logicalId and pod mode together", async () => {
    const softwareTeam = repo.createSoftwareTeam("softwareteam-buildout");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logicalId: "orch1.lead",
        podNamespace: "orch1",
        memberName: "lead",
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("either logicalId");
  });

  it("attach-self still requires a runtime when creating a pod member", async () => {
    const softwareTeam = repo.createSoftwareTeam("missing-pod-runtime");
    db.prepare("INSERT INTO pods (id, software_team_id, namespace, label) VALUES (?, ?, ?, ?)").run("guard-pod", softwareTeam.id, "dev", "Dev");
    const res = await app.request(`/api/software-teams/${softwareTeam.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ podNamespace: "dev", memberName: "worker" }),
    });
    expect(res.status).toBe(400);
    expect(repo.getSoftwareTeam(softwareTeam.id)?.nodes).toHaveLength(0);
  });

  it("POST /api/software-teams/:id/attach-self returns 409 when the target node is already bound", async () => {
    const softwareTeam = repo.createSoftwareTeam("softwareteam-buildout");
    const node = repo.addNode(softwareTeam.id, "orch1.lead", { runtime: "claude-code" });
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "tmux",
      tmuxSession: "orch1-lead@softwareteam-buildout",
    });
    sessionRegistry.registerClaimedSession(node.id, "orch1-lead@softwareteam-buildout");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logicalId: "orch1.lead",
        displayName: "orch1-lead@softwareteam-buildout",
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("already_bound");
  });

  // -- T21: Graph projection endpoint --

  it("GET /api/software-teams/:id/graph -> RF JSON with correct node/edge counts", async () => {
    const softwareTeam = repo.createSoftwareTeam("r01");
    const n1 = repo.addNode(softwareTeam.id, "orchestrator", { role: "orchestrator" });
    const n2 = repo.addNode(softwareTeam.id, "worker", { role: "worker" });
    repo.addEdge(softwareTeam.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/graph`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
  });

  it("GET /api/software-teams/:id/graph -> node.data includes status from session", async () => {
    const softwareTeam = repo.createSoftwareTeam("r01");
    const node = repo.addNode(softwareTeam.id, "dev1-impl", { role: "worker" });
    // Seed session through the app's injected sessionRegistry
    const session = sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/graph`);
    const body = await res.json();
    const nodeData = body.nodes.find((n: { data: { logicalId: string } }) => n.data.logicalId === "dev1-impl");
    expect(nodeData.data.status).toBe("running");
  });

  it("GET /api/software-teams/:id/graph -> node.data carries the honest assigned-work breakdown", async () => {
    const softwareTeam = repo.createSoftwareTeam("r01");
    const node = repo.addNode(softwareTeam.id, "dev.impl", { role: "worker" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@r01");
    sessionRegistry.updateStatus(session.id, "running");
    const ts = "2026-08-28 10:00:00";
    for (const [index, state] of ["pending", "in-progress", "blocked", "done"].entries()) {
      db.prepare(`
        INSERT INTO queue_items
          (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
        VALUES (?, ?, ?, 'op@test', 'dev-impl@r01', ?, 'routine', 'routine', 'body')
      `).run(`q-graph-${index}`, ts, ts, state);
    }

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/graph`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const data = body.nodes.find((n: { data: { logicalId: string } }) => n.data.logicalId === "dev.impl").data;
    expect(data.hasAssignedWork).toBe(true);
    expect(data.assignedWorkCount).toBe(3);
    expect(data.pendingWorkCount).toBe(1);
    expect(data.inProgressWorkCount).toBe(1);
    expect(data.blockedWorkCount).toBe(1);
  });

  it("GET /api/software-teams/:id/graph -> unbound node has binding: null in data", async () => {
    const softwareTeam = repo.createSoftwareTeam("r01");
    repo.addNode(softwareTeam.id, "worker");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/graph`);
    const body = await res.json();
    const nodeData = body.nodes[0];
    expect(nodeData.data).toHaveProperty("binding");
    expect(nodeData.data.binding).toBeNull();
  });

  it("GET /api/software-teams/:id/graph -> nodes have type: 'softwareTeamNode'", async () => {
    const softwareTeam = repo.createSoftwareTeam("r01");
    repo.addNode(softwareTeam.id, "worker");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/graph`);
    const body = await res.json();
    expect(body.nodes[0].type).toBe("softwareTeamNode");
  });

  it("GET /api/software-teams/:id/graph -> RF identity: node.id = opaque PK, edge uses PKs", async () => {
    const softwareTeam = repo.createSoftwareTeam("r01");
    const n1 = repo.addNode(softwareTeam.id, "a");
    const n2 = repo.addNode(softwareTeam.id, "b");
    repo.addEdge(softwareTeam.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/graph`);
    const body = await res.json();

    expect(body.nodes[0].id).toBe(n1.id);
    expect(body.nodes[1].id).toBe(n2.id);
    expect(body.edges[0].source).toBe(n1.id);
    expect(body.edges[0].target).toBe(n2.id);
  });

  it("GET /api/software-teams/:id/graph -> node with no session has status: null", async () => {
    const softwareTeam = repo.createSoftwareTeam("r01");
    repo.addNode(softwareTeam.id, "worker");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/graph`);
    const body = await res.json();
    expect(body.nodes[0].data).toHaveProperty("status");
    expect(body.nodes[0].data.status).toBeNull();
  });

  it("GET /api/software-teams/:id/graph with nonexistent id -> 404", async () => {
    const res = await app.request("/api/software-teams/nonexistent/graph");
    expect(res.status).toBe(404);
  });

  // -- UX-T01b: SoftwareTeam summary endpoint --

  it("GET /api/software-teams/summary -> SoftwareTeam list with node counts", async () => {
    const rig1 = repo.createSoftwareTeam("alpha");
    repo.addNode(rig1.id, "orchestrator", { runtime: "claude-code" });
    repo.addNode(rig1.id, "worker", { runtime: "codex" });

    const rig2 = repo.createSoftwareTeam("beta");
    repo.addNode(rig2.id, "solo", { runtime: "claude-code" });

    const res = await app.request("/api/software-teams/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveLength(2);
    const alpha = body.find((r: { name: string }) => r.name === "alpha");
    const beta = body.find((r: { name: string }) => r.name === "beta");
    expect(alpha.id).toBe(rig1.id);
    expect(alpha.nodeCount).toBe(2);
    expect(beta.id).toBe(rig2.id);
    expect(beta.nodeCount).toBe(1);
  });

  it("summary separates observed agent presence from attention, idle work and infrastructure", async () => {
    const add = (name: string, status: string | null, runtime = "codex", attention = false) => {
      const softwareTeam = repo.createSoftwareTeam(name);
      const node = repo.addNode(softwareTeam.id, "worker", { runtime });
      if (status !== null) {
        const session = sessionRegistry.registerSession(node.id, `worker@${name}`);
        sessionRegistry.updateStatus(session.id, status);
        if (attention) sessionRegistry.updateStartupStatus(session.id, "attention_required");
      }
    };
    add("live-degraded", "running", "codex", true);
    add("idle-prompt", "idle");
    add("stopped", "stopped");
    add("exited", "exited");
    add("unstarted", null);
    add("unknown", "unknown");
    add("infrastructure", "running", "terminal");
    const res = await app.request("/api/software-teams/summary");
    expect(res.status).toBe(200);
    const rows = await res.json();
    const row = (name: string) => rows.find((r: { name: string }) => r.name === name);
    expect(row("live-degraded")).toMatchObject({ hasLiveAgents: true, lifecycleState: "attention_required" });
    expect(row("idle-prompt").hasLiveAgents).toBe(true);
    for (const name of ["stopped", "exited", "unstarted", "infrastructure"]) expect(row(name).hasLiveAgents, name).toBe(false);
    expect(row("unknown").hasLiveAgents).toBeNull();
  });

  it("GET /api/software-teams/summary -> includes hasServices from persisted SoftwareTeam services metadata", async () => {
    const rig1 = repo.createSoftwareTeam("svc-software-team");
    repo.addNode(rig1.id, "worker", { runtime: "claude-code" });
    repo.setServicesRecord(rig1.id, {
      kind: "compose",
      specJson: JSON.stringify({ services: { kind: "compose", compose_file: "svc.compose.yaml" } }),
      softwareTeamRoot: "/tmp",
      composeFile: "svc.compose.yaml",
      projectName: "svc-software-team",
      latestReceiptJson: null,
    });

    const rig2 = repo.createSoftwareTeam("plain-software-team");
    repo.addNode(rig2.id, "worker", { runtime: "claude-code" });

    const res = await app.request("/api/software-teams/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    const svcSoftwareTeam = body.find((r: { name: string }) => r.name === "svc-software-team");
    const plainSoftwareTeam = body.find((r: { name: string }) => r.name === "plain-software-team");
    expect(svcSoftwareTeam.hasServices).toBe(true);
    expect(plainSoftwareTeam.hasServices).toBe(false);
  });

  it("GET /api/software-teams/summary -> multiple snapshots with explicit timestamps, newest wins", async () => {
    const softwareTeam = repo.createSoftwareTeam("gamma");
    repo.addNode(softwareTeam.id, "worker", { runtime: "codex" });

    // Insert snapshots with explicit timestamps to prove newest-wins
    db.prepare(
      "INSERT INTO snapshots (id, software_team_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("snap-old", softwareTeam.id, "manual", "complete", "{}", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, software_team_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("snap-new", softwareTeam.id, "manual", "complete", "{}", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, software_team_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("snap-mid", softwareTeam.id, "manual", "complete", "{}", "2026-03-23 02:00:00");

    const res = await app.request("/api/software-teams/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    const gamma = body.find((r: { name: string }) => r.name === "gamma");
    expect(gamma.latestSnapshotId).toBe("snap-new");
    expect(gamma.latestSnapshotAt).toBe("2026-03-23 03:00:00");
  });

  it("GET /api/software-teams/summary -> no snapshots: both latestSnapshotAt and latestSnapshotId are null", async () => {
    const softwareTeam = repo.createSoftwareTeam("delta");
    repo.addNode(softwareTeam.id, "worker", { runtime: "codex" });

    const res = await app.request("/api/software-teams/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    const delta = body.find((r: { name: string }) => r.name === "delta");
    expect(delta).toBeDefined();
    expect(delta.latestSnapshotAt).toBeNull();
    expect(delta.latestSnapshotId).toBeNull();
  });

  it("GET /api/software-teams/summary -> empty DB returns empty array", async () => {
    const res = await app.request("/api/software-teams/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("GET /api/software-teams/summary -> returns array shape, not software-team-by-id shape (route order guardrail)", async () => {
    // This test proves /summary is not swallowed by /:id
    // If /:id resolves first, "summary" would be treated as a softwareTeam ID
    // and return either a 404 or a software-team-by-id object — not an array
    const res = await app.request("/api/software-teams/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    // Must be an array (summary shape), not an object (software-team-by-id shape or 404 error shape)
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /api/software-teams/summary -> same-second snapshots: no duplicate SoftwareTeam rows, deterministic tiebreak by id", async () => {
    const softwareTeam = repo.createSoftwareTeam("epsilon");
    repo.addNode(softwareTeam.id, "worker", { runtime: "codex" });

    // Two snapshots with identical created_at — ULID "ZZZZ" sorts after "AAAA"
    db.prepare(
      "INSERT INTO snapshots (id, software_team_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("AAAA_snap", softwareTeam.id, "manual", "complete", "{}", "2026-03-23 05:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, software_team_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("ZZZZ_snap", softwareTeam.id, "manual", "complete", "{}", "2026-03-23 05:00:00");

    const res = await app.request("/api/software-teams/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    // Must have exactly one row for epsilon (no duplicates)
    const epsilons = body.filter((r: { name: string }) => r.name === "epsilon");
    expect(epsilons).toHaveLength(1);
    // ZZZZ sorts after AAAA, so ZZZZ_snap should win the tiebreak
    expect(epsilons[0].latestSnapshotId).toBe("ZZZZ_snap");
  });

  // NS-T12: graph route returns enriched data with inventory overlay
  it("GET /api/software-teams/:id/graph returns enriched node data with startupStatus and podId", async () => {
    const softwareTeam = repo.createSoftwareTeam("test-software-team");
    db.prepare("INSERT INTO pods (id, software_team_id, label) VALUES (?, ?, ?)").run("pod-1", softwareTeam.id, "Dev");
    const node = repo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code", podId: "pod-1" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/graph`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Find the enriched node (not the group node)
    const graphNode = body.nodes.find((n: any) => n.data?.logicalId === "dev.impl");
    expect(graphNode).toBeDefined();
    expect(graphNode.data.startupStatus).toBe("ready");
    expect(graphNode.data.podId).toBe("pod-1");
    expect(graphNode.data.canonicalSessionName).toBe("dev-impl@test-software-team");
    expect(graphNode.data.restoreOutcome).toBe("n-a");
    expect(graphNode.data.softwareTeamId).toBeDefined();
    // Group node for pod
    const groupNode = body.nodes.find((n: any) => n.id === "pod-pod-1");
    expect(groupNode).toBeDefined();
    expect(groupNode.type).toBe("podGroup");
    expect(groupNode.data.podLabel).toBe("Dev");
  });

  // NS-T06: POST /api/software-teams/:id/up — power-on from auto-pre-down snapshot
  it("POST /api/software-teams/:id/up returns 404 when no auto-pre-down snapshot exists", async () => {
    const softwareTeam = repo.createSoftwareTeam("no-snap-software-team");
    const res = await app.request(`/api/software-teams/${softwareTeam.id}/up`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("no_snapshot");
  });

  it("POST /api/software-teams/:id/up captures auto-rehydrate snapshot from durable current state", async () => {
    const softwareTeam = repo.createSoftwareTeam("rehydrate-software-team");
    const node = repo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@rehydrate-software-team");
    sessionRegistry.updateStatus(session.id, "stopped");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    insertStartupContextRow(db, node.id);

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/up`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("restored");
    expect(body.snapshotKind).toBe("auto-rehydrate");
    expect(body.warnings).toContain("No restore-usable snapshot existed; captured current DB state as auto-rehydrate snapshot for reboot recovery.");
    const autoRehydrate = db
      .prepare("SELECT kind FROM snapshots WHERE software_team_id = ? AND kind = 'auto-rehydrate'")
      .get(softwareTeam.id) as { kind: string } | undefined;
    expect(autoRehydrate?.kind).toBe("auto-rehydrate");
  });

  it("POST /api/software-teams/:id/up includes softwareTeamResult from restore rollup", async () => {
    const softwareTeam = repo.createSoftwareTeam("restore-software-team");
    const node = repo.addNode(softwareTeam.id, "worker", { role: "worker" });
    const session = sessionRegistry.registerSession(node.id, "worker@restore-software-team");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-restore", "relaunch_fresh", session.id);
    sessionRegistry.updateStatus(session.id, "running");
    snapshotCapture.captureSnapshot(softwareTeam.id, "auto-pre-down");
    sessionRegistry.updateStatus(session.id, "exited");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/up`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("restored");
    expect(body.softwareTeamResult).toBe("partially_restored");
    expect(body.nodes[0].status).toBe("fresh-primed");
  });

  it("POST /api/software-teams/:id/up returns validation blockers as not_attempted", async () => {
    const softwareTeam = repo.createSoftwareTeam("restore-software-team");
    const fixtureNode = repo.addNode(softwareTeam.id, "worker", { role: "worker" });
    const session = sessionRegistry.registerSession(fixtureNode.id, "worker@restore-software-team");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-blocked", "relaunch_fresh", session.id);
    sessionRegistry.updateStatus(session.id, "running");
    const snap = snapshotCapture.captureSnapshot(softwareTeam.id, "auto-pre-down");
    sessionRegistry.updateStatus(session.id, "exited");
    const data = JSON.parse(JSON.stringify(snap.data));
    const node = data.nodes[0];
    const missingPath = `/tmp/softwareteam-slice7-software-teams-missing-${Date.now()}.md`;
    data.nodeStartupContext[node.id] = {
      projectionEntries: [],
      resolvedStartupFiles: [{
        path: "startup.md",
        absolutePath: missingPath,
        ownerRoot: "/tmp",
        deliveryHint: "guidance_merge",
        required: true,
        appliesOn: ["restore"],
      }],
      startupActions: [],
      runtime: "claude-code",
    };
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/up`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("not_attempted");
    expect(body.code).toBe("pre_restore_validation_failed");
    expect(body.softwareTeamResult).toBe("not_attempted");
    expect(body.blockers[0].path).toBe(missingPath);
  });

  it("POST /api/software-teams/:id/up returns 404 for nonexistent softwareTeam", async () => {
    const res = await app.request("/api/software-teams/nonexistent/up", { method: "POST" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("not found");
  });

  // L3b: /:id/up mirrors the software-team-name path: prefer auto-pre-down, fall back to
  // latest restore-usable manual snapshot, echo `snapshotKind`.
  it("L3b: POST /api/software-teams/:id/up falls back to manual snapshot when no auto-pre-down exists; echoes snapshotKind", async () => {
    const softwareTeam = repo.createSoftwareTeam("manual-only-byid");
    repo.addNode(softwareTeam.id, "worker", { role: "worker" });
    snapshotCapture.captureSnapshot(softwareTeam.id, "manual");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/up`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("restored");
    expect(body.snapshotKind).toBe("manual");
  });

  it("L3b: POST /api/software-teams/:id/up prefers auto-pre-down over a newer manual snapshot", async () => {
    const softwareTeam = repo.createSoftwareTeam("auto-pref-byid");
    repo.addNode(softwareTeam.id, "worker", { role: "worker" });
    // Capture order doesn't matter; the helper orders by `(kind = 'auto-pre-down') DESC`.
    snapshotCapture.captureSnapshot(softwareTeam.id, "manual");
    snapshotCapture.captureSnapshot(softwareTeam.id, "auto-pre-down");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/up`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshotKind).toBe("auto-pre-down");
  });

  it("L3b: POST /api/software-teams/:id/up returns 404 with updated 'no restore-usable snapshot' message", async () => {
    const softwareTeam = repo.createSoftwareTeam("no-usable-snap");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/up`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("no_snapshot");
    expect(body.error).toContain("restore-usable");
    expect(body.error).not.toContain("auto-pre-down snapshot");
  });

  // OPR.0.3.4.9 — Option Y: auto-periodic co-equal with auto-pre-down via Explorer /:id/up.
  it("OPR.0.3.4.9 Option Y: stale auto-pre-down + newer auto-periodic -> restores from auto-periodic via /:id/up", async () => {
    const softwareTeam = repo.createSoftwareTeam("option-y-explorer");
    repo.addNode(softwareTeam.id, "worker", { role: "worker" });
    snapshotCapture.captureSnapshot(softwareTeam.id, "auto-pre-down");
    await new Promise((r) => setTimeout(r, 10));
    snapshotCapture.captureSnapshot(softwareTeam.id, "auto-periodic");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/up`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshotKind).toBe("auto-periodic");
  });

  // OPR.0.3.4.4 — the Explorer restore route is INDEPENDENT of /api/up (it
  // parsed no body at all), so plan:true was silently ignored and the route
  // always mutated. These tests pin the daemon-level read-only gate here too.
  describe("OPR.0.3.4.4 --plan read-only restore gate (Explorer /:id/up)", () => {
    it("plan:true returns a read-only preview: restore() NOT called, zero session/snapshot mutation", async () => {
      const softwareTeam = repo.createSoftwareTeam("explorer-plan-software-team");
      const node = repo.addNode(softwareTeam.id, "worker", { role: "worker", runtime: "claude-code" });
      const sess = sessionRegistry.registerSession(node.id, "worker@explorer-plan-software-team");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
        .run("claude_name", "tok-1", "running", sess.id);
      snapshotCapture.captureSnapshot(softwareTeam.id, "auto-pre-down");
      sessionRegistry.updateStatus(sess.id, "detached");
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");
      const sessionsBefore = db.prepare("SELECT * FROM sessions ORDER BY id").all();
      const snapshotsBefore = db.prepare("SELECT * FROM snapshots ORDER BY id").all();
      const bindingsBefore = db.prepare("SELECT * FROM bindings ORDER BY id").all();

      const res = await app.request(`/api/software-teams/${softwareTeam.id}/up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("plan");
      expect(body.mode).toBe("restore");
      expect(body.mutated).toBe(false);
      expect(body.nodes).toHaveLength(1);
      expect(body.nodes[0].intendedAction).toBe("resume-original");
      // THE gate: no restore mutation of any kind.
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessionsBefore);
      expect(db.prepare("SELECT * FROM snapshots ORDER BY id").all()).toEqual(snapshotsBefore);
      expect(db.prepare("SELECT * FROM bindings ORDER BY id").all()).toEqual(bindingsBefore);
    });

    it("plan:true with no usable snapshot reports wouldCaptureCurrentState WITHOUT capturing", async () => {
      const softwareTeam = repo.createSoftwareTeam("explorer-plan-rehydrate");
      const node = repo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@explorer-plan-rehydrate");
      sessionRegistry.updateStatus(session.id, "stopped");
      sessionRegistry.updateStartupStatus(session.id, "failed");
      insertStartupContextRow(db, node.id);
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");

      const res = await app.request(`/api/software-teams/${softwareTeam.id}/up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshot).toBeNull();
      expect(body.wouldCaptureCurrentState).toBe(true);
      const rows = db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE software_team_id = ?").get(softwareTeam.id) as { c: number };
      expect(rows.c).toBe(0);
      expect(restoreSpy).not.toHaveBeenCalled();
    });

    it("APPLY regression: body without plan still restores; bodyless POST unchanged", async () => {
      const softwareTeam = repo.createSoftwareTeam("explorer-apply-software-team");
      repo.addNode(softwareTeam.id, "worker", { role: "worker" });
      snapshotCapture.captureSnapshot(softwareTeam.id, "auto-pre-down");
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");

      const res = await app.request(`/api/software-teams/${softwareTeam.id}/up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: false }),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("restored");
      expect(restoreSpy).toHaveBeenCalledTimes(1);
    });
  });
});
