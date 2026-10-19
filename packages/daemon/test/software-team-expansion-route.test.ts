import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("POST /api/software-teams/:softwareTeamId/expand", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function seedSoftwareTeam(name = "test-software-team") {
    return setup.softwareTeamRepo.createSoftwareTeam(name);
  }

  function terminalPod(id = "infra", memberId = "server") {
    return {
      id,
      label: "Infrastructure",
      members: [
        { id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
  }

  // Seam B (R2 terminal at 4ac243c3): present-INVALID permission_policy must reach the
  // ONE canonical validator — the normalizer may not erase presence into absence/floor.
  it("SEAM-B RED: expansion member permission_policy: null -> structured 400, ZERO persistence, NO launch (SoftwareTeam carries builtin:yolo)", async () => {
    const softwareTeam = seedSoftwareTeam("null-policy-software-team");
    setup.softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:yolo");
    setup.softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, { origin: "builtin", resolvedTarget: "policies/builtin/yolo.policy.md", declaringDir: null, launchPosture: "full_bypass" });
    const res = await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev2", label: "Dev2", members: [
        { id: "late", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp", permission_policy: null },
      ], edges: [] } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/permission_policy/);
    // zero persistence: no member node, no session, no edges for the rejected pod
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'dev2.%'").get()).toMatchObject({ c: 0 });
  });

  it("SEAM-B RED: another present-invalid shape (number) is also a structured 400, never coerced/erased", async () => {
    const softwareTeam = seedSoftwareTeam("num-policy-software-team");
    const res = await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev3", label: "Dev3", members: [
        { id: "late", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp", permission_policy: 42 },
      ], edges: [] } }),
    });
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'dev3.%'").get()).toMatchObject({ c: 0 });
  });

  it("SEAM-B control: a VALID string permission_policy and TRUE absence both keep working through expansion", async () => {
    const softwareTeam = seedSoftwareTeam("valid-policy-software-team");
    const ok = await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev4", label: "Dev4", members: [
        { id: "server", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ], edges: [] } }),
    });
    expect(ok.status).toBe(201);
  });

  // T1: Valid expansion -> 201
  it("returns 201 with ok result for valid expansion", async () => {
    const softwareTeam = seedSoftwareTeam();
    const res = await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.podNamespace).toBe("infra");
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].logicalId).toBe("infra.server");
  });

  // T2: Nonexistent softwareTeam -> 404
  it("returns 404 for nonexistent softwareTeam", async () => {
    const res = await setup.app.request("/api/software-teams/nonexistent/expand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });
    expect(res.status).toBe(404);
  });

  // T3: Duplicate namespace -> 409
  it("returns 409 for duplicate pod namespace", async () => {
    const softwareTeam = seedSoftwareTeam();
    await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("infra") }),
    });

    const res = await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("infra", "server2") }),
    });
    expect(res.status).toBe(409);
  });

  // T4: Launch failure -> 207
  it("returns 207 for expansion with launch failure", async () => {
    const softwareTeam = seedSoftwareTeam();
    const tmux = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    tmux.createSession.mockResolvedValueOnce({ ok: false, code: "unknown", message: "tmux not available" });

    const res = await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(["partial", "failed"]).toContain(body.status);
  });

  // T5: Exactly one softwareTeam.expanded event
  it("emits exactly one softwareTeam.expanded event", async () => {
    const softwareTeam = seedSoftwareTeam();
    await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const events = db.prepare("SELECT type FROM events WHERE type = 'softwareTeam.expanded'").all() as Array<{ type: string }>;
    expect(events).toHaveLength(1);
  });

  // T6: Missing body -> 400
  it("returns 400 for missing pod in body", async () => {
    const softwareTeam = seedSoftwareTeam();
    const res = await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // T7a: softwareTeam.expanded in events table
  it("softwareTeam.expanded event contains correct payload", async () => {
    const softwareTeam = seedSoftwareTeam();
    await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const events = db.prepare("SELECT payload FROM events WHERE type = 'softwareTeam.expanded'").all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.softwareTeamId).toBe(softwareTeam.id);
    expect(payload.podNamespace).toBe("infra");
    expect(payload.status).toBe("ok");
  });

  // T7b: Detail events (pod.created, node.added) also emitted
  it("detail events (pod.created, node.added) emitted during expansion", async () => {
    const softwareTeam = seedSoftwareTeam();
    await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const podEvents = db.prepare("SELECT type FROM events WHERE type = 'pod.created'").all();
    const nodeEvents = db.prepare("SELECT type FROM events WHERE type = 'node.added'").all();
    expect(podEvents.length).toBeGreaterThanOrEqual(1);
    expect(nodeEvents.length).toBeGreaterThanOrEqual(1);
  });

  // T8: Cross-pod edges -> 201
  it("expansion with cross-pod edges returns 201", async () => {
    const softwareTeam = seedSoftwareTeam();
    // First pod
    await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("orch", "lead") }),
    });

    // Second pod with cross-pod edge
    const res = await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: terminalPod("dev", "impl"),
        crossPodEdges: [{ kind: "delegates_to", from: "orch.lead", to: "dev.impl" }],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("expansion with edge from new pod to existing node launches only the new node", async () => {
    const softwareTeam = seedSoftwareTeam();
    await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("backend", "api") }),
    });

    const res = await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: terminalPod("ops", "monitor"),
        crossPodEdges: [{ kind: "delegates_to", from: "ops.monitor", to: "backend.api" }],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].logicalId).toBe("ops.monitor");
  });

  it("accepts spec-style snake_case member fields in pod fragments", async () => {
    const softwareTeam = seedSoftwareTeam();
    const res = await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "qa",
          label: "QA",
          members: [
            {
              id: "reviewer",
              runtime: "terminal",
              agent_ref: "builtin:terminal",
              profile: "none",
              cwd: "/tmp",
              restore_policy: "checkpoint_only",
            },
          ],
          edges: [],
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodes[0].logicalId).toBe("qa.reviewer");
    const stored = db
      .prepare("SELECT agent_ref, restore_policy FROM nodes WHERE software_team_id = ? AND logical_id = ?")
      .get(softwareTeam.id, "qa.reviewer") as { agent_ref: string; restore_policy: string } | undefined;
    expect(stored?.agent_ref).toBe("builtin:terminal");
    expect(stored?.restore_policy).toBe("checkpoint_only");
  });

  // OPR.0.5.6.3 repair (wave-1 R2 HOLD): the route normalizer recognized only
  // fork/rebuild and silently dropped the entire agent_image session source
  // BEFORE the service mapper could preserve ref.version — the landed S03
  // service test exercised SoftwareTeamExpansionService directly and bypassed this
  // ingress. These pins ride the REAL HTTP route and observe the
  // service/materialized-spec boundary (the materializeStructured argument).
  it("agent_image session_source with a version pin survives the real expand ingress to the materialized spec", async () => {
    const softwareTeam = seedSoftwareTeam("image-pin-software-team");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "img",
          label: "Imaged",
          members: [
            {
              id: "worker",
              runtime: "claude-code",
              agent_ref: "local:agents/impl",
              profile: "default",
              cwd: "/tmp",
              session_source: { mode: "agent_image", ref: { kind: "image_name", value: "builder-base", version: "3" } },
            },
          ],
          edges: [],
        },
      }),
    });

    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const member = specObject.pods[0]!.members[0]!;
    expect(member["session_source"]).toEqual({
      mode: "agent_image",
      ref: { kind: "image_name", value: "builder-base", version: "3" },
    });
    materializeSpy.mockRestore();
  });

  it("unversioned agent_image session_source survives the ingress with NO version key invented", async () => {
    const softwareTeam = seedSoftwareTeam("image-unpinned-software-team");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "img2",
          label: "Imaged2",
          members: [
            {
              id: "worker",
              runtime: "claude-code",
              agent_ref: "local:agents/impl",
              profile: "default",
              cwd: "/tmp",
              session_source: { mode: "agent_image", ref: { kind: "image_name", value: "builder-base" } },
            },
          ],
          edges: [],
        },
      }),
    });

    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const member = specObject.pods[0]!.members[0]!;
    expect(member["session_source"]).toEqual({
      mode: "agent_image",
      ref: { kind: "image_name", value: "builder-base" },
    });
    materializeSpy.mockRestore();
  });

  it("valid numeric version coerces to string per schema parity", async () => {
    const softwareTeam = seedSoftwareTeam("image-numeric-software-team");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "imgnum",
          label: "X",
          members: [
            { id: "w", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", session_source: { mode: "agent_image", ref: { kind: "image_name", value: "ok", version: 3 } } },
          ],
          edges: [],
        },
      }),
    });
    // numeric version COERCES to string — schema parity (software-team-spec-schema.ts
    // validates string|number and normalizes with String(versionRaw);
    // orch-lead ruling 2026-08-28 12:06Z: string-only omission would
    // recreate the silent-default defect for YAML `version: 3`)
    const spec = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    expect(spec.pods[0]!.members[0]!["session_source"]).toEqual({ mode: "agent_image", ref: { kind: "image_name", value: "ok", version: "3" } });
    materializeSpy.mockRestore();
  });

  // S03 repair amendment (R2 governing HOLD): present-INVALID agent_image
  // shapes must reach the ONE canonical validator and fail structured —
  // never be erased into session_source-absence, which silently widens an
  // invalid request into an unpinned/no-source expansion (the SEAM-B
  // presence-preservation law applied to session_source).
  it("present-invalid agent_image shapes reach the canonical validator: structured 400, zero persistence, never erased into absence", async () => {
    const softwareTeam = seedSoftwareTeam("image-invalid-software-team");
    const post = (sessionSource: unknown, podId: string) =>
      setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pod: {
            id: podId,
            label: "X",
            members: [
              { id: "w", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", session_source: sessionSource },
            ],
            edges: [],
          },
        }),
      });

    const cases: Array<[unknown, string]> = [
      [{ mode: "agent_image", ref: { kind: "image_name", value: "" } }, "inv1"],
      [{ mode: "agent_image", ref: { kind: "image_id", value: "x" } }, "inv2"],
      [{ mode: "agent_image", ref: { kind: "image_name", value: "ok", version: { pin: 3 } } }, "inv3"],
      [{ mode: "agent_image", ref: { kind: "image_name", value: "ok", version: true } }, "inv4"],
    ];
    for (const [sessionSource, podId] of cases) {
      const res = await post(sessionSource, podId);
      expect(res.status, `${podId} must fail structured validation, not expand`).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body), `${podId} error must name session_source`).toMatch(/session_source/);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE ?").get(`${podId}.%`),
        `${podId} must persist nothing`,
      ).toMatchObject({ c: 0 });
    }
  });

  // S03 final presence amendment: the invariant is KEY PRESENCE, not a list of
  // malformed shapes. ANY present session_source value — a mode-only object, a
  // null/non-object ref, a primitive, or null itself — must reach the canonical
  // validator and fail structured; only a truly absent key stays absent.
  it("presence invariant: mode-only, ref:null, primitive, and null session_source all reach the canonical validator (400 naming session_source, zero persistence)", async () => {
    const softwareTeam = seedSoftwareTeam("presence-invariant-software-team");
    const post = (sessionSource: unknown, podId: string) =>
      setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pod: {
            id: podId,
            label: "P",
            members: [
              { id: "w", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", session_source: sessionSource },
            ],
            edges: [],
          },
        }),
      });

    const cases: Array<[unknown, string]> = [
      [{ mode: "agent_image" }, "pres1"],
      [{ mode: "agent_image", ref: null }, "pres2"],
      [{ mode: "agent_image", ref: "builder-base" }, "pres3"],
      ["builder-base", "pres4"],
      [null, "pres5"],
      [{ mode: "snapshot", ref: { kind: "image_name", value: "x" } }, "pres6"],
    ];
    for (const [sessionSource, podId] of cases) {
      const res = await post(sessionSource, podId);
      expect(res.status, `${podId} must fail structured validation, never erase into absence`).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body), `${podId} error must name session_source`).toMatch(/session_source/);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE ?").get(`${podId}.%`),
        `${podId} must persist nothing`,
      ).toMatchObject({ c: 0 });
    }
  });
});
