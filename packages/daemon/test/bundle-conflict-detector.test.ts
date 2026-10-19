import { describe, it, expect } from "vitest";
import { detectBundleConflicts, type DetectConflictsInput } from "../src/domain/bundle-conflict-detector.js";

// Item 3 / slice-05 Checkpoint 4.1: bundle-conflict-detector pure-function tests.
// Discriminator pattern: any test that asserts a conflict was reported must
// fail if the corresponding detection branch is commented out in the module.

describe("bundle-conflict-detector — SoftwareTeam name collision", () => {
  // R1: empty running softwareTeams → no conflicts
  it("empty runningSoftwareTeams produces no conflicts", () => {
    const input: DetectConflictsInput = { bundleSoftwareTeamName: "alpha", runningSoftwareTeams: [] };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
    expect(report.conflicts).toHaveLength(0);
  });

  // R2: running softwareTeams with different names → no conflicts
  it("runningSoftwareTeams with different names produces no conflicts", () => {
    const input: DetectConflictsInput = {
      bundleSoftwareTeamName: "alpha",
      runningSoftwareTeams: [
        { softwareTeamId: "01H000000000000000000001", name: "beta" },
        { softwareTeamId: "01H000000000000000000002", name: "gamma" },
      ],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
  });

  // R3: running softwareTeam with same name → conflict reported with correct shape
  it("running SoftwareTeam with same name produces a software_team_name_collision conflict", () => {
    const input: DetectConflictsInput = {
      bundleSoftwareTeamName: "alpha",
      runningSoftwareTeams: [
        { softwareTeamId: "01H000000000000000000003", name: "alpha" },
      ],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts).toHaveLength(1);
    const c = report.conflicts[0]!;
    expect(c.kind).toBe("software_team_name_collision");
    expect(c.bundleSoftwareTeamName).toBe("alpha");
    if (c.kind === "software_team_name_collision") {
      expect(c.collisionWith.softwareTeamId).toBe("01H000000000000000000003");
      expect(c.collisionWith.softwareTeamName).toBe("alpha");
      expect(c.description).toContain("alpha");
      expect(c.description).toContain("01H000000000000000000003");
      expect(c.resolutions.length).toBeGreaterThanOrEqual(2);
      expect(c.resolutions.join("\n")).toContain("existing team");
      expect(c.resolutions.join("\n")).toContain("SoftwareTeam down");
      expect(c.resolutions.join("\n")).not.toMatch(/Checkpoint|--force|--target <newname>/);
    }
  });

  // R4: collision detected even when other softwareTeams precede the match
  it("collision found in a list with multiple softwareTeams, only the matching one reported", () => {
    const input: DetectConflictsInput = {
      bundleSoftwareTeamName: "alpha",
      runningSoftwareTeams: [
        { softwareTeamId: "01H000000000000000000004", name: "beta" },
        { softwareTeamId: "01H000000000000000000005", name: "gamma" },
        { softwareTeamId: "01H000000000000000000006", name: "alpha" },
        { softwareTeamId: "01H000000000000000000007", name: "delta" },
      ],
    };
    const report = detectBundleConflicts(input);
    expect(report.conflicts).toHaveLength(1);
    if (report.conflicts[0]!.kind === "software_team_name_collision") {
      expect(report.conflicts[0]!.collisionWith.softwareTeamId).toBe("01H000000000000000000006");
    }
  });

  // R5: empty bundleSoftwareTeamName produces no conflict (fail-open on missing input)
  it("empty bundleSoftwareTeamName produces no conflict (no SoftwareTeam name = nothing to compare)", () => {
    const input: DetectConflictsInput = {
      bundleSoftwareTeamName: "",
      runningSoftwareTeams: [{ softwareTeamId: "01H000000000000000000008", name: "alpha" }],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
  });

  // R6: case sensitivity — collision is exact-name match only
  it("name match is case-sensitive (case mismatch = no collision)", () => {
    const input: DetectConflictsInput = {
      bundleSoftwareTeamName: "alpha",
      runningSoftwareTeams: [{ softwareTeamId: "01H000000000000000000009", name: "Alpha" }],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
  });
});
