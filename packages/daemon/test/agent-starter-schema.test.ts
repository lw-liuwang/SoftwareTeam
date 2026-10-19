// Tier 1 schema/normalization/codec proof for the Agent Starter v1
// vertical M1: types.ts adds StarterRefSpec + starterRef? on
// SoftwareTeamSpecPodMember; software-team-spec-schema.ts adds validateStarterRef +
// normalizeStarterRef. The packet enforces three rejection rules at v0:
// (1) starter_ref + session_source.mode="fork"; (2) terminal runtime +
// starter_ref; (3) malformed starter_ref.name. Composition with
// mode="rebuild" is accepted; starter_ref alone is accepted.

import { describe, it, expect } from "vitest";
import { SoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";

function softwareTeamWithMember(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "0.2",
    name: "starter-test-software-team",
    pods: [
      {
        id: "dev",
        label: "Dev",
        members: [
          {
            id: "impl",
            agent_ref: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
            ...overrides,
          },
        ],
        edges: [],
      },
    ],
    edges: [],
  };
}

describe("SoftwareTeamSpec starter_ref schema (M1)", () => {
  // === Acceptance ===

  it("accepts starter_ref alone", () => {
    const softwareTeam = softwareTeamWithMember({ starter_ref: { name: "softwareteam-builder-base--claude-code" } });
    const result = SoftwareTeamSpecSchema.validate(softwareTeam);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts starter_ref + session_source.mode='rebuild' (additive composition allowed)", () => {
    const softwareTeam = softwareTeamWithMember({
      starter_ref: { name: "softwareteam-builder-base--claude-code" },
      session_source: {
        mode: "rebuild",
        ref: { kind: "artifact_set", value: ["/tmp/fixture-artifact.md"] },
      },
    });
    const result = SoftwareTeamSpecSchema.validate(softwareTeam);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // === Codec roundtrip ===

  it("normalize produces starterRef on SoftwareTeamSpecPodMember", () => {
    const softwareTeam = softwareTeamWithMember({ starter_ref: { name: "fixture-starter" } });
    const normalized = SoftwareTeamSpecSchema.normalize(softwareTeam);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.starterRef).toEqual({ name: "fixture-starter" });
  });

  it("normalize is undefined when starter_ref absent (no breakage on existing specs)", () => {
    const softwareTeam = softwareTeamWithMember({});
    const normalized = SoftwareTeamSpecSchema.normalize(softwareTeam);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.starterRef).toBeUndefined();
    // sessionSource also undefined — confirms no cross-contamination.
    expect(member.sessionSource).toBeUndefined();
  });

  it("normalize preserves both starterRef and sessionSource (mode=rebuild) under composition", () => {
    const softwareTeam = softwareTeamWithMember({
      starter_ref: { name: "fixture-starter" },
      session_source: {
        mode: "rebuild",
        ref: { kind: "artifact_set", value: ["/tmp/a.md", "/tmp/b.md"] },
      },
    });
    const normalized = SoftwareTeamSpecSchema.normalize(softwareTeam);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.starterRef).toEqual({ name: "fixture-starter" });
    expect(member.sessionSource).toEqual({
      mode: "rebuild",
      ref: { kind: "artifact_set", value: ["/tmp/a.md", "/tmp/b.md"] },
    });
  });

  // === Rejection: malformed name ===

  it("rejects starter_ref with empty name", () => {
    const softwareTeam = softwareTeamWithMember({ starter_ref: { name: "" } });
    const result = SoftwareTeamSpecSchema.validate(softwareTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("starter_ref.name") && e.includes("non-empty string"))).toBe(true);
  });

  it("rejects starter_ref with non-string name", () => {
    const softwareTeam = softwareTeamWithMember({ starter_ref: { name: 42 } });
    const result = SoftwareTeamSpecSchema.validate(softwareTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("starter_ref.name"))).toBe(true);
  });

  it("rejects starter_ref with disallowed characters in name (path traversal guard)", () => {
    const softwareTeam = softwareTeamWithMember({ starter_ref: { name: "../etc/passwd" } });
    const result = SoftwareTeamSpecSchema.validate(softwareTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("alphanumeric"))).toBe(true);
  });

  it("rejects starter_ref that is not an object", () => {
    const softwareTeam = softwareTeamWithMember({ starter_ref: "fixture-starter" });
    const result = SoftwareTeamSpecSchema.validate(softwareTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("starter_ref") && e.includes("object"))).toBe(true);
  });

  // === Rejection: composition with session_source.mode='fork' ===

  it("REJECTS starter_ref + session_source.mode='fork' (v1+ named-trigger covers this composition)", () => {
    const softwareTeam = softwareTeamWithMember({
      starter_ref: { name: "fixture-starter" },
      session_source: {
        mode: "fork",
        ref: { kind: "native_id", value: "abc-123" },
      },
    });
    const result = SoftwareTeamSpecSchema.validate(softwareTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fork") && e.includes("v1+"))).toBe(true);
  });

  // === Rejection: terminal runtime + starter_ref (secondary cleanup) ===

  it("REJECTS terminal runtime + starter_ref (analogous to terminal session_source rejection)", () => {
    const softwareTeam = softwareTeamWithMember({
      runtime: "terminal",
      agent_ref: "builtin:terminal",
      starter_ref: { name: "fixture-starter" },
    });
    const result = SoftwareTeamSpecSchema.validate(softwareTeam);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("terminal") && e.includes("starter_ref"))).toBe(true);
  });

  // === Forward-compat: existing softwareTeams without starter_ref still validate ===

  it("forward-compat: spec with no starter_ref on any member validates as before", () => {
    const softwareTeam = {
      version: "0.2",
      name: "compat-test",
      pods: [
        {
          id: "dev",
          label: "Dev",
          members: [
            { id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
            { id: "qa", agent_ref: "local:agents/qa", profile: "reviewer", runtime: "codex", cwd: "." },
          ],
          edges: [],
        },
      ],
      edges: [],
    };
    const result = SoftwareTeamSpecSchema.validate(softwareTeam);
    expect(result.valid).toBe(true);
  });
});
