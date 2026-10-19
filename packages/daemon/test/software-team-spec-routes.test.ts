import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import type { SoftwareTeamSpecExporter } from "../src/domain/software-team-spec-exporter.js";
import { LegacySoftwareTeamSpecCodec as SoftwareTeamSpecCodec } from "../src/domain/software-team-spec-codec.js"; // TODO: AS-T08b — migrate to pod-aware SoftwareTeamSpec
import { SoftwareTeamSpecCodec as PodSoftwareTeamSpecCodec } from "../src/domain/software-team-spec-codec.js";
import { SoftwareTeamSpecSchema as PodSoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { migrate } from "../src/db/migrate.js";
import { workspacePrimitiveSchema } from "../src/db/migrations/038_workspace_primitive.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createDaemon } from "../src/startup.js";
import { SoftwareTeamSpecExporter as SoftwareTeamSpecExporterClass } from "../src/domain/software-team-spec-exporter.js";
import { SoftwareTeamInstantiator } from "../src/domain/software-team-spec-instantiator.js";
import { SoftwareTeamSpecPreflight } from "../src/domain/software-team-spec-preflight.js";
import { SoftwareTeamRepository as SoftwareTeamRepoClass } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createApp } from "../src/server.js";
import type { ExecFn } from "../src/adapters/tmux.js";

const VALID_YAML = `
schema_version: 1
name: r99
version: 1.0.0
nodes:
  - id: worker
    runtime: claude-code
    role: worker
    cwd: /
edges: []
`;

const INVALID_YAML = `
name: ""
version: ""
nodes: bad
`;

describe("Rigspec export routes", () => {
  let db: Database.Database;
  let app: Hono;
  let softwareTeamRepo: SoftwareTeamRepository;

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [workspacePrimitiveSchema]);
    const setup = createTestApp(db);
    app = setup.app;
    softwareTeamRepo = setup.softwareTeamRepo;
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/software-teams/:softwareTeamId/spec -> 200 + YAML content-type", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r99");
    softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/spec`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/yaml");
    const text = await res.text();
    expect(text).toContain("r99");
  });

  it("GET /api/software-teams/:softwareTeamId/spec.json -> 200 + JSON", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r99");
    softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/spec.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("r99");
    expect(body.nodes).toHaveLength(1);
  });

  it("GET /api/software-teams/:softwareTeamId/spec preserves a persisted pod-aware workspace", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("workspace-software-team");
    const pod = new PodRepository(db).createPod(softwareTeam.id, "dev", "Dev");
    softwareTeamRepo.addNode(softwareTeam.id, "dev.worker", {
      runtime: "claude-code",
      podId: pod.id,
      agentRef: "local:agents/worker",
      profile: "default",
      cwd: "/workspace/app",
    });
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

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/spec`);
    expect(res.status).toBe(200);
    const parsed = PodSoftwareTeamSpecCodec.parse(await res.text());
    expect(PodSoftwareTeamSpecSchema.validate(parsed).valid).toBe(true);
    expect(PodSoftwareTeamSpecSchema.normalize(parsed as Record<string, unknown>).workspace).toEqual(workspace);
  });

  it("GET nonexistent SoftwareTeam -> 404", async () => {
    const res = await app.request("/api/software-teams/nonexistent/spec");
    expect(res.status).toBe(404);
  });

  it("export internal error for corrupted SoftwareTeam -> 500", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r99");
    // Insert node with no runtime via raw SQL
    db.prepare("INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)")
      .run("bad-node", softwareTeam.id, "broken");

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/spec`);
    expect(res.status).toBe(500);
  });
});

describe("Rigspec import routes", () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => {
    db.close();
  });

  it("POST /api/software-teams/import valid YAML -> 201 + InstantiateResult", async () => {
    const res = await app.request("/api/software-teams/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.softwareTeamId).toBeDefined();
    expect(body.specName).toBe("r99");
    expect(body.nodes).toHaveLength(1);
  });

  it("POST /api/software-teams/import invalid YAML -> 400", async () => {
    const res = await app.request("/api/software-teams/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: INVALID_YAML,
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/software-teams/import preflight failure -> 409", async () => {
    // Create name collision
    const setup = createTestApp(db);
    setup.softwareTeamRepo.createSoftwareTeam("r99");

    const res = await setup.app.request("/api/software-teams/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/software-teams/import/validate -> 200 + ValidationResult", async () => {
    const res = await app.request("/api/software-teams/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it("POST /api/software-teams/import/validate invalid YAML -> 400", async () => {
    const res = await app.request("/api/software-teams/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not: [valid: yaml: {{{",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/software-teams/import/preflight -> 200 + PreflightResult", async () => {
    const res = await app.request("/api/software-teams/import/preflight", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ready");
    expect(body).toHaveProperty("errors");
    expect(body).toHaveProperty("warnings");
  });

  it("POST /api/software-teams/import/preflight invalid YAML -> 400", async () => {
    const res = await app.request("/api/software-teams/import/preflight", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not: [valid: yaml: {{{",
    });
    expect(res.status).toBe(400);
  });
});

describe("Rigspec wiring", () => {
  it("startup mounts software-team-spec routes (createDaemon regression)", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };
    const { app, db, deps } = await createDaemon({ tmuxExec, cmuxExec });
    const softwareTeam = deps.softwareTeamRepo.createSoftwareTeam("r99");
    deps.softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });

    const res = await app.request(`/api/software-teams/${softwareTeam.id}/spec.json`);
    expect(res.status).toBe(200);
    db.close();
  });

  it("createApp throws on mismatched exporter db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();
    const goodDeps = createTestApp(db1);
    const otherRepo = new SoftwareTeamRepoClass(db2);
    const otherRegistry = new SessionRegistry(db2);
    const badExporter = new SoftwareTeamSpecExporterClass({ softwareTeamRepo: otherRepo, sessionRegistry: otherRegistry });

    expect(() => createApp({
      ...extractDeps(goodDeps),
      softwareTeamSpecExporter: badExporter,
    })).toThrow(/softwareTeamSpecExporter.*same db handle/);
    db1.close();
    db2.close();
  });

  it("createApp throws on mismatched instantiator db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();
    const goodDeps = createTestApp(db1);
    expect(() => createApp({
      ...extractDeps(goodDeps),
      softwareTeamInstantiator: { db: db2 } as any,
    })).toThrow(/softwareTeamInstantiator.*same db handle/);
    db1.close();
    db2.close();
  });

  it("createApp throws on mismatched preflight db handle", () => {
    const db1 = createFullTestDb();
    const db2 = createFullTestDb();
    const goodDeps = createTestApp(db1);
    expect(() => createApp({
      ...extractDeps(goodDeps),
      softwareTeamSpecPreflight: { db: db2 } as any,
    })).toThrow(/softwareTeamSpecPreflight.*same db handle/);
    db1.close();
    db2.close();
  });

  it("startup constructs all Phase 3 deps", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };
    const { app, db } = await createDaemon({ tmuxExec, cmuxExec });

    // Import route is mounted (proves instantiator + preflight wired)
    const res = await app.request("/api/software-teams/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(200);
    db.close();
  });

  it("round-trip: export then import produces equivalent softwareTeam", async () => {
    const db1 = createFullTestDb();
    const setup = createTestApp(db1);
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("r99");
    setup.softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code", role: "worker" });

    // Export
    const exportRes = await setup.app.request(`/api/software-teams/${softwareTeam.id}/spec`);
    const yaml = await exportRes.text();

    // Import into fresh app
    const db2 = createFullTestDb();
    const setup2 = createTestApp(db2);
    const importRes = await setup2.app.request("/api/software-teams/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: yaml,
    });
    expect(importRes.status).toBe(201);
    const body = await importRes.json();
    expect(body.specName).toBe("r99");
    expect(body.nodes).toHaveLength(1);

    db1.close();
    db2.close();
  });
});

const POD_AWARE_YAML = `
version: "0.2"
name: pod-software-team
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: /tmp
    edges: []
edges: []
`;

const WORKSPACE_ONLY_YAML = `
version: "0.2"
name: workspace-declaration
workspace:
  workspace_root: /workspace
  repos:
    - name: app
      path: app
      kind: project
    - name: docs
      path: /workspace/docs
      kind: knowledge
  default_repo: app
  knowledge_root: /workspace/docs
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        # Deliberately invalid unrelated topology: workspace-only apply ignores it.
        agent_ref: ""
        profile: none
        runtime: terminal
        cwd: /workspace/app
    edges: []
edges: []
`;

const INVALID_POD_YAML = `
version: "0.2"
name: bad
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`;

const MATERIALIZE_POD_YAML = `
version: "0.2"
name: live-topology
pods:
  - id: research
    label: Research
    members:
      - id: scout
        agent_ref: "builtin:terminal"
        profile: none
        runtime: terminal
        cwd: /tmp
    edges: []
edges: []
`;

const MATERIALIZE_RELATIVE_CWD_YAML = `
version: "0.2"
name: cwd-override-topology
pods:
  - id: research
    label: Research
    members:
      - id: scout
        agent_ref: "builtin:terminal"
        profile: none
        runtime: terminal
        cwd: /softwareteam-install-should-not-be-used
    edges: []
edges: []
`;

const MATERIALIZE_FRAGMENT_YAML = `
version: "0.2"
name: research-fragment
pods:
  - id: research
    label: Research
    members:
      - id: scout
        agent_ref: "builtin:terminal"
        profile: none
        runtime: terminal
        cwd: /tmp
    edges: []
edges:
  - kind: delegates_to
    from: orch.lead
    to: research.scout
`;

describe("Rigspec import routes (pod-aware dual-stack)", () => {
  let db: Database.Database;
  let app: Hono;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [workspacePrimitiveSchema]);
    const setup = createTestApp(db);
    app = setup.app;
    softwareTeamRepo = setup.softwareTeamRepo;
    sessionRegistry = setup.sessionRegistry;
  });

  afterEach(() => {
    db.close();
  });

  // T3: validate endpoint auto-detects pod-aware format
  it("POST /api/software-teams/import/validate with pod-aware YAML returns valid:true", async () => {
    const res = await app.request("/api/software-teams/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: POD_AWARE_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it("POST /api/software-teams/import/validate rejects an unknown topology key with its exact path and consequence", async () => {
    const res = await app.request("/api/software-teams/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: POD_AWARE_YAML.replace('name: pod-software-team', 'name: pod-software-team\noperating_mod: lab'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors).toContain(
      'operating_mod: unknown key "operating_mod"; refusing the spec because normalization would otherwise discard it and alter the requested topology',
    );
  });

  // T4: validate endpoint with invalid pod-aware YAML returns errors
  it("POST /api/software-teams/import/validate with invalid pod-aware YAML returns errors", async () => {
    const res = await app.request("/api/software-teams/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: INVALID_POD_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  // T5: validate still works for legacy YAML
  it("POST /api/software-teams/import/validate still works for legacy YAML", async () => {
    const res = await app.request("/api/software-teams/import/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  // T7: import pod-aware spec without X-Software-Team-Root returns 400
  it("POST /api/software-teams/import with pod-aware YAML but no X-Software-Team-Root returns 400", async () => {
    const res = await app.request("/api/software-teams/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: POD_AWARE_YAML,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("missing_software_team_root");
  });

  it("POST /api/software-teams/import returns 409 and preserves compose project conflict guidance", async () => {
    const message = "Replacement has multiple predecessor Compose projects (old-a: project-a; old-b: project-b). Set services.project_name in the SoftwareTeam spec YAML to the project you intend to use, then re-run the same command. No services were started.";
    const routeApp = createTestApp(db, {
      appDeps: {
        podInstantiator: {
          db,
          instantiate: async () => ({ ok: false, code: "compose_project_conflict", message }),
        } as never,
      },
    }).app;

    const res = await routeApp.request("/api/software-teams/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Software-Team-Root": "/tmp" },
      body: POD_AWARE_YAML,
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("compose_project_conflict");
    expect(body.error).toBe(message);
    expect(body.message).toBe(message);
  });

  // T8: preflight pod-aware spec without X-Software-Team-Root returns 400
  it("POST /api/software-teams/import/preflight with pod-aware YAML but no X-Software-Team-Root returns 400", async () => {
    const res = await app.request("/api/software-teams/import/preflight", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: POD_AWARE_YAML,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.errors).toContain("X-Software-Team-Root header required for pod-aware specs");
  });

  // T9: legacy import still works through dual-stack
  it("POST /api/software-teams/import with legacy YAML still creates softwareTeam", async () => {
    const res = await app.request("/api/software-teams/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VALID_YAML,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.softwareTeamId).toBeDefined();
    expect(body.specName).toBe("r99");
  });

  it("POST /api/software-teams/import/workspace changes only workspace_json and is idempotent", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("host-software-team");
    const pod = new PodRepository(db).createPod(softwareTeam.id, "dev", "Dev");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", {
      runtime: "terminal",
      podId: pod.id,
      agentRef: "builtin:terminal",
      profile: "none",
      cwd: "/workspace/app",
    });
    sessionRegistry.registerSession(node.id, "dev-impl@host-software-team");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "dev-impl@host-software-team" });

    const topology = () => ({
      pods: db.prepare("SELECT * FROM pods WHERE software_team_id = ? ORDER BY id").all(softwareTeam.id),
      nodes: db.prepare("SELECT * FROM nodes WHERE software_team_id = ? ORDER BY id").all(softwareTeam.id),
      edges: db.prepare("SELECT * FROM edges WHERE software_team_id = ? ORDER BY id").all(softwareTeam.id),
      sessions: db.prepare("SELECT s.* FROM sessions s JOIN nodes n ON n.id = s.node_id WHERE n.software_team_id = ? ORDER BY s.id").all(softwareTeam.id),
      bindings: db.prepare("SELECT b.* FROM bindings b JOIN nodes n ON n.id = b.node_id WHERE n.software_team_id = ? ORDER BY b.id").all(softwareTeam.id),
    });
    const before = topology();

    const first = await app.request("/api/software-teams/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-software-team-Id": softwareTeam.id },
      body: WORKSPACE_ONLY_YAML,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ softwareTeamId: softwareTeam.id, changed: true });
    expect(topology()).toEqual(before);
    expect(softwareTeamRepo.getSoftwareTeamWorkspace(softwareTeam.id)).toEqual({
      workspaceRoot: "/workspace",
      repos: [
        { name: "app", path: "/workspace/app", kind: "project" },
        { name: "docs", path: "/workspace/docs", kind: "knowledge" },
      ],
      defaultRepo: "app",
      knowledgeRoot: "/workspace/docs",
    });
    const afterFirst = db.prepare("SELECT workspace_json, updated_at FROM software_teams WHERE id = ?").get(softwareTeam.id);

    const second = await app.request("/api/software-teams/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-software-team-Id": softwareTeam.id },
      body: WORKSPACE_ONLY_YAML,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ softwareTeamId: softwareTeam.id, changed: false });
    expect(db.prepare("SELECT workspace_json, updated_at FROM software_teams WHERE id = ?").get(softwareTeam.id)).toEqual(afterFirst);
    expect(topology()).toEqual(before);

    const exported = await app.request(`/api/software-teams/${softwareTeam.id}/spec`);
    expect(exported.status).toBe(200);
    expect(PodSoftwareTeamSpecSchema.normalize(PodSoftwareTeamSpecCodec.parse(await exported.text()) as Record<string, unknown>).workspace)
      .toEqual(softwareTeamRepo.getSoftwareTeamWorkspace(softwareTeam.id));
  });

  it("POST /api/software-teams/import/workspace fails before mutation for invalid input or target", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("host-software-team");
    const original = {
      workspaceRoot: "/original",
      repos: [{ name: "original", path: "/original", kind: "project" as const }],
      defaultRepo: "original",
    };
    softwareTeamRepo.setSoftwareTeamWorkspace(softwareTeam.id, original);
    const preimage = db.prepare("SELECT workspace_json, updated_at FROM software_teams WHERE id = ?").get(softwareTeam.id);

    const invalidDefault = await app.request("/api/software-teams/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-software-team-Id": softwareTeam.id },
      body: WORKSPACE_ONLY_YAML.replace("default_repo: app", "default_repo: missing"),
    });
    expect(invalidDefault.status).toBe(400);
    expect(await invalidDefault.json()).toMatchObject({ code: "validation_failed" });

    const invalidRepo = await app.request("/api/software-teams/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-software-team-Id": softwareTeam.id },
      body: WORKSPACE_ONLY_YAML.replace("kind: project", "kind: executable"),
    });
    expect(invalidRepo.status).toBe(400);
    expect(await invalidRepo.json()).toMatchObject({ code: "validation_failed" });

    const missingWorkspace = await app.request("/api/software-teams/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-software-team-Id": softwareTeam.id },
      body: POD_AWARE_YAML,
    });
    expect(missingWorkspace.status).toBe(400);
    expect(await missingWorkspace.json()).toMatchObject({ code: "workspace_required" });

    const missingTarget = await app.request("/api/software-teams/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml" },
      body: WORKSPACE_ONLY_YAML,
    });
    expect(missingTarget.status).toBe(400);
    expect(await missingTarget.json()).toMatchObject({ code: "target_software_team_required" });

    const unknownTarget = await app.request("/api/software-teams/import/workspace", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Target-software-team-Id": "missing" },
      body: WORKSPACE_ONLY_YAML,
    });
    expect(unknownTarget.status).toBe(404);
    expect(await unknownTarget.json()).toMatchObject({ code: "target_software_team_not_found" });

    expect(db.prepare("SELECT workspace_json, updated_at FROM software_teams WHERE id = ?").get(softwareTeam.id)).toEqual(preimage);
    expect(softwareTeamRepo.listSoftwareTeams()).toHaveLength(1);
  });

  it("POST /api/software-teams/import/materialize creates SoftwareTeam structure without launching", async () => {
    const res = await app.request("/api/software-teams/import/materialize", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Software-Team-Root": "/tmp" },
      body: MATERIALIZE_POD_YAML,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.softwareTeamId).toBeDefined();
    expect(body.nodes).toEqual([{ logicalId: "research.scout", status: "materialized" }]);
  });

  it("POST /api/software-teams/import/materialize honors X-Cwd-Override", async () => {
    const setup = createTestApp(db);
    const res = await setup.app.request("/api/software-teams/import/materialize", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Software-Team-Root": "/tmp", "X-Cwd-Override": "/tmp" },
      body: MATERIALIZE_RELATIVE_CWD_YAML,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const softwareTeam = setup.softwareTeamRepo.getSoftwareTeam(body.softwareTeamId);
    expect(softwareTeam?.nodes.find((node) => node.logicalId === "research.scout")?.cwd).toBe("/tmp");
  });

  it("POST /api/software-teams/import/materialize can target an existing softwareTeam", async () => {
    const setup = createTestApp(db);
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("host-software-team");
    setup.softwareTeamRepo.addNode(softwareTeam.id, "orch.lead", { runtime: "claude-code", cwd: "/tmp" });

    const res = await setup.app.request("/api/software-teams/import/materialize", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Software-Team-Root": "/tmp",
        "X-Target-software-team-Id": softwareTeam.id,
      },
      body: MATERIALIZE_FRAGMENT_YAML,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.softwareTeamId).toBe(softwareTeam.id);
    expect(body.nodes).toEqual([{ logicalId: "research.scout", status: "materialized" }]);
  });
});

function extractDeps(setup: ReturnType<typeof createTestApp>) {
  return {
    softwareTeamRepo: setup.softwareTeamRepo,
    sessionRegistry: setup.sessionRegistry,
    eventBus: setup.eventBus,
    nodeLauncher: setup.nodeLauncher,
    tmuxAdapter: (setup as any).tmuxAdapter ?? setup.app,
    cmuxAdapter: (setup as any).cmuxAdapter ?? setup.app,
    snapshotCapture: setup.snapshotCapture,
    snapshotRepo: setup.snapshotRepo,
    restoreOrchestrator: setup.restoreOrchestrator,
    softwareTeamSpecExporter: setup.softwareTeamSpecExporter,
    softwareTeamSpecPreflight: setup.softwareTeamSpecPreflight,
    softwareTeamInstantiator: setup.softwareTeamInstantiator,
    podInstantiator: (setup as any).podInstantiator,
    podBundleSourceResolver: (setup as any).podBundleSourceResolver,
  };
}
