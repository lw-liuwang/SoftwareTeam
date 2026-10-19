import { describe, it, expect } from "vitest";
import {
  deriveSessionName,
  deriveCanonicalSessionName,
  validateSessionName,
  validateSessionNameChars,
  validateSessionComponents,
} from "../src/domain/session-name.js";

describe("session-name", () => {
  it.each([
    ["dev@alias", "impl", "pod name"],
    ["dev", "impl@alias", "member name"],
  ])("rejects @ in a session component: %s / %s", (pod, member, label) => {
    expect(validateSessionComponents(pod, member, "my-software-team")).toEqual([
      expect.stringContaining(`${label} must not contain "@"`),
    ]);
  });

  it("keeps @ valid in SoftwareTeam names after the canonical session separator", () => {
    expect(validateSessionComponents("dev", "impl", "my@software-team")).toEqual([]);
    const session = deriveCanonicalSessionName("dev", "impl", "my@software-team");
    expect(session).toBe("dev-impl@my@software-team");
    expect(validateSessionName(session)).toBe(true);
  });

  // Existing legacy tests
  it("preserves managed SoftwareTeam stems that already match rNN-", () => {
    expect(deriveSessionName("r01", "orchestrator")).toBe("r01-orchestrator");
    expect(validateSessionName("r01-orchestrator")).toBe(true);
  });

  it("normalizes ordinary SoftwareTeam names into a managed r00- stem", () => {
    const derived = deriveSessionName("qa-dogfood-software-team", "dev");
    expect(derived).toBe("r00-qa-dogfood-software-team-dev");
    expect(validateSessionName(derived)).toBe(true);
  });

  // NS-T01 tests

  // Test 1: deriveCanonicalSessionName produces {pod}-{member}@{softwareTeam}
  it("deriveCanonicalSessionName produces canonical {pod}-{member}@{softwareTeam} format", () => {
    expect(deriveCanonicalSessionName("dev", "impl", "auth-feats")).toBe("dev-impl@auth-feats");
    expect(deriveCanonicalSessionName("orch1", "lead", "softwareteam-buildout")).toBe("orch1-lead@softwareteam-buildout");
    expect(deriveCanonicalSessionName("rev", "r1", "my.softwareTeam")).toBe("rev-r1@my.softwareTeam");
  });

  // Test 2: deriveSessionName legacy path preserved
  it("deriveSessionName legacy path still works for flat softwareTeams", () => {
    expect(deriveSessionName("qa-software-team", "worker")).toBe("r00-qa-software-team-worker");
    expect(deriveSessionName("r01", "dev")).toBe("r01-dev");
  });

  // Test 3: validateSessionName accepts both legacy and canonical formats
  it("validateSessionName accepts both legacy r\\d{2}- and canonical @-containing names", () => {
    // Legacy
    expect(validateSessionName("r01-foo")).toBe(true);
    expect(validateSessionName("r00-my-software-team-worker")).toBe(true);
    // Canonical
    expect(validateSessionName("dev-impl@auth-feats")).toBe(true);
    expect(validateSessionName("orch1-lead@softwareteam-buildout")).toBe(true);
    // Invalid
    expect(validateSessionName("")).toBe(false);
    expect(validateSessionName("no-format-at-all")).toBe(false);
    expect(validateSessionName("has spaces@software-team")).toBe(false);
    expect(validateSessionName("dev-impl@software-team with spaces")).toBe(false);
  });

  // Test 4: validateSessionNameChars rejects invalid chars with per-character error
  it("validateSessionNameChars rejects invalid characters with specific error", () => {
    expect(validateSessionNameChars("valid-name_1", "pod name")).toBeNull();
    expect(validateSessionNameChars("has.dot", "pod name")).toBeNull(); // dots allowed

    const err = validateSessionNameChars("my pod!", "pod name");
    expect(err).not.toBeNull();
    expect(err).toContain("pod name");
    expect(err).toContain("!");
    expect(err).toContain("a-z, A-Z, 0-9, -, _, ., @");

    const spaceErr = validateSessionNameChars("has space", "member name");
    expect(spaceErr).not.toBeNull();
    expect(spaceErr).toContain("member name");
    expect(spaceErr).toContain(" ");
  });

  // Test 5: @ present in canonical derivation, passes validateSessionName
  it("canonical session name with @ passes validateSessionName", () => {
    const name = deriveCanonicalSessionName("dev", "impl", "auth-feats");
    expect(name).toContain("@");
    expect(validateSessionName(name)).toBe(true);
  });

  // Test 6: validateSessionComponents rejects empty components
  it("validateSessionComponents rejects empty pod/member/SoftwareTeam with helpful error", () => {
    const emptyPod = validateSessionComponents("", "impl", "my-software-team");
    expect(emptyPod.length).toBeGreaterThan(0);
    expect(emptyPod[0]).toContain("pod");
    expect(emptyPod[0]).toContain("empty");

    const emptyMember = validateSessionComponents("dev", "", "my-software-team");
    expect(emptyMember.length).toBeGreaterThan(0);
    expect(emptyMember[0]).toContain("member");

    const emptySoftwareTeam = validateSessionComponents("dev", "impl", "");
    expect(emptySoftwareTeam.length).toBeGreaterThan(0);
    expect(emptySoftwareTeam[0]).toContain("softwareTeam");

    // Valid
    expect(validateSessionComponents("dev", "impl", "auth-feats")).toEqual([]);
  });
});
