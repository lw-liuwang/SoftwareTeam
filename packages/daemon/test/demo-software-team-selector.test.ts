import { describe, expect, it } from "vitest";
import {
  filterNodesForSoftwareTeamId,
  selectCurrentSoftwareTeamSummary,
} from "../src/domain/demo-software-team-selector.js";

describe("demo SoftwareTeam selector", () => {
  it("returns the unique current SoftwareTeam summary for a given name", () => {
    expect(
      selectCurrentSoftwareTeamSummary(
        [
          { softwareTeamId: "software-team-1", name: "demo-software-team" },
          { softwareTeamId: "software-team-2", name: "other-software-team" },
        ],
        "demo-software-team"
      )
    ).toEqual({ softwareTeamId: "software-team-1", name: "demo-software-team" });
  });

  it("returns null when the SoftwareTeam name is absent", () => {
    expect(selectCurrentSoftwareTeamSummary([{ softwareTeamId: "software-team-1", name: "demo-software-team" }], "missing")).toBeNull();
  });

  it("fails loudly when multiple running softwareTeams share the same name", () => {
    expect(() =>
      selectCurrentSoftwareTeamSummary(
        [
          { softwareTeamId: "software-team-1", name: "demo-software-team" },
          { softwareTeamId: "software-team-2", name: "demo-software-team" },
        ],
        "demo-software-team"
      )
    ).toThrow(/ambiguous/);
  });

  it("prefers the unique running SoftwareTeam over stopped softwareTeams with the same name", () => {
    expect(
      selectCurrentSoftwareTeamSummary(
        [
          { softwareTeamId: "old", name: "demo-software-team", status: "stopped" },
          { softwareTeamId: "new", name: "demo-software-team", status: "running" },
        ],
        "demo-software-team"
      )
    ).toEqual({ softwareTeamId: "new", name: "demo-software-team", status: "running" });
  });

  it("filters node inventory by SoftwareTeam id rather than SoftwareTeam name", () => {
    expect(
      filterNodesForSoftwareTeamId(
        [
          { softwareTeamId: "old", logicalId: "dev.impl" },
          { softwareTeamId: "new", logicalId: "dev.impl" },
          { softwareTeamId: "new", logicalId: "dev.qa" },
        ],
        "new"
      )
    ).toEqual([
      { softwareTeamId: "new", logicalId: "dev.impl" },
      { softwareTeamId: "new", logicalId: "dev.qa" },
    ]);
  });
});
