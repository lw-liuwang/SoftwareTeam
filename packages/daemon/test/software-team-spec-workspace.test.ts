// PL-007 Workspace Primitive v0 — SoftwareTeamSpec.workspace block validation +
// normalization tests.
//
// Pins:
//   - validateSoftwareTeamSpec accepts an optional workspace block with required
//     workspace_root + repos[] + per-repo (name, path, kind)
//   - rejects malformed (missing workspace_root, unknown kind, duplicate
//     repo name, default_repo not in repos[])
//   - back-compat: softwareTeams without workspace block stay valid
//   - normalize round-trips fields and resolves relative paths against
//     workspace_root
//   - codec round-trip preserves the workspace block on serialize/parse

import { describe, it, expect } from "vitest";
import { SoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import { SoftwareTeamSpecCodec } from "../src/domain/software-team-spec-codec.js";

const baseSoftwareTeam = {
  version: "0.2",
  name: "test-software-team",
  pods: [{
    id: "dev",
    label: "Dev pod",
    members: [{
      id: "impl",
      agent_ref: "local:agents/impl",
      profile: "default",
      runtime: "claude-code",
      cwd: "/tmp",
    }],
    edges: [],
  }],
  edges: [],
};

const workspaceBlock = {
  workspace_root: "/Users/test/project",
  repos: [
    { name: "main", path: "main", kind: "project" },
    { name: "internal", path: "/Users/test/project/internal", kind: "project" },
  ],
  default_repo: "main",
  knowledge_root: "/Users/test/knowledge",
};

describe("SoftwareTeamSpec validation — workspace block (PL-007)", () => {
  it("accepts a well-formed workspace block", () => {
    const result = SoftwareTeamSpecSchema.validate({ ...baseSoftwareTeam, workspace: workspaceBlock });
    expect(result.valid).toBe(true);
  });

  it("back-compat: SoftwareTeam without workspace block stays valid", () => {
    const result = SoftwareTeamSpecSchema.validate(baseSoftwareTeam);
    expect(result.valid).toBe(true);
  });

  it("rejects missing workspace_root", () => {
    const broken = { ...baseSoftwareTeam, workspace: { ...workspaceBlock, workspace_root: "" } };
    const result = SoftwareTeamSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workspace_root"))).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const broken = {
      ...baseSoftwareTeam,
      workspace: { ...workspaceBlock, repos: [{ name: "x", path: "x", kind: "rd-pod" }] },
    };
    const result = SoftwareTeamSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /kind/i.test(e))).toBe(true);
  });

  it("rejects duplicate repo names", () => {
    const broken = {
      ...baseSoftwareTeam,
      workspace: {
        ...workspaceBlock,
        repos: [
          { name: "softwareteam", path: "softwareteam", kind: "project" },
          { name: "softwareteam", path: "softwareteam-internal", kind: "project" },
        ],
      },
    };
    const result = SoftwareTeamSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  it("rejects default_repo that does not match any repo", () => {
    const broken = { ...baseSoftwareTeam, workspace: { ...workspaceBlock, default_repo: "nonexistent" } };
    const result = SoftwareTeamSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /default_repo/.test(e))).toBe(true);
  });

  it("normalize resolves relative repo paths against workspace_root", () => {
    const normalized = SoftwareTeamSpecSchema.normalize({ ...baseSoftwareTeam, workspace: workspaceBlock } as Record<string, unknown>);
    expect(normalized.workspace).toBeDefined();
    expect(normalized.workspace?.workspaceRoot).toBe("/Users/test/project");
    expect(normalized.workspace?.repos[0]?.path).toBe("/Users/test/project/main");
    expect(normalized.workspace?.repos[1]?.path).toBe("/Users/test/project/internal");
    expect(normalized.workspace?.defaultRepo).toBe("main");
    expect(normalized.workspace?.knowledgeRoot).toBe("/Users/test/knowledge");
  });

  it("normalize accepts a SoftwareTeam without workspace block", () => {
    const normalized = SoftwareTeamSpecSchema.normalize(baseSoftwareTeam as Record<string, unknown>);
    expect(normalized.workspace).toBeUndefined();
  });

  it("validates all 5 typed kinds (user/project/knowledge/lab/delivery)", () => {
    for (const k of ["user", "project", "knowledge", "lab", "delivery"]) {
      const result = SoftwareTeamSpecSchema.validate({
        ...baseSoftwareTeam,
        workspace: {
          workspace_root: "/r",
          repos: [{ name: "a", path: "a", kind: k }],
        },
      });
      expect(result.valid).toBe(true);
    }
  });

  it("codec round-trips the workspace block", () => {
    const normalized = SoftwareTeamSpecSchema.normalize({ ...baseSoftwareTeam, workspace: workspaceBlock } as Record<string, unknown>);
    const yaml = SoftwareTeamSpecCodec.serialize(normalized);
    const parsed = SoftwareTeamSpecCodec.parse(yaml) as Record<string, unknown>;
    expect((parsed.workspace as Record<string, unknown>).workspace_root).toBe("/Users/test/project");
    const repos = (parsed.workspace as Record<string, unknown>).repos as Array<Record<string, unknown>>;
    expect(repos).toHaveLength(2);
    expect(repos[0]?.name).toBe("main");
    expect(repos[0]?.kind).toBe("project");
  });
});
