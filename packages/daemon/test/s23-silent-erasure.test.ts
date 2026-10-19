// OPR.0.5.6.23 — silent-erasure remint (locked spec; desk territory ruling
// 22:22Z extends member-b to the routes/agent-images.ts fork memberFragment
// seam). Census: s23-session-source-leg-census.md beside this file.
//
// Member (a): the codec serialize leg drops session_source.ref.version — a pin
// that survives expand (post-S03) vanishes on a spec round-trip (the WAVE 1 R2
// HOLD shape). Disclosed third member at the same seam: parse carries
// compaction_strategy, serialize never emits it. Member (b): the fork-ingress
// memberFragment drops node-carried model/role/restore_policy/label — a forked
// seat silently loses its model pin (the 0.4.6.PI1 failure class).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { SoftwareTeamSpecCodec } from "../src/domain/software-team-spec-codec.js";
import { SoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import type { SoftwareTeamSpec, SoftwareTeamSpecPodMember, SoftwareTeamServicesSpec, SessionSourceSpec } from "../src/domain/types.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";
import type { PodSoftwareTeamInstantiator } from "../src/domain/pod-software-team-spec-instantiator.js";

function softwareTeamWith(member: Partial<SoftwareTeamSpecPodMember> & { id: string }): SoftwareTeamSpec {
  return {
    version: "0.2",
    name: "s23-software-team",
    summary: "s23",
    cultureFile: "culture.md",
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        agentRef: "local:agents/impl",
        profile: "tdd",
        runtime: "claude-code",
        cwd: ".",
        ...member,
      } as SoftwareTeamSpecPodMember],
      edges: [],
    }],
    edges: [],
  };
}

function roundTripMember(member: Partial<SoftwareTeamSpecPodMember> & { id: string }): { yaml: string; member: SoftwareTeamSpecPodMember } {
  const yaml = SoftwareTeamSpecCodec.serialize(softwareTeamWith(member));
  const parsed = SoftwareTeamSpecCodec.parse(yaml);
  const validation = SoftwareTeamSpecSchema.validate(parsed);
  expect(validation.errors, `round-trip must stay schema-valid: ${validation.errors?.join("; ")}`).toEqual([]);
  const normalized = SoftwareTeamSpecSchema.normalize(parsed as Record<string, unknown>);
  return { yaml, member: normalized.pods[0]!.members[0]! };
}

describe("OPR.0.5.6.23 member (a) — codec round-trip preserves every optional sessionSource field", () => {
  it("RT-VERSION: session_source.ref.version survives serialize -> parse -> normalize, and the YAML itself carries the key", () => {
    const input: SessionSourceSpec = { mode: "agent_image", ref: { kind: "image_name", value: "starter", version: "1.2.3" } };
    const { yaml, member } = roundTripMember({ id: "impl", sessionSource: input });
    // base RED: serialize emits kind/value only — version re-parses undefined
    expect(member.sessionSource).toEqual(input);
    expect(yaml).toContain("version: 1.2.3"); // absence in every encoding: the YAML carries it
  });

  it("KEYSET-PIN: for every union arm carrying every optional field, the serialized ref key-set equals the input ref key-set", () => {
    const arms: SessionSourceSpec[] = [
      { mode: "fork", ref: { kind: "native_id", value: "tok-1" } },
      { mode: "rebuild", ref: { kind: "artifact_set", value: ["a.md", "b.md"] } },
      { mode: "agent_image", ref: { kind: "image_name", value: "img", version: "7" } },
    ];
    for (const input of arms) {
      const { yaml, member } = roundTripMember({ id: "impl", sessionSource: input });
      expect(member.sessionSource, `arm ${input.mode}`).toEqual(input);
      const parsed = SoftwareTeamSpecCodec.parse(yaml) as { pods: Array<{ members: Array<Record<string, unknown>> }> };
      const rawRef = (parsed.pods[0]!.members[0]!["session_source"] as { ref: Record<string, unknown> }).ref;
      expect(Object.keys(rawRef).sort(), `arm ${input.mode}: no ref key may silently vanish`)
        .toEqual(Object.keys(input.ref).sort());
    }
  });

  it("RT-COMPACTION (disclosed third member, same seam): member compaction_strategy survives the round-trip", () => {
    // canonical vocabulary (agent-manifest.ts VALID_COMPACTION_STRATEGIES);
    // a deprecated alias would be normalized on parse and mask the pin.
    const { yaml, member } = roundTripMember({ id: "impl", compactionStrategy: "managed-compaction" });
    // base RED: schema parse carries it (:1058), the serialize leg never emits it
    expect(member.compactionStrategy).toBe("managed-compaction");
    expect(yaml).toContain("compaction_strategy: managed-compaction");
  });
});

describe("OPR.0.5.6.23 member (c) — the codec emits the optional top-level services family (desk ruling, transition 45061)", () => {
  // Same class as member (a): parse accepts+normalizes services
  // (software-team-spec-schema :109/:197), serialize omits it — export-YAML -> re-import
  // silently drops the whole block. Fixture populates EVERY optional services
  // field; the pin is explicit key/value preservation, never mere presence.
  const servicesInput: SoftwareTeamServicesSpec = {
    kind: "compose",
    composeFile: "services/compose.yaml",
    projectName: "s23svc",
    profiles: ["dev", "ci"],
    downPolicy: "down_and_volumes",
    waitFor: [
      { service: "db", condition: "healthy" },
      { url: "http://localhost:8080/healthz" },
      { tcp: "localhost:5432" },
    ],
    surfaces: {
      urls: [{ name: "app", url: "http://localhost:3000" }],
      commands: [{ name: "psql", command: "psql -h localhost -p 5432" }],
    },
    checkpoints: [
      { id: "db-dump", exportCommand: "pg_dump app > dump.sql", importCommand: "psql app < dump.sql" },
      { id: "export-only", exportCommand: "tar cf state.tar state/" },
    ],
  };

  it("RT-SERVICES: a nontrivial services family survives serialize -> YAML -> parse -> normalize with every key and value intact", () => {
    const spec: SoftwareTeamSpec = { ...softwareTeamWith({ id: "impl" }), services: servicesInput };
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const parsed = SoftwareTeamSpecCodec.parse(yaml) as Record<string, unknown>;
    const validation = SoftwareTeamSpecSchema.validate(parsed);
    expect(validation.errors, `round-trip must stay schema-valid: ${validation.errors?.join("; ")}`).toEqual([]);
    // base RED: serialize reads no spec.services — the YAML has no services key
    const rawServices = parsed["services"] as Record<string, unknown> | undefined;
    expect(rawServices, "the serialized YAML must carry the services block").toBeDefined();
    expect(Object.keys(rawServices ?? {}).sort(), "no services key may silently vanish").toEqual(
      ["checkpoints", "compose_file", "down_policy", "kind", "profiles", "project_name", "surfaces", "wait_for"]
    );
    const normalized = SoftwareTeamSpecSchema.normalize(parsed);
    // value-level pin: deep-equal, not presence — the whole family round-trips
    expect(normalized.services).toEqual(servicesInput);
  });
});

describe("OPR.0.5.6.23 member (b) — fork-ingress memberFragment forwards every node-carried optional field", () => {
  let tmp: string;
  let specRoot: string;
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "s23-fork-"));
    specRoot = join(tmp, "specs");
    mkdirSync(specRoot, { recursive: true });
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    softwareTeamRepo = new SoftwareTeamRepository(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("FORK-FRAGMENT: a source seat's model, role, restore_policy, and label ride the fork (the model pin is the 0.4.6.PI1 class)", async () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("src-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", {
      runtime: "claude-code",
      cwd: "/work",
      agentRef: "local:agents/impl",
      profile: "default",
      model: "claude-opus-5",
      role: "worker",
      restorePolicy: "resume_if_possible",
      label: "Implementer",
    });
    const sessionId = ulid();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'live', ?)")
      .run(sessionId, node.id, "dev-impl@src-software-team", new Date().toISOString());
    db.prepare("UPDATE sessions SET resume_token = 'tok-native-1', resume_type = 'claude_id' WHERE id = ?")
      .run(sessionId);

    const addMember = vi.fn(async () => ({
      ok: true as const,
      result: { podId: "p1", podNamespace: "dev", node: { logicalId: "dev.forked", nodeId: "n2", status: "launched" as const, sessionName: "forked@dst" } },
    }));
    const app = new Hono();
    const podInstantiator = { addMemberToPod: addMember } as unknown as PodSoftwareTeamInstantiator;
    app.use("*", async (c, next) => {
      c.set("db" as never, db);
      c.set("podInstantiator" as never, podInstantiator);
      await next();
    });
    app.route("/api/agent-images", agentImagesRoutes({ specRoots: () => [specRoot] }));

    const res = await app.request("/api/agent-images/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "dev-impl@src-software-team", softwareTeamId: "dst-software-team", pod: "dev", member: "forked" }),
    });
    expect(res.status).toBe(201);
    expect(addMember).toHaveBeenCalledTimes(1);
    const fragment = addMember.mock.calls[0]![2] as Record<string, unknown>;
    // base RED: the fragment forwards only runtime/agent_ref/profile/cwd/
    // codex_config_profile/permission_policy — these four are dropped.
    expect(fragment["model"]).toBe("claude-opus-5");
    expect(fragment["role"]).toBe("worker");
    expect(fragment["restore_policy"]).toBe("resume_if_possible");
    expect(fragment["label"]).toBe("Implementer");
    // and the previously forwarded fields still ride (regression floor)
    expect(fragment["agent_ref"]).toBe("local:agents/impl");
    expect(fragment["session_source"]).toMatchObject({ mode: "fork", ref: { kind: "native_id", value: "tok-native-1" } });
  });
});
