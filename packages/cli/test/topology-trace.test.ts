// OPR.0.5.3.6 + OPR.0.5.8.7 — the productized chain-file trace keyed off
// topology.root (instance at the TOP, D2), per-level legacy fallback that
// NAMES its advisory (proof-contract item 2: legacy fallback honesty).
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { traceTopologyChain, type TraceFs } from "../src/lib/topology-trace.js";

const ROOT = "/inst/topology";
const LEGACY = "/inst/shared-docs/software-teams";

function fsOf(files: Record<string, string>): TraceFs {
  return {
    exists: (p) => p in files,
    read: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`unexpected read: ${p}`);
      return v;
    },
  };
}

describe("traceTopologyChain", () => {
  it("walks instance -> SoftwareTeam -> seat under topology.root, instance file at the TOP of the root", () => {
    const files = {
      [join(ROOT, "LEARNED.md")]: "instance-level",
      [join(ROOT, "software-teams", "product-team", "LEARNED.md")]: "software-team-level",
      [join(ROOT, "software-teams", "product-team", "seats", "orch1-lead", "LEARNED.md")]: "seat-level",
    };
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", softwareTeam: "product-team", seat: "orch1-lead",
      legacySoftwareTeamsRoot: LEGACY, fs: fsOf(files),
    });
    expect(result.levels.map((l) => [l.altitude, l.source, l.content])).toEqual([
      ["instance", "topology.root", "instance-level"],
      ["softwareTeam", "topology.root", "software-team-level"],
      ["seat", "topology.root", "seat-level"],
    ]);
    expect(result.levels.every((l) => l.advisory === undefined)).toBe(true);
  });

  it("adds the canonical pod altitude between SoftwareTeam and seat when --pod is selected", () => {
    const files = {
      [join(ROOT, "LEARNED.md")]: "instance-level",
      [join(ROOT, "software-teams", "product-team", "LEARNED.md")]: "software-team-level",
      [join(ROOT, "software-teams", "product-team", "pods", "delivery", "LEARNED.md")]: "pod-level",
      [join(ROOT, "software-teams", "product-team", "seats", "impl", "LEARNED.md")]: "seat-level",
    };
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", softwareTeam: "product-team", pod: "delivery", seat: "impl",
      legacySoftwareTeamsRoot: LEGACY, fs: fsOf(files),
    });
    expect(result.levels.map((l) => [l.altitude, l.source, l.content])).toEqual([
      ["instance", "topology.root", "instance-level"],
      ["softwareTeam", "topology.root", "software-team-level"],
      ["pod", "topology.root", "pod-level"],
      ["seat", "topology.root", "seat-level"],
    ]);
  });

  it("legacy fallback honesty: a pre-convention file is READ and the advisory NAMES both locations", () => {
    const files = {
      [join(LEGACY, "product-team", "seats", "orch1-lead", "LEARNED.md")]: "legacy seat content",
    };
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", softwareTeam: "product-team", seat: "orch1-lead",
      legacySoftwareTeamsRoot: LEGACY, fs: fsOf(files),
    });
    const seat = result.levels.find((l) => l.altitude === "seat")!;
    expect(seat.source).toBe("legacy");
    expect(seat.content).toBe("legacy seat content");
    expect(seat.resolvedPath).toBe(join(LEGACY, "product-team", "seats", "orch1-lead", "LEARNED.md"));
    // The advisory names the legacy source, the canonical destination, and the config key.
    expect(seat.advisory).toContain("legacy-topology-read");
    expect(seat.advisory).toContain(join(LEGACY, "product-team", "seats", "orch1-lead", "LEARNED.md"));
    expect(seat.advisory).toContain(join(ROOT, "software-teams", "product-team", "seats", "orch1-lead", "LEARNED.md"));
    expect(seat.advisory).toContain("topology.root");
  });

  it("topology.root wins over legacy when both exist (canonical is never shadowed)", () => {
    const canonical = join(ROOT, "software-teams", "product-team", "LEARNED.md");
    const files = {
      [canonical]: "canonical",
      [join(LEGACY, "product-team", "LEARNED.md")]: "stale legacy",
    };
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", softwareTeam: "product-team",
      legacySoftwareTeamsRoot: LEGACY, fs: fsOf(files),
    });
    const softwareTeam = result.levels.find((l) => l.altitude === "softwareTeam")!;
    expect(softwareTeam).toMatchObject({ source: "topology.root", content: "canonical", resolvedPath: canonical });
  });

  it("absent everywhere is reported as absent — never an error, never a silent skip", () => {
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "CULTURE.md", softwareTeam: "ghost-software-team", seat: "s1",
      legacySoftwareTeamsRoot: LEGACY, fs: fsOf({}),
    });
    expect(result.levels.map((l) => [l.altitude, l.source])).toEqual([
      ["instance", "absent"], ["softwareTeam", "absent"], ["seat", "absent"],
    ]);
  });

  it("omitting the seat yields a software-team-level trace (instance + SoftwareTeam only)", () => {
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "CULTURE.md", softwareTeam: "product-team",
      legacySoftwareTeamsRoot: LEGACY, fs: fsOf({}),
    });
    expect(result.levels.map((l) => l.altitude)).toEqual(["instance", "softwareTeam"]);
  });

  it("r2-B3: traversal in softwareTeam/seat/name is REJECTED before any filesystem read", () => {
    // r2's discriminator: softwareTeam=../../outside, seat=../../../outside-seat,
    // name=../../secret resolved every level OUTSIDE topology.root. Each of
    // the three values must be a single safe path segment — no separators,
    // no dot-segments, non-empty — validated before any read.
    const reads: string[] = [];
    const spyFs: TraceFs = { exists: (p) => { reads.push(p); return false; }, read: () => { throw new Error("no"); } };
    const bad = [
      { softwareTeam: "../../outside", seat: "s", name: "LEARNED.md" },
      { softwareTeam: "r", seat: "../../../outside-seat", name: "LEARNED.md" },
      { softwareTeam: "r", seat: "s", name: "../../secret" },
      { softwareTeam: "r/nested", seat: "s", name: "LEARNED.md" },
      { softwareTeam: "r", seat: "s\\evil", name: "LEARNED.md" },
      { softwareTeam: "r", pod: "../outside-pod", seat: "s", name: "LEARNED.md" },
      { softwareTeam: ".", seat: "s", name: "LEARNED.md" },
      { softwareTeam: "", seat: "s", name: "LEARNED.md" },
    ];
    for (const args of bad) {
      expect(() => traceTopologyChain({ topologyRoot: ROOT, legacySoftwareTeamsRoot: LEGACY, fs: spyFs, ...args }),
        JSON.stringify(args)).toThrow(/invalid|segment/i);
    }
    expect(reads).toEqual([]); // rejection happens BEFORE any filesystem contact
  });

  it("r2 residual: an EXPLICITLY EMPTY seat is rejected, not silently treated as omitted", () => {
    // `--seat ""` is user error, not a software-team-level trace request. Omission
    // (undefined/null) stays the sanctioned software-team-level form.
    expect(() => traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", softwareTeam: "r", seat: "",
      legacySoftwareTeamsRoot: LEGACY, fs: fsOf({}),
    })).toThrow(/invalid seat/i);
    const omitted = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", softwareTeam: "r", seat: null,
      legacySoftwareTeamsRoot: LEGACY, fs: fsOf({}),
    });
    expect(omitted.levels.map((l) => l.altitude)).toEqual(["instance", "softwareTeam"]);
  });

  it("r2-B3: ordinary dotted names stay valid (LEARNED.md, a.b.c.md, seat ids with dashes/underscores)", () => {
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "a.b.c.md", softwareTeam: "product-team", seat: "orch1_lead-2",
      legacySoftwareTeamsRoot: LEGACY, fs: fsOf({}),
    });
    expect(result.levels).toHaveLength(3);
  });

  it("the instance altitude has NO legacy fallback (the legacy layout began at software-teams/)", () => {
    const files = { [join(LEGACY, "..", "LEARNED.md")]: "should never be consulted" };
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", softwareTeam: "product-team",
      legacySoftwareTeamsRoot: LEGACY, fs: fsOf(files),
    });
    expect(result.levels.find((l) => l.altitude === "instance")!.source).toBe("absent");
  });
});
