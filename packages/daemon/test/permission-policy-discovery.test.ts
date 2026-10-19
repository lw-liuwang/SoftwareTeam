import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { softwareTeamPreflight } from "../src/domain/software-team-spec-preflight.js";
import { SoftwareTeamSpecSchema as PodSoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { createFullTestDb, createTestApp as createBaseTestApp } from "./helpers/test-app.js";
import { SystemPreflight } from "../../cli/src/system-preflight.js";

const SOFTWARE_TEAM_ROOT = "/project/software-teams/policy-discovery";
const ORIGINAL_SOFTWARE_TEAM_ROOT = "/original/softwareTeam";
const OTHER_OPERATION_ROOT = "/different/operation-root";
const CUSTOM_POLICY_REF = "policies/operator-full.md";
const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`;
const COLLIDING_AGENT_YAML = `name: impl
version: "1.0.0"
imports:
  - ref: local:../lib
resources:
  skills:
    - id: shared
      path: skills/shared
profiles:
  default:
    uses:
      skills: [shared]
`;
const COLLIDING_IMPORT_YAML = `name: lib
version: "1.0.0"
resources:
  skills:
    - id: shared
      path: skills/shared
profiles: {}
`;
const CUSTOM_POLICY = `---
policy_schema_version: 1
name: operator-full
source: custom
description: full-bypass flag policy
surface: flag
launch_posture: full_bypass
---
# Operator full
`;

function fsOps(): AgentResolverFsOps {
  return {
    exists: (path) => path.includes("agents/impl") || path.endsWith("policies/operator-full.md"),
    readFile: (path) => {
      if (path.includes("agents/impl")) return AGENT_YAML;
      if (path.endsWith("policies/operator-full.md")) return CUSTOM_POLICY;
      throw new Error(`Not found: ${path}`);
    },
  };
}

function collisionFsOps(): AgentResolverFsOps {
  return {
    exists: (path) => path.includes("agents/impl") || path.includes("agents/lib"),
    readFile: (path) => {
      if (path.includes("agents/impl")) return COLLIDING_AGENT_YAML;
      if (path.includes("agents/lib")) return COLLIDING_IMPORT_YAML;
      throw new Error(`Not found: ${path}`);
    },
  };
}

function softwareTeamYaml(opts: { name?: string; softwareTeamPolicy?: string; memberPolicy?: string } = {}): string {
  const softwareTeamPolicy = opts.softwareTeamPolicy ? `permission_policy: ${opts.softwareTeamPolicy}\n` : "";
  const memberPolicy = opts.memberPolicy ? `        permission_policy: ${opts.memberPolicy}\n` : "";
  return `version: "0.2"
name: ${opts.name ?? "policy-discovery"}
${softwareTeamPolicy}pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
${memberPolicy}        cwd: .
    edges: []
edges: []
`;
}

const policyLines = (warnings: string[]) => warnings.filter((warning) => warning.includes("permission_policy"));

function createTestApp(...args: Parameters<typeof createBaseTestApp>) {
  const setup = createBaseTestApp(...args);
  // These controls isolate policy/preflight warning order. Model the completed
  // startup send explicitly instead of adding missing-capture fixture warnings.
  setup.tmuxAdapter.capturePaneContent = vi.fn(async () => "Previous turn\n────────────────────\n❯ \n────────────────────\n⏵⏵ accept edits on (shift+tab to cycle)\n");
  return setup;
}

describe("Seam C permission-policy discovery", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces an attached builtin ref with honest origin and bound posture", async () => {
    const result = await softwareTeamPreflight({
      softwareTeamSpecYaml: softwareTeamYaml({ softwareTeamPolicy: "builtin:yolo" }),
      softwareTeamRoot: SOFTWARE_TEAM_ROOT,
      fsOps: fsOps(),
    });

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(policyLines(result.warnings)).toEqual([
      'dev.impl: permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
    ]);
  });

  it("surfaces the per-member custom override instead of the software-team-level policy", async () => {
    const result = await softwareTeamPreflight({
      softwareTeamSpecYaml: softwareTeamYaml({ softwareTeamPolicy: "builtin:standard", memberPolicy: "policies/operator-full.md" }),
      softwareTeamRoot: SOFTWARE_TEAM_ROOT,
      fsOps: fsOps(),
    });

    expect(result.ready).toBe(true);
    expect(policyLines(result.warnings)).toEqual([
      'dev.impl: permission_policy ref="policies/operator-full.md" origin=custom launch_posture=full_bypass',
    ]);
    expect(result.warnings.join("\n")).not.toContain("builtin:standard");
  });

  it("surfaces honest absence as the floor without errors or blocking", async () => {
    const result = await softwareTeamPreflight({ softwareTeamSpecYaml: softwareTeamYaml(), softwareTeamRoot: SOFTWARE_TEAM_ROOT, fsOps: fsOps() });

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(policyLines(result.warnings)).toEqual([
      "dev.impl: permission_policy absent; launch_posture=floor",
    ]);
  });

  it("carries policy discovery and existing preflight advisories through materialize in order", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: collisionFsOps() });
      const outcome = await setup.podInstantiator.materialize(
        softwareTeamYaml({ name: "policy-materialize-warnings", softwareTeamPolicy: "builtin:yolo" }),
        SOFTWARE_TEAM_ROOT,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.warnings).toEqual([
        // §6 reconciliation (PM ruling 2026-08-05, fold-wave qitem 79159e6f): main's already-folded
        // preflight advisories (collision) are the FLOOR (first); the restacked permission-policy
        // discovery warning is APPENDED after. Supersedes the 4.8 lineage's original policy-first order.
        'dev.impl: base/import collision in skills on "shared"',
        'dev.impl: permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
      ]);
    } finally {
      db.close();
    }
  });

  it("carries policy discovery and existing preflight advisories through instantiate in order", async () => {
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true }),
      checkReady: async () => ({ ready: true }),
    } as RuntimeAdapter;
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: collisionFsOps(),
      });
      const outcome = await setup.podInstantiator.instantiate(
        softwareTeamYaml({ name: "policy-instantiate-warnings", softwareTeamPolicy: "builtin:yolo" }),
        SOFTWARE_TEAM_ROOT,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.warnings).toEqual([
        // §6 reconciliation (PM ruling 2026-08-05, fold-wave qitem 79159e6f): main's already-folded
        // preflight advisories (collision) are the FLOOR (first); the restacked permission-policy
        // discovery warning is APPENDED after. Supersedes the 4.8 lineage's original policy-first order.
        'dev.impl: base/import collision in skills on "shared"',
        'dev.impl: permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
      ]);
    } finally {
      db.close();
    }
  });

  it("carries structured materialize warnings through the public expansion response in order", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: collisionFsOps() });
      const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("policy-expand-warnings");
      const response = await setup.app.request(`/api/software-teams/${softwareTeam.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          softwareTeamRoot: SOFTWARE_TEAM_ROOT,
          pod: {
            id: "dev",
            label: "Dev",
            members: [{
              id: "impl",
              runtime: "claude-code",
              agent_ref: "local:agents/impl",
              profile: "default",
              permission_policy: "builtin:yolo",
              cwd: ".",
            }],
            edges: [],
          },
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { warnings: string[] };
      expect(body.warnings).toEqual([
        // §6 reconciliation (PM ruling 2026-08-05, fold-wave qitem 79159e6f): main's already-folded
        // preflight advisories (collision) are the FLOOR (first); the restacked permission-policy
        // discovery warning is APPENDED after. Supersedes the 4.8 lineage's original policy-first order.
        'dev.impl: base/import collision in skills on "shared"',
        'dev.impl: permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
      ]);
    } finally {
      db.close();
    }
  });

  it("discovers persisted target-software-team policy provenance and matches the launch binding", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    } as RuntimeAdapter;
    const agentOnlyFsOps: AgentResolverFsOps = {
      exists: (path) => path.includes("agents/impl"),
      readFile: (path) => {
        if (path.includes("agents/impl")) return AGENT_YAML;
        throw new Error(`Not found: ${path}`);
      },
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: agentOnlyFsOps,
      });
      const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("persisted-policy-target");
      setup.softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "policies/operator-full.md");
      setup.softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
        origin: "custom",
        resolvedTarget: "/original/softwareTeam/policies/operator-full.md",
        declaringDir: "/original/softwareTeam",
        launchPosture: "full_bypass",
      });
      const specObject = {
        version: "0.2",
        name: softwareTeam.name,
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            cwd: ".",
          }, {
            id: "override",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            permission_policy: "builtin:standard",
            cwd: ".",
          }],
          edges: [],
        }],
        edges: [],
      };

      const materialized = await setup.podInstantiator.materializeStructured(
        specObject,
        "/different/operation-root",
        { targetSoftwareTeamId: softwareTeam.id },
      );
      expect(materialized.ok).toBe(true);
      if (!materialized.ok) return;
      expect(materialized.result.warnings).toEqual([
        'dev.impl: permission_policy ref="policies/operator-full.md" origin=custom launch_posture=full_bypass',
        'dev.override: permission_policy ref="builtin:standard" origin=builtin launch_posture=floor',
      ]);

      const launched = await setup.podInstantiator.launchValidatedSpec(
        PodSoftwareTeamSpecSchema.normalize(specObject),
        "/different/operation-root",
        softwareTeam.id,
      );
      expect(launched.ok).toBe(true);
      expect(bindings.map((binding) => binding.launchPosture)).toEqual(["full_bypass", "floor"]);
    } finally {
      db.close();
    }
  });

  it("carries persisted target policy discovery through the public YAML materialize route", async () => {
    const policyReads: string[] = [];
    const agentOnlyFsOps: AgentResolverFsOps = {
      exists: (path) => path.includes("agents/impl"),
      readFile: (path) => {
        if (path.includes("agents/impl")) return AGENT_YAML;
        policyReads.push(path);
        throw new Error(`Not found: ${path}`);
      },
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: agentOnlyFsOps });
      const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("persisted-yaml-target");
      setup.softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, CUSTOM_POLICY_REF);
      setup.softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
        origin: "custom",
        resolvedTarget: `${ORIGINAL_SOFTWARE_TEAM_ROOT}/${CUSTOM_POLICY_REF}`,
        declaringDir: ORIGINAL_SOFTWARE_TEAM_ROOT,
        launchPosture: "full_bypass",
      });

      const response = await setup.app.request("/api/software-teams/import/materialize", {
        method: "POST",
        headers: {
          "Content-Type": "text/yaml",
          "X-Software-Team-Root": OTHER_OPERATION_ROOT,
          "X-Target-software-team-Id": softwareTeam.id,
        },
        body: softwareTeamYaml({ name: softwareTeam.name }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { warnings?: string[] };
      const node = setup.softwareTeamRepo.getSoftwareTeam(softwareTeam.id)!.nodes.find((candidate) => candidate.logicalId === "dev.impl")!;
      expect(setup.softwareTeamRepo.getNodePolicyProvenance(node.id)).toEqual({
        origin: "custom",
        resolvedTarget: `${ORIGINAL_SOFTWARE_TEAM_ROOT}/${CUSTOM_POLICY_REF}`,
        declaringDir: ORIGINAL_SOFTWARE_TEAM_ROOT,
        launchPosture: "full_bypass",
        nodeRef: null,
      });
      expect(body.warnings).toEqual([
        'dev.impl: permission_policy ref="policies/operator-full.md" origin=custom launch_posture=full_bypass',
      ]);
      expect(body.warnings?.join("\n")).not.toContain("permission_policy absent");
      expect(policyReads).not.toContain(`${OTHER_OPERATION_ROOT}/${CUSTOM_POLICY_REF}`);
    } finally {
      db.close();
    }
  });

  it("carries inherited discovery before launch warnings through the public add-member route", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    } as RuntimeAdapter;
    const agentOnlyFsOps: AgentResolverFsOps = {
      exists: (path) => path.includes("agents/impl"),
      readFile: (path) => {
        if (path.includes("agents/impl")) return AGENT_YAML;
        throw new Error(`Not found: ${path}`);
      },
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: agentOnlyFsOps,
      });
      const seeded = await setup.podInstantiator.materializeStructured({
        version: "0.2",
        name: "persisted-add-member-target",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "existing",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            cwd: ".",
          }],
          edges: [],
        }],
        edges: [],
      }, ORIGINAL_SOFTWARE_TEAM_ROOT);
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) return;
      setup.softwareTeamRepo.setSoftwareTeamPermissionPolicy(seeded.result.softwareTeamId, CUSTOM_POLICY_REF);
      setup.softwareTeamRepo.setSoftwareTeamPolicyProvenance(seeded.result.softwareTeamId, {
        origin: "custom",
        resolvedTarget: `${ORIGINAL_SOFTWARE_TEAM_ROOT}/${CUSTOM_POLICY_REF}`,
        declaringDir: ORIGINAL_SOFTWARE_TEAM_ROOT,
        launchPosture: "full_bypass",
      });
      const originalLaunch = setup.nodeLauncher.launchNode.bind(setup.nodeLauncher);
      vi.spyOn(setup.nodeLauncher, "launchNode").mockImplementation(async (...args) => {
        const outcome = await originalLaunch(...args);
        return outcome.ok
          ? { ...outcome, warnings: [...(outcome.warnings ?? []), "later launch warning"] }
          : outcome;
      });

      const inheritedResponse = await setup.app.request(`/api/software-teams/${seeded.result.softwareTeamId}/pods/dev/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          softwareTeamRoot: OTHER_OPERATION_ROOT,
          member: {
            id: "late",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            cwd: ".",
          },
        }),
      });
      const inheritedBody = await inheritedResponse.json() as { ok: boolean; result: { warnings?: string[] } };

      expect(inheritedResponse.status).toBe(201);
      expect(inheritedBody.result.warnings).toEqual([
        'dev.late: permission_policy ref="policies/operator-full.md" origin=custom launch_posture=full_bypass',
        "later launch warning",
      ]);
      expect(bindings[0]?.launchPosture).toBe("full_bypass");

      const overrideResponse = await setup.app.request(`/api/software-teams/${seeded.result.softwareTeamId}/pods/dev/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          softwareTeamRoot: OTHER_OPERATION_ROOT,
          member: {
            id: "override",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            permission_policy: "builtin:standard",
            cwd: ".",
          },
        }),
      });
      const overrideBody = await overrideResponse.json() as { ok: boolean; result: { warnings?: string[] } };

      expect(overrideResponse.status).toBe(201);
      expect(overrideBody.result.warnings).toEqual([
        'dev.override: permission_policy ref="builtin:standard" origin=builtin launch_posture=floor',
        "later launch warning",
      ]);
      expect(bindings[1]?.launchPosture).toBe("floor");
    } finally {
      db.close();
    }
  });

  it("keeps launch outcomes identical while carrying discovery on the software-team-up result", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    } as RuntimeAdapter;
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: fsOps(),
      });
      const absent = await setup.podInstantiator.instantiate(softwareTeamYaml({ name: "policy-absent" }), SOFTWARE_TEAM_ROOT);
      const attached = await setup.podInstantiator.instantiate(
        softwareTeamYaml({ name: "policy-attached", softwareTeamPolicy: "builtin:locked" }),
        SOFTWARE_TEAM_ROOT,
      );

      expect(absent.ok).toBe(true);
      expect(attached.ok).toBe(true);
      if (!absent.ok || !attached.ok) return;
      expect(absent.result.nodes.map(({ logicalId, status }) => ({ logicalId, status })))
        .toEqual(attached.result.nodes.map(({ logicalId, status }) => ({ logicalId, status })));
      expect(bindings).toHaveLength(2);
      expect(policyLines(absent.result.warnings ?? [])).toEqual([
        "dev.impl: permission_policy absent; launch_posture=floor",
      ]);
      expect(policyLines(attached.result.warnings ?? [])).toEqual([
        'dev.impl: permission_policy ref="builtin:locked" origin=builtin launch_posture=floor',
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps SYSTEM setup preflight policy-blind while SoftwareTeam lifecycle preflight discovers policy", async () => {
    const home = mkdtempSync(join(tmpdir(), "seam-c-system-preflight-"));
    tempDirs.push(home);
    const system = new SystemPreflight({
      exec: async (cmd) => cmd === "tmux -V" ? "tmux 3.6" : "",
      configStore: {
        resolve: () => ({
          daemon: { host: "127.0.0.1", port: 0 },
          db: { path: join(home, "softwareteam.db") },
          transcripts: { path: join(home, "transcripts") },
        }),
      } as never,
      getDaemonStatus: async () => ({ state: "stopped" }),
      softwareteamHome: home,
    });

    const systemResult = await system.run({ port: 0 });
    expect(JSON.stringify(systemResult)).not.toContain("permission_policy");

    const lifecycleResult = await softwareTeamPreflight({
      softwareTeamSpecYaml: softwareTeamYaml({ softwareTeamPolicy: "builtin:standard" }),
      softwareTeamRoot: SOFTWARE_TEAM_ROOT,
      fsOps: fsOps(),
    });
    expect(policyLines(lifecycleResult.warnings)).toHaveLength(1);
  });

  it("rejects an invalid ref upstream and never misreports it as floor discovery", async () => {
    const invalid = await softwareTeamPreflight({
      softwareTeamSpecYaml: softwareTeamYaml({ softwareTeamPolicy: "builtin:missing" }),
      softwareTeamRoot: SOFTWARE_TEAM_ROOT,
      fsOps: fsOps(),
    });

    expect(invalid.ready).toBe(false);
    expect(invalid.errors.join("\n")).toContain("unknown built-in policy 'missing'");
    expect(policyLines(invalid.warnings)).toEqual([]);

    const valid = await softwareTeamPreflight({
      softwareTeamSpecYaml: softwareTeamYaml({ softwareTeamPolicy: "builtin:standard" }),
      softwareTeamRoot: SOFTWARE_TEAM_ROOT,
      fsOps: fsOps(),
    });
    expect(valid.ready).toBe(true);
    expect(policyLines(valid.warnings)).toEqual([
      'dev.impl: permission_policy ref="builtin:standard" origin=builtin launch_posture=floor',
    ]);
  });
});
