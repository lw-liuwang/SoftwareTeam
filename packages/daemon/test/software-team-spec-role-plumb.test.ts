import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { SoftwareTeamSpecCodec } from "../src/domain/software-team-spec-codec.js";
import type { SoftwareTeamSpec } from "../src/domain/types.js";

// OPR.0.4.6.FAC1 commit 1 — the role dimension exists end-to-end
// (AC-4 substrate; BR-4; P2-1 sibling-layer sweep).
//
// ONE schema change covers all THREE node-creation paths (initial pod
// materialize · softwareTeam expand · add_member) because they all route through
// PodSoftwareTeamSpecSchema → createMemberNode → softwareTeamRepo.addNode (which already
// writes nodes.role). These tests pin each path separately so a future
// per-path field map (the buildExpansionSpecObject class of remap —
// caught during this build) cannot silently drop the field again.
//
// Rules pinned here (planner1 §2 C1 / planner2 §3.8):
//   - role is OPT-IN per seat: a role-less member is legal everywhere
//     and projects role=null (never role-resolved; explicit targeting
//     only).
//   - a PROVIDED role is never silently dropped: it validates, lands in
//     nodes.role, and projects into the inventory entry on every path.
//   - role is rejected on terminal members (a terminal node is not an
//     agent seat).

const SOFTWARE_TEAM_ROOT = "/project/software-teams/role-software-team";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function rawMember(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    agent_ref: "local:agents/impl",
    profile: "default",
    runtime: "claude-code",
    cwd: ".",
    ...over,
  };
}

function rawSpec(members: Record<string, unknown>[], name = "role-software-team"): Record<string, unknown> {
  return {
    version: "0.2",
    name,
    pods: [{ id: "dev", label: "Dev", members, edges: [] }],
    edges: [],
  };
}

describe("FAC-1 C1: member role — schema validation + normalization", () => {
  it("accepts an optional role and normalizes it onto the pod member", () => {
    const spec = rawSpec([rawMember("impl", { role: "driver" })]);
    const validation = SoftwareTeamSpecSchema.validate(spec);
    expect(validation.valid).toBe(true);
    const normalized = SoftwareTeamSpecSchema.normalize(spec);
    expect(normalized.pods[0]!.members[0]!.role).toBe("driver");
  });

  it("a member WITHOUT role stays fully legal and normalizes role=undefined (opt-in per seat)", () => {
    const spec = rawSpec([rawMember("impl")]);
    const validation = SoftwareTeamSpecSchema.validate(spec);
    expect(validation.valid).toBe(true);
    expect(SoftwareTeamSpecSchema.normalize(spec).pods[0]!.members[0]!.role).toBeUndefined();
  });

  it("rejects an empty-string role (a provided role must validate, never be dropped)", () => {
    const validation = SoftwareTeamSpecSchema.validate(rawSpec([rawMember("impl", { role: "  " })]));
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toMatch(/role: must be a non-empty string/);
  });

  it("rejects a role outside the neighbor-field charset", () => {
    const validation = SoftwareTeamSpecSchema.validate(rawSpec([rawMember("impl", { role: "qa reviewer!" })]));
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toMatch(/role: must contain only/);
  });

  it("rejects role on a terminal member (a terminal node is not an agent seat)", () => {
    const validation = SoftwareTeamSpecSchema.validate(
      rawSpec([
        { id: "server", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp", role: "driver" },
      ]),
    );
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toMatch(/role: not valid on terminal members/);
  });
});

describe("FAC-1 C1: role plumb across ALL THREE node-creation paths (P2-1)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, {
      podInstantiatorFsOps: {
        readFile: (p: string) => {
          if (p.includes("agents/impl")) return agentYaml("impl");
          throw new Error(`Not found: ${p}`);
        },
        exists: (p: string) => p.includes("agents/impl"),
      },
    });
  });

  afterEach(() => { db.close(); });

  function nodeRole(logicalId: string): string | null {
    const row = db
      .prepare("SELECT role FROM nodes WHERE logical_id = ?")
      .get(logicalId) as { role: string | null } | undefined;
    expect(row, `node ${logicalId} should exist`).toBeDefined();
    return row!.role;
  }

  it("PATH 1 — initial pod materialize: spec role → nodes.role → inventory entry (and role-less → null)", async () => {
    const spec = rawSpec([
      rawMember("impl", { role: "driver" }),
      rawMember("helper"), // role-less pod-mate stays legal
    ]);
    const outcome = await setup.podInstantiator.materializeStructured(spec, SOFTWARE_TEAM_ROOT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(nodeRole("dev.impl")).toBe("driver");
    expect(nodeRole("dev.helper")).toBeNull();

    const entries = getNodeInventory(db, outcome.result.softwareTeamId);
    const impl = entries.find((e) => e.logicalId === "dev.impl");
    const helper = entries.find((e) => e.logicalId === "dev.helper");
    expect(impl?.role).toBe("driver");
    expect(helper?.role).toBeNull();
  });

  it("PATH 2 — SoftwareTeam expand (structured fragment): role rides buildExpansionSpecObject → nodes.role", async () => {
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("role-software-team");
    const expanded = await setup.softwareTeamExpansionService.expand({
      softwareTeamId: softwareTeam.id,
      softwareTeamRoot: SOFTWARE_TEAM_ROOT,
      pod: {
        id: "qa",
        label: "QA",
        members: [
          { id: "reviewer", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: ".", role: "qa" },
        ],
        edges: [],
      },
    });
    expect(expanded.ok).toBe(true);
    expect(nodeRole("qa.reviewer")).toBe("qa");
    const entry = getNodeInventory(db, softwareTeam.id).find((e) => e.logicalId === "qa.reviewer");
    expect(entry?.role).toBe("qa");
  });

  it("PATH 3 — add_member: fragment role → nodes.role; a role-LESS add into a role-carrying pod is legal (opt-in)", async () => {
    const spec = rawSpec([rawMember("impl", { role: "driver" })]);
    const outcome = await setup.podInstantiator.materializeStructured(spec, SOFTWARE_TEAM_ROOT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const softwareTeamId = outcome.result.softwareTeamId;

    const withRole = await setup.podInstantiator.addMemberToPod(
      softwareTeamId,
      "dev",
      rawMember("driver2", { role: "driver" }),
      SOFTWARE_TEAM_ROOT,
    );
    expect(withRole.ok).toBe(true);
    expect(nodeRole("dev.driver2")).toBe("driver");

    const roleLess = await setup.podInstantiator.addMemberToPod(
      softwareTeamId,
      "dev",
      rawMember("floater"),
      SOFTWARE_TEAM_ROOT,
    );
    expect(roleLess.ok).toBe(true);
    expect(nodeRole("dev.floater")).toBeNull();

    const entries = getNodeInventory(db, softwareTeamId);
    expect(entries.find((e) => e.logicalId === "dev.driver2")?.role).toBe("driver");
    expect(entries.find((e) => e.logicalId === "dev.floater")?.role).toBeNull();
  });

  it("round-trip fidelity: a normalized spec with role serializes back to YAML carrying role", () => {
    const spec = rawSpec([rawMember("impl", { role: "driver" })]);
    expect(SoftwareTeamSpecSchema.validate(spec).valid).toBe(true);
    const normalized = SoftwareTeamSpecSchema.normalize(spec) as unknown as SoftwareTeamSpec;
    const yaml = SoftwareTeamSpecCodec.serialize(normalized);
    expect(yaml).toMatch(/role: driver/);
  });

  it("PATH 4 — bootstrap instantiate-from-YAML (the `SoftwareTeam up <spec>` path): role → nodes.role (VM-caught regression; this path does NOT go through createMemberNode)", async () => {
    // The pod-aware PodSoftwareTeamInstantiator.instantiate(yaml, softwareTeamRoot) creates
    // agent nodes via its OWN inline addNode — a distinct site from the
    // createMemberNode used by materialize/expand/add_member. The
    // original C1 sweep tested those three but not THIS one, so
    // role=NULL shipped on every `SoftwareTeam up`-created softwareTeam until the VM proof
    // caught bound_software_team_role_uncovered on a fully-running softwareTeam. This test
    // pins the fourth path.
    const spec = rawSpec([
      rawMember("planner1", { role: "planner" }),
      rawMember("helper"), // role-less pod-mate stays null on THIS path too
    ]);
    const yaml = SoftwareTeamSpecCodec.serialize(SoftwareTeamSpecSchema.normalize(spec) as unknown as SoftwareTeamSpec);
    const outcome = await setup.podInstantiator.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(nodeRole("dev.planner1")).toBe("planner");
    expect(nodeRole("dev.helper")).toBeNull();
    if (outcome.ok) {
      const entries = getNodeInventory(db, outcome.result.softwareTeamId);
      expect(entries.find((e) => e.logicalId === "dev.planner1")?.role).toBe("planner");
    }
  });
});
