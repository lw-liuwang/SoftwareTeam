import { describe, it, expect } from "vitest";
import { SoftwareTeamSpecCodec, LegacySoftwareTeamSpecCodec } from "../src/domain/software-team-spec-codec.js";
import { SoftwareTeamSpecSchema, LegacySoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import type { SoftwareTeamSpec, LegacySoftwareTeamSpec } from "../src/domain/types.js";

const VALID_SOFTWARE_TEAM: SoftwareTeamSpec = {
  version: "0.2",
  name: "dev-software-team",
  summary: "Dev softwareTeam",
  cultureFile: "culture.md",
  pods: [
    {
      id: "dev",
      label: "Development",
      members: [
        { id: "impl", agentRef: "local:agents/impl", profile: "tdd", runtime: "claude-code", cwd: "." },
        { id: "qa", agentRef: "local:agents/qa", profile: "reviewer", runtime: "codex", cwd: "." },
      ],
      edges: [{ kind: "can_observe", from: "qa", to: "impl" }],
    },
  ],
  edges: [],
};

describe("SoftwareTeamSpec codec (pod-aware)", () => {
  it("serialize -> parse -> validate round-trips", () => {
    const yaml = SoftwareTeamSpecCodec.serialize(VALID_SOFTWARE_TEAM);
    const parsed = SoftwareTeamSpecCodec.parse(yaml);
    const validation = SoftwareTeamSpecSchema.validate(parsed);
    expect(validation.valid).toBe(true);

    const normalized = SoftwareTeamSpecSchema.normalize(parsed as Record<string, unknown>);
    expect(normalized.name).toBe("dev-software-team");
    expect(normalized.cultureFile).toBe("culture.md");
    expect(normalized.pods).toHaveLength(1);
    expect(normalized.pods[0]!.members).toHaveLength(2);
    expect(normalized.pods[0]!.edges).toHaveLength(1);
  });

  it("round-trips explicit role orientation through softwareTeam, pod and member startup", () => {
    const spec = structuredClone(VALID_SOFTWARE_TEAM);
    const startup = { files: [{ path: "role.md", orientation: "role" as const, deliveryHint: "send_text" as const, required: true, appliesOn: ["fresh_start" as const] }], actions: [] };
    spec.startup = startup;
    spec.pods[0].startup = startup;
    spec.pods[0].members[0].startup = startup;
    const parsed = SoftwareTeamSpecCodec.parse(SoftwareTeamSpecCodec.serialize(spec)) as Record<string, unknown>;
    expect(SoftwareTeamSpecSchema.validate(parsed).valid).toBe(true);
    const result = SoftwareTeamSpecSchema.normalize(parsed);
    for (const block of [result.startup, result.pods[0].startup, result.pods[0].members[0].startup]) {
      expect(block?.files[0].orientation).toBe("role");
    }
  });

  it("preserves pod/member/edge ordering", () => {
    const yaml = SoftwareTeamSpecCodec.serialize(VALID_SOFTWARE_TEAM);
    const parsed = SoftwareTeamSpecCodec.parse(yaml) as Record<string, unknown>;
    const pods = parsed["pods"] as Array<Record<string, unknown>>;
    expect(pods[0]!["id"]).toBe("dev");
    const members = pods[0]!["members"] as Array<Record<string, unknown>>;
    expect(members[0]!["id"]).toBe("impl");
    expect(members[1]!["id"]).toBe("qa");
  });

  it("culture_file round-trips through serialize/parse", () => {
    const yaml = SoftwareTeamSpecCodec.serialize(VALID_SOFTWARE_TEAM);
    expect(yaml).toContain("culture_file: culture.md");
    const parsed = SoftwareTeamSpecCodec.parse(yaml) as Record<string, unknown>;
    expect(parsed["culture_file"]).toBe("culture.md");
  });

  it("member effort round-trips through serialize/parse/normalize", () => {
    const softwareTeamWithEffort: SoftwareTeamSpec = {
      version: "0.2",
      name: "effort-test",
      pods: [{
        id: "dev",
        label: "Dev",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "tdd", runtime: "claude-code", cwd: ".", effort: "high" }],
        edges: [],
      }],
      edges: [],
    };

    const yaml = SoftwareTeamSpecCodec.serialize(softwareTeamWithEffort);
    expect(yaml).toContain("effort: high");
    const parsed = SoftwareTeamSpecCodec.parse(yaml) as Record<string, unknown>;
    const normalized = SoftwareTeamSpecSchema.normalize(parsed);
    expect(normalized.pods[0]!.members[0]!.effort).toBe("high");
  });

  it("loads YAML with member effort through validation, normalization, and serializes back", () => {
    const rawYaml = `
version: "0.2"
name: yaml-effort-software-team
pods:
  - id: dev
    label: Development
    members:
      - id: seat-a
        agent_ref: local:agents/impl
        profile: tdd
        runtime: claude-code
        effort: low
        cwd: .
      - id: seat-b
        agent_ref: local:agents/qa
        profile: reviewer
        runtime: codex
        effort: xhigh
        cwd: .
    edges: []
edges: []
`;
    const parsed = SoftwareTeamSpecCodec.parse(rawYaml) as Record<string, unknown>;
    const val = SoftwareTeamSpecSchema.validate(parsed);
    expect(val.valid).toBe(true);

    const normalized = SoftwareTeamSpecSchema.normalize(parsed);
    expect(normalized.pods[0]!.members[0]!.effort).toBe("low");
    expect(normalized.pods[0]!.members[1]!.effort).toBe("xhigh");

    const reserialized = SoftwareTeamSpecCodec.serialize(normalized);
    expect(reserialized).toContain("effort: low");
    expect(reserialized).toContain("effort: xhigh");

    const reparsed = SoftwareTeamSpecCodec.parse(reserialized) as Record<string, unknown>;
    const renorm = SoftwareTeamSpecSchema.normalize(reparsed);
    expect(renorm.pods[0]!.members[0]!.effort).toBe("low");
    expect(renorm.pods[0]!.members[1]!.effort).toBe("xhigh");
  });

  // R1: continuity_policy nested booleans round-trip through serialize -> parse -> normalize
  it("continuity_policy nested booleans round-trip correctly", () => {
    const softwareTeamWithCp: SoftwareTeamSpec = {
      version: "0.2",
      name: "cp-test",
      pods: [{
        id: "dev",
        label: "Dev",
        continuityPolicy: {
          enabled: true,
          syncTriggers: ["pre_compaction", "manual"],
          artifacts: { sessionLog: true, restoreBrief: false, quiz: true },
          restoreProtocol: { peerDriven: true, verifyViaQuiz: false },
        },
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "tdd", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
      edges: [],
    };

    const yaml = SoftwareTeamSpecCodec.serialize(softwareTeamWithCp);
    const parsed = SoftwareTeamSpecCodec.parse(yaml) as Record<string, unknown>;
    const normalized = SoftwareTeamSpecSchema.normalize(parsed);

    const cp = normalized.pods[0]!.continuityPolicy!;
    expect(cp.enabled).toBe(true);
    expect(cp.syncTriggers).toEqual(["pre_compaction", "manual"]);
    expect(cp.artifacts!.sessionLog).toBe(true);
    expect(cp.artifacts!.restoreBrief).toBe(false);
    expect(cp.artifacts!.quiz).toBe(true);
    expect(cp.restoreProtocol!.peerDriven).toBe(true);
    expect(cp.restoreProtocol!.verifyViaQuiz).toBe(false);
  });

  it("legacy codec still serializes/parses old flat specs", () => {
    const legacySpec = {
      schemaVersion: 1, name: "test", version: "1.0",
      nodes: [{ id: "impl", runtime: "claude-code" }],
      edges: [],
    };
    const yaml = LegacySoftwareTeamSpecCodec.serialize(legacySpec);
    expect(yaml).toContain("schema_version: 1");
    const parsed = LegacySoftwareTeamSpecCodec.parse(yaml) as Record<string, unknown>;
    expect(parsed["name"]).toBe("test");
  });

  // Agent Starter v1 vertical M1 R2 — codec roundtrip for `starter_ref`.
  // Guard finding: the M1 R1 commit normalized snake-case input into
  // `member.starterRef` but the canonical pod-aware serializer never
  // wrote `starter_ref` back out. The forward-compat smoke at
  // pod-software-team-spec-instantiator was therefore a false proof. R2 fix: emit
  // `starter_ref` in `SoftwareTeamSpecCodec.serialize()` and assert the wire
  // shape end-to-end (serialize → parse → validate → normalize).
  it("starter_ref round-trips through serialize → parse → validate → normalize (R2)", () => {
    const spec: SoftwareTeamSpec = {
      ...VALID_SOFTWARE_TEAM,
      pods: [
        {
          id: "dev",
          label: "Development",
          members: [
            {
              id: "impl",
              agentRef: "local:agents/impl",
              profile: "default",
              runtime: "claude-code",
              cwd: ".",
              starterRef: { name: "softwareteam-builder-base--claude-code" },
            },
          ],
          edges: [],
        },
      ],
    };

    // Serialize → wire shape MUST contain starter_ref:
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    expect(yaml).toContain("starter_ref:");
    expect(yaml).toContain("softwareteam-builder-base--claude-code");

    // Parse → validate
    const parsed = SoftwareTeamSpecCodec.parse(yaml);
    const validation = SoftwareTeamSpecSchema.validate(parsed);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    // Normalize → starterRef preserved with the seed shape
    const normalized = SoftwareTeamSpecSchema.normalize(parsed);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.starterRef).toEqual({ name: "softwareteam-builder-base--claude-code" });
  });

  it("starter_ref + session_source.mode='rebuild' both survive roundtrip (composition allowed)", () => {
    const spec: SoftwareTeamSpec = {
      ...VALID_SOFTWARE_TEAM,
      pods: [
        {
          id: "dev",
          label: "Development",
          members: [
            {
              id: "impl",
              agentRef: "local:agents/impl",
              profile: "default",
              runtime: "claude-code",
              cwd: ".",
              starterRef: { name: "fixture-starter" },
              sessionSource: {
                mode: "rebuild",
                ref: { kind: "artifact_set", value: ["/tmp/fixture.md"] },
              },
            },
          ],
          edges: [],
        },
      ],
    };

    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    expect(yaml).toContain("starter_ref:");
    expect(yaml).toContain("session_source:");
    expect(yaml).toContain("rebuild");

    const parsed = SoftwareTeamSpecCodec.parse(yaml);
    const validation = SoftwareTeamSpecSchema.validate(parsed);
    expect(validation.valid).toBe(true);

    const normalized = SoftwareTeamSpecSchema.normalize(parsed);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.starterRef).toEqual({ name: "fixture-starter" });
    expect(member.sessionSource).toEqual({
      mode: "rebuild",
      ref: { kind: "artifact_set", value: ["/tmp/fixture.md"] },
    });
  });

  it("specs with no starter_ref roundtrip cleanly (no spurious field emitted)", () => {
    const yaml = SoftwareTeamSpecCodec.serialize(VALID_SOFTWARE_TEAM);
    expect(yaml).not.toContain("starter_ref:");
  });
});

describe("LegacySoftwareTeamSpecCodec", () => {
  it("legacy node effort round-trips through serialize/parse/normalize", () => {
    const legacySoftwareTeam: LegacySoftwareTeamSpec = {
      schemaVersion: 1,
      name: "legacy-effort-software-team",
      version: "1.0.0",
      nodes: [
        {
          id: "worker",
          runtime: "claude-code",
          model: "claude-3-7-sonnet-20250219",
          effort: "high",
          cwd: "/workspace",
        },
      ],
      edges: [],
    };

    const yaml = LegacySoftwareTeamSpecCodec.serialize(legacySoftwareTeam);
    expect(yaml).toContain("effort: high");

    const parsed = LegacySoftwareTeamSpecCodec.parse(yaml);
    const validation = LegacySoftwareTeamSpecSchema.validate(parsed);
    expect(validation.valid).toBe(true);

    const normalized = LegacySoftwareTeamSpecSchema.normalize(parsed);
    expect(normalized.nodes[0]!.effort).toBe("high");
  });
});
