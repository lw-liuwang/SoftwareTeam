// OPR.0.5.3.6 — shipped topology defaults install at software-team-up (proof item 3).
// The load-bearing pins: four altitudes land under topology.root with the
// instance file at the TOP of the root; copy-if-absent NEVER overwrites earned
// context; a spec without topology/ is a normal no-op; failures are named,
// never thrown (a SoftwareTeam launch must not die on a defaults copy).
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { installTopologyDefaults, type TopologyDefaultsFsOps } from "../src/domain/topology-defaults-installer.js";

const SPEC = "/specs/product-team";
const ROOT = "/inst/topology";

function memFs(initial: Record<string, string>): { ops: TopologyDefaultsFsOps; files: Record<string, string>; dirs: Set<string> } {
  const files = { ...initial };
  const dirs = new Set<string>();
  const isDir = (p: string) => dirs.has(p) || Object.keys(files).some((f) => f.startsWith(p + "/"));
  return {
    files,
    dirs,
    ops: {
      exists: (p) => p in files,
      isDirectory: isDir,
      listFiles: (d) => Object.keys(files)
        .filter((f) => f.startsWith(d + "/") && !f.slice(d.length + 1).includes("/"))
        .map((f) => f.slice(d.length + 1)),
      listDirs: (d) => [...new Set(Object.keys(files)
        .filter((f) => f.startsWith(d + "/") && f.slice(d.length + 1).includes("/"))
        .map((f) => f.slice(d.length + 1).split("/")[0]!))],
      read: (p) => {
        const v = files[p];
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      write: (p, c) => { files[p] = c; },
      mkdirp: (p) => { dirs.add(p); },
    },
  };
}

describe("installTopologyDefaults", () => {
  it("installs instance, softwareTeam, pod, and seat defaults under topology.root — instance file at the TOP of the root", () => {
    const { ops, files } = memFs({
      [join(SPEC, "topology", "instance", "CRAFT.md")]: "instance craft",
      [join(SPEC, "topology", "software-team", "CRAFT.md")]: "SoftwareTeam craft",
      [join(SPEC, "topology", "software-team", "ORCHESTRATION-CRAFT.md")]: "orch craft",
      [join(SPEC, "topology", "pods", "delivery", "CRAFT.md")]: "pod craft",
      [join(SPEC, "topology", "seats", "orch1-lead", "CRAFT.md")]: "lead craft",
    });
    const res = installTopologyDefaults({ specDir: SPEC, softwareTeamName: "product-team", podIds: ["delivery"], topologyRoot: ROOT, fsOps: ops });
    expect(res.none).toBe(false);
    expect(res.failed).toEqual([]);
    expect(files[join(ROOT, "CRAFT.md")]).toBe("instance craft");
    expect(files[join(ROOT, "software-teams", "product-team", "CRAFT.md")]).toBe("SoftwareTeam craft");
    expect(files[join(ROOT, "software-teams", "product-team", "ORCHESTRATION-CRAFT.md")]).toBe("orch craft");
    expect(files[join(ROOT, "software-teams", "product-team", "pods", "delivery", "CRAFT.md")]).toBe("pod craft");
    expect(files[join(ROOT, "software-teams", "product-team", "seats", "orch1-lead", "CRAFT.md")]).toBe("lead craft");
    expect(res.installed).toHaveLength(5);
  });

  it("copy-if-absent: an existing destination is PRESERVED, never overwritten by a later software-team-up", () => {
    const earned = "earned context the occupying team appended";
    const { ops, files } = memFs({
      [join(SPEC, "topology", "software-team", "CRAFT.md")]: "shipped default v2",
      [join(ROOT, "software-teams", "product-team", "CRAFT.md")]: earned,
    });
    const res = installTopologyDefaults({ specDir: SPEC, softwareTeamName: "product-team", topologyRoot: ROOT, fsOps: ops });
    expect(files[join(ROOT, "software-teams", "product-team", "CRAFT.md")]).toBe(earned);
    expect(res.preserved).toEqual([join(ROOT, "software-teams", "product-team", "CRAFT.md")]);
    expect(res.installed).toEqual([]);
  });

  it("a spec without topology/ still receives engine-managed instance, softwareTeam, and pod directories", () => {
    const { ops, dirs } = memFs({ [join(SPEC, "software-team.yaml")]: "..." });
    const res = installTopologyDefaults({ specDir: SPEC, softwareTeamName: "x", podIds: ["ops"], topologyRoot: ROOT, fsOps: ops });
    expect(res).toMatchObject({ none: true, installed: [], preserved: [], failed: [] });
    expect(dirs).toEqual(new Set([
      ROOT,
      join(ROOT, "software-teams", "x"),
      join(ROOT, "software-teams", "x", "pods", "ops"),
    ]));
  });

  it("r2-B2: an ENUMERATION failure (listFiles throws) is NAMED and never thrown; other sections still install", () => {
    // r2's discriminator: listFiles/listDirs sat outside the catch, so an
    // EACCES on one section's directory escaped the best-effort contract and
    // turned a COMMITTED materialize into materialize_error. The contract is
    // total: no filesystem failure of any shape may throw out of the installer.
    const { ops, files } = memFs({
      [join(SPEC, "topology", "software-team", "GOOD.md")]: "good",
      [join(SPEC, "topology", "seats", "s1", "SEAT.md")]: "seat good",
    });
    const failingOps: TopologyDefaultsFsOps = {
      ...ops,
      listFiles: (d) => {
        if (d === join(SPEC, "topology", "software-team")) throw new Error("EACCES enumerate");
        return ops.listFiles(d);
      },
    };
    const res = installTopologyDefaults({ specDir: SPEC, softwareTeamName: "product-team", topologyRoot: ROOT, fsOps: failingOps });
    expect(res.failed).toEqual([{ path: join(SPEC, "topology", "software-team"), error: "EACCES enumerate" }]);
    // The seats section still installed — one section's denial never starves the rest.
    expect(files[join(ROOT, "software-teams", "product-team", "seats", "s1", "SEAT.md")]).toBe("seat good");
  });

  it("r2 residual: the INITIAL topology/ root probe throwing is NAMED, never thrown (the total contract has no first-line exception)", () => {
    const { ops } = memFs({ [join(SPEC, "topology", "software-team", "X.md")]: "x" });
    const failingOps: TopologyDefaultsFsOps = {
      ...ops,
      isDirectory: (p) => {
        if (p === join(SPEC, "topology")) throw new Error("EACCES root probe");
        return ops.isDirectory(p);
      },
    };
    const res = installTopologyDefaults({ specDir: SPEC, softwareTeamName: "r", topologyRoot: ROOT, fsOps: failingOps });
    expect(res.failed).toEqual([{ path: join(SPEC, "topology"), error: "EACCES root probe" }]);
    expect(res.none).toBe(false);
  });

  it("r2-B2: a listDirs failure on seats/ is NAMED, not thrown", () => {
    const { ops } = memFs({ [join(SPEC, "topology", "seats", "s1", "SEAT.md")]: "x" });
    const failingOps: TopologyDefaultsFsOps = {
      ...ops,
      listDirs: () => { throw new Error("EIO seats"); },
    };
    const res = installTopologyDefaults({ specDir: SPEC, softwareTeamName: "r", topologyRoot: ROOT, fsOps: failingOps });
    expect(res.failed).toEqual([{ path: join(SPEC, "topology", "seats"), error: "EIO seats" }]);
  });

  it("a per-file failure is NAMED and never thrown; the remaining files still install", () => {
    const { ops, files } = memFs({
      [join(SPEC, "topology", "software-team", "BROKEN.md")]: "x",
      [join(SPEC, "topology", "software-team", "GOOD.md")]: "good",
    });
    const failingOps: TopologyDefaultsFsOps = {
      ...ops,
      write: (p, c) => {
        if (p.endsWith("BROKEN.md")) throw new Error("EACCES: denied");
        files[p] = c;
      },
    };
    const res = installTopologyDefaults({ specDir: SPEC, softwareTeamName: "product-team", topologyRoot: ROOT, fsOps: failingOps });
    expect(res.failed).toEqual([{ path: join(ROOT, "software-teams", "product-team", "BROKEN.md"), error: "EACCES: denied" }]);
    expect(files[join(ROOT, "software-teams", "product-team", "GOOD.md")]).toBe("good");
  });
});
