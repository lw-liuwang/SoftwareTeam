// OPR.0.5.0 — `SoftwareTeam ps --nodes` HONEST SCOPE METADATA. The current-software-team-only default is CORRECT and
// STAYS; the fix DECLARES the scope so a scoped list is never read as the whole host (the width-clip
// honesty rule applied to CLI output: output that silently looks complete is silent loss).
// Verified via a STUB client (the DaemonClient http harness is pre-existing-broken in this env —
// res.json() "position 4", the Atom-5/S-C CLI-harness flake class).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { psCommand } from "../src/commands/ps.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

const RIGS_MULTI = [
  { softwareTeamId: "rA", softwareTeamName: "alpha", name: "alpha" },
  { softwareTeamId: "rB", softwareTeamName: "beta", name: "beta" },
  { softwareTeamId: "rC", softwareTeamName: "gamma", name: "gamma" },
];
const RIGS_SINGLE = [{ softwareTeamId: "rA", softwareTeamName: "alpha", name: "alpha" }];
// LIVE-CLASS coherence fixture (review50-r1 finding @ fb8c8dcc): 4 softwareTeams on host, but `SoftwareTeam ps`'s
// bare-default header renders the ACTIVE projection (stopped fold into a count line) — so an honest
// "1 of N" must count the 2 ACTIVE softwareTeams the operator sees when they follow the hint, never all 4.
const RIGS_MIXED = [
  { softwareTeamId: "rA", softwareTeamName: "alpha", name: "alpha", status: "running" }, // session softwareTeam (active)
  { softwareTeamId: "rB", softwareTeamName: "beta", name: "beta", status: "running" },
  { softwareTeamId: "rC", softwareTeamName: "gamma", name: "gamma", status: "stopped" },
  { softwareTeamId: "rD", softwareTeamName: "delta", name: "delta", status: "stopped" },
];
const NODE = { softwareTeamId: "rA", softwareTeamName: "alpha", logicalId: "dev.impl", canonicalSessionName: "dev-impl@alpha", lifecycleState: "running", sessionStatus: "running", agentActivity: null, hasAssignedWork: false, pendingWorkCount: 0 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubClientFactory(softwareTeams: any[]) {
  return () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: async (path: string) => {
      if (path.startsWith("/api/ps")) return { status: 200, data: softwareTeams };
      if (path.includes("/nodes")) return { status: 200, data: [NODE] };
      return { status: 200, data: [] };
    },
  }) as never;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deps(softwareTeams: any[]): any {
  return {
    lifecycleDeps: { spawn: () => ({ pid: 1, unref() {} }), fetch: async () => ({ ok: true }), kill: () => true, readFile: (p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port: 1, db: "x", startedAt: "x" }) : null), writeFile() {}, removeFile() {}, exists: (p: string) => p === STATE_FILE, mkdirp() {}, openForAppend: () => 3, isProcessAlive: () => true },
    clientFactory: stubClientFactory(softwareTeams),
  };
}
async function run(args: string[], softwareTeams: unknown[]): Promise<{ out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const ol = console.log, oe = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  try { await psCommand(deps(softwareTeams) as any).parseAsync(["node", "softwareTeam", ...args]); }
  finally { console.log = ol; console.error = oe; }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("SoftwareTeam ps --nodes honest scope metadata", () => {
  beforeEach(() => { process.env.SOFTWARETEAM_SESSION_NAME = "dev-impl@alpha"; }); // session softwareTeam = alpha
  afterEach(() => { delete process.env.SOFTWARETEAM_SESSION_NAME; });

  it("MULTI-SOFTWARE_TEAM: --nodes --json gains a parseable scope object {softwareTeam, softwareTeamsOnHost, hint}", async () => {
    const { out } = await run(["--nodes", "--json"], RIGS_MULTI);
    const parsed = JSON.parse(out);
    expect(parsed.scope).toBeDefined();
    expect(parsed.scope.softwareTeam).toBe("alpha");
    expect(parsed.scope.softwareTeamsOnHost).toBe(3);
    expect(parsed.scope.hint).toContain("SoftwareTeam ps lists all");
    expect(parsed.scope.hint).toMatch(/-A|--software-team/);
    expect(parsed.entries).toHaveLength(1); // still scoped to the session softwareTeam (behavior unchanged)
  });

  it("MULTI-SOFTWARE_TEAM: --nodes (human) renders ONE matching stderr hint line", async () => {
    const { err } = await run(["--nodes"], RIGS_MULTI);
    expect(err).toContain("softwareTeams shown");
    expect(err).toContain("alpha");
    expect(err).toMatch(/SoftwareTeam ps lists all|--software-team NAME or -A/);
  });

  it("NO DEFAULT CHANGE: single-software-team host → NO scope, bare array (byte-stable)", async () => {
    const { out, err } = await run(["--nodes", "--json"], RIGS_SINGLE);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true); // unchanged: bare array, no envelope, no scope
    expect(err).toBe(""); // no stderr hint when nothing is hidden
  });

  it("NO DEFAULT CHANGE: the scoped node set is unchanged (still the session SoftwareTeam only)", async () => {
    const { out } = await run(["--nodes", "--json"], RIGS_MULTI);
    const entries = JSON.parse(out).entries;
    expect(entries.every((n: { softwareTeamName: string }) => n.softwareTeamName === "alpha")).toBe(true);
  });

  it("LABEL-REFERENT COHERENCE: softwareTeamsOnHost counts the ACTIVE projection `SoftwareTeam ps` shows, not stopped softwareTeams", async () => {
    // 4 softwareTeams on host (2 active, 2 stopped). `SoftwareTeam ps`'s bare header renders the 2 active — so the
    // hint that DIRECTS the operator there must say "1 of 2", never "1 of 4" (the live-only finding).
    const { out, err } = await run(["--nodes", "--json"], RIGS_MIXED);
    const parsed = JSON.parse(out);
    expect(parsed.scope.softwareTeamsOnHost).toBe(2); // active projection, NOT softwareTeamRes.data.length (4)
    expect(parsed.scope.softwareTeamsOnHost).not.toBe(4); // the exact RED before the fix
    expect(parsed.scope.hint).toContain("1 of 2 softwareTeams shown");
    expect(err).toBe(""); // json path: no stderr
  });
});
