import { describe, it, expect } from "vitest";
import { buildLedgerExplorer } from "../src/crash-cart/ledger-explorer.js";

// Crash-cart shell-placement rework (ruling 3c6c2be0) — daemon-down the explorer sidebar is ALWAYS
// present but LEDGER-FED (from the SAME one-JSON discovery — softwareTeams+seats — never a second read path) and
// HONESTLY MARKED as ledger-sourced (the founder's honesty requirement). This is the ledger-explorer
// model the in-pane split's left column renders.

describe("buildLedgerExplorer — ledger-fed SoftwareTeam sidebar (honestly marked)", () => {
  it("one row per SoftwareTeam from the discovery, with seat count, and an honest ledger marker", () => {
    const led = buildLedgerExplorer([
      { name: "softwareteam-pm", seatCount: 13 },
      { name: "kernel", seatCount: 4 },
    ]);
    expect(led.ledgerSourced).toBe(true);
    expect(led.note.toLowerCase()).toContain("ledger"); // honestly marked ledger-sourced
    expect(led.rows.map((r) => r.softwareTeamName)).toEqual(["softwareteam-pm", "kernel"]);
    expect(led.rows[0]).toMatchObject({ softwareTeamName: "softwareteam-pm", seatCount: 13 });
    expect(led.rows[0]!.label).toContain("softwareteam-pm");
  });

  it("empty discovery → no rows, still honestly marked (first-run / no softwareTeams)", () => {
    const led = buildLedgerExplorer([]);
    expect(led.rows).toEqual([]);
    expect(led.ledgerSourced).toBe(true);
    expect(led.note.toLowerCase()).toContain("ledger");
  });
});
