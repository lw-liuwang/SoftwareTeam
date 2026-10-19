import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { reconcileSkillLoadout } from "../src/domain/skill-catalog.js";
import { PodSoftwareTeamInstantiator } from "../src/domain/software-team-spec-instantiator.js";
import { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { ContinuityPolicyMaterializer } from "../src/domain/continuity-policy-materializer.js";
import { parseWatchdogSpec } from "../src/domain/watchdog-policy-engine.js";
import { SoftwareTeamSpecCodec } from "../src/domain/software-team-spec-codec.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SoftwareTeamSpec } from "../src/domain/types.js";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockAdapter(runtime = "claude-code"): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
}

const SOFTWARE_TEAM_ROOT = "/project/software-teams/my-software-team";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function makeSoftwareTeamSpec(overrides?: Partial<SoftwareTeamSpec>): SoftwareTeamSpec {
  return {
    version: "0.2", name: "test-software-team",
    pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
    edges: [],
    ...overrides,
  };
}

describe("PodSoftwareTeamInstantiator", () => {
  function setup(
    fsFiles?: Record<string, string>,
    extraAdapters?: Record<string, RuntimeAdapter>,
    topologyRootResolver?: () => string,
    onboardingEnabledResolver?: () => boolean,
    continuityPolicyMaterializer?: Pick<ContinuityPolicyMaterializer, "arm">,
    extraDeps?: Record<string, unknown>,
  ) {
    const db = createFullTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const adapter = mockAdapter();
    const codexAdapter = mockAdapter("codex");
    const files = fsFiles ?? { [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") };
    const fsOps = mockFs(files);

    const instDeps: any = {
      db, softwareTeamRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator: startupOrch,
      fsOps, adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal"), ...(extraAdapters ?? {}) },
      tmuxAdapter: tmux,
      ...(topologyRootResolver ? { topologyRootResolver } : {}),
      ...(onboardingEnabledResolver ? { onboardingEnabledResolver } : {}),
      ...(continuityPolicyMaterializer ? { continuityPolicyMaterializer } : {}),
      ...(extraDeps ?? {}),
    };
    const inst = new PodSoftwareTeamInstantiator(instDeps);

    return { db, softwareTeamRepo, podRepo, sessionRegistry, eventBus, inst, adapter, codexAdapter, tmux };
  }

  // T1: valid softwareTeam instantiates pods + nodes + edges
  it("instantiates pods + nodes correctly", async () => {
    const { db, inst } = setup();
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.softwareTeamId).toBeDefined();
      expect(result.result.nodes).toHaveLength(1);
    }
    db.close();
  });

  // T2: resolved spec identity persisted
  it("persists resolved spec identity on node", async () => {
    const { db, softwareTeamRepo, inst } = setup();
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      const node = softwareTeam!.nodes[0]!;
      expect(node.resolvedSpecName).toBe("impl");
      expect(node.resolvedSpecVersion).toBe("1.0.0");
      expect(node.resolvedSpecHash).toBeTruthy();
    }
    db.close();
  });

  // T3: startup orchestrator called
  it("calls startup orchestrator with adapter", async () => {
    const { db, inst, adapter } = setup();
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    expect(adapter.project).toHaveBeenCalled();
    expect(adapter.checkReady).toHaveBeenCalled();
    db.close();
  });

  // Slice 51-01 stub-runtime — TEST-ONLY RED (undisputed mechanical FACT 2): the NORMAL-SEAT
  // preflight→materialize→instantiate path DISPATCHES to the runtime: stub adapter that is injected into
  // the instantiator — proven by the injected adapter's REAL lifecycle methods being invoked. RED now
  // because instantiate() runs softwareTeamPreflight first (software-team-spec-instantiator.ts:1039) and SUPPORTED_RUNTIMES
  // rejects "stub" (same source gate as FACT1), so dispatch never happens. This is NOT a production-
  // registry proof — the startup.ts :710/:898 registration is a SEPARATE first-production RED in the
  // revised packet (composition via createDaemon/assembled instantiator + real restore/successor path);
  // this test must not be read as satisfying that requirement by direct injection. NO disputed surface.
  it("FACT2: normal-seat instantiate DISPATCHES to the injected stub adapter (real lifecycle calls) [RED until preflight accepts stub]", async () => {
    const stubAdapter = mockAdapter("stub");
    const { db, inst } = setup(undefined, { stub: stubAdapter });
    const spec = makeSoftwareTeamSpec({
      pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "stub", cwd: "." }], edges: [] }],
    });
    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(spec), SOFTWARE_TEAM_ROOT);
    expect(result.ok, `instantiate must succeed for runtime: stub; got: ${JSON.stringify(result)}`).toBe(true);
    // dispatch proof: the injected stub adapter's REAL lifecycle methods were actually invoked.
    expect(stubAdapter.project, "instantiate must dispatch project() to the injected stub adapter").toHaveBeenCalled();
    expect(stubAdapter.checkReady, "instantiate must dispatch checkReady() to the injected stub adapter").toHaveBeenCalled();
    if (result.ok) expect(result.result.nodes).toHaveLength(1);
    db.close();
  });

  it("passes SoftwareTeamSpec member model into the Codex runtime binding", async () => {
    const { db, inst, codexAdapter } = setup();
    const spec = makeSoftwareTeamSpec({
      pods: [{
        id: "dev",
        label: "Dev",
        members: [{
          id: "impl",
          agentRef: "local:agents/impl",
          profile: "default",
          runtime: "codex",
          model: "gpt-5.5",
          cwd: ".",
        }],
        edges: [],
      }],
    });

    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(spec), SOFTWARE_TEAM_ROOT);

    expect(result.ok).toBe(true);
    const launchHarness = codexAdapter.launchHarness as ReturnType<typeof vi.fn>;
    expect(launchHarness).toHaveBeenCalled();
    expect(launchHarness.mock.calls[0]?.[0].model).toBe("gpt-5.5");
    db.close();
  });

  it("uses cwdOverride for launched nodes without changing spec-relative agent resolution", async () => {
    const { db, softwareTeamRepo, sessionRegistry, inst, adapter } = setup();
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT, { cwdOverride: "/workspace/project" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId)!;
      expect(softwareTeam.nodes[0]!.cwd).toBe("/workspace/project");
      const sessions = sessionRegistry.getSessionsForSoftwareTeam(result.result.softwareTeamId);
      expect(sessions[0]!.startupStatus).toBe("ready");
      const planArg = (adapter.project as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(planArg.cwd).toBe("/workspace/project");
    }
    db.close();
  });

  it("refuses to start a harness when managed skill projection fails", async () => {
    const skillReconciler = vi.fn(() => ({
      ok: false,
      applied: false,
      freshLaunchRequired: false,
      runtime: "claude-code",
      targetRoot: "/project/.claude/skills",
      manifestPath: "/project/.softwareteam/skill-loadouts/claude-code.json",
      receipts: [],
      removed: [],
      errors: [{ code: "target_conflict", message: "operator-owned skill differs" }],
    }));
    const { db, inst, adapter } = setup(undefined, undefined, undefined, undefined, undefined, { skillReconciler });

    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec()), SOFTWARE_TEAM_ROOT);

    expect(result.ok).toBe(false);
    expect(skillReconciler).toHaveBeenCalledOnce();
    expect(adapter.project).not.toHaveBeenCalled();
    if (!result.ok && "message" in result) expect(result.message).toContain("target_conflict: operator-owned skill differs");
    db.close();
  });

  it("uses the configured catalog for both preflight and launch resolution", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "softwareteam-instantiator-skill-catalog-"));
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const catalog = nodePath.join(root, "managed-skills");
      const project = nodePath.join(root, "project");
      fs.mkdirSync(nodePath.join(catalog, "topology-skill"), { recursive: true });
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(nodePath.join(catalog, "catalog.yaml"), "schema: softwareteam.skill-catalog/v1\nsystem: []\n");
      fs.writeFileSync(
        nodePath.join(catalog, "topology-skill", "SKILL.md"),
        "---\nname: topology-skill\ndescription: Use when testing configured catalog launch resolution.\n---\n\n# Topology skill\n",
      );
      execFileSync("git", ["-C", catalog, "init", "-q"]);
      execFileSync("git", ["-C", catalog, "config", "user.email", "test@softwareteam.invalid"]);
      execFileSync("git", ["-C", catalog, "config", "user.name", "SoftwareTeam Test"]);
      execFileSync("git", ["-C", catalog, "add", "."]);
      execFileSync("git", ["-C", catalog, "commit", "-qm", "fixture"]);

      const skillReconciler = vi.fn(() => ({
        ok: true,
        applied: false,
        freshLaunchRequired: false,
        runtime: "codex",
        targetRoot: nodePath.join(project, ".agents", "skills"),
        manifestPath: nodePath.join(project, ".softwareteam", "skill-loadouts", "codex.json"),
        receipts: [],
        removed: [],
        errors: [],
      }));
      const files = {
        [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: `name: impl
version: "1.0.0"
imports:
  - ref: local:../shared
resources:
  skills: []
profiles:
  default:
    uses:
      skills: [topology-skill]`,
        [`${SOFTWARE_TEAM_ROOT}/agents/shared/agent.yaml`]: "name: shared\nversion: \"1.0.0\"\nresources:\n  skills: []\nprofiles: {}\n",
      };
      const setupResult = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: mockFs(files),
        skillsRootResolver: () => catalog,
        skillReconciler,
      });
      db = setupResult.db;
      const softwareTeam = makeSoftwareTeamSpec({
        pods: [{
          id: "dev", label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: project }],
          edges: [],
        }],
      });

      const result = await setupResult.inst.instantiate(SoftwareTeamSpecCodec.serialize(softwareTeam), SOFTWARE_TEAM_ROOT);

      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(skillReconciler).toHaveBeenCalledOnce();
      expect(skillReconciler.mock.calls[0]?.[0].loadout.entries.map((entry: { id: string }) => entry.id)).toContain("topology-skill");
    } finally {
      db?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["claude-code", "codex"] as const)("reports bundle precedence after real %s reconciliation", async (runtime) => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "instantiator-bundle-precedence-"));
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const installed = nodePath.join(root, "installed");
      const catalog = nodePath.join(root, "catalog");
      const project = nodePath.join(root, "project");
      const skill = (body: string) => `---\nname: shared\ndescription: Skill fixture\n---\n${body}\n`;
      for (const dir of ["installed/agents/impl", "installed/agents/impl/skills/shared", "catalog/shared", "project"]) fs.mkdirSync(nodePath.join(root, dir), { recursive: true });
      fs.writeFileSync(nodePath.join(catalog, "catalog.yaml"), "schema: softwareteam.skill-catalog/v1\nsystem: []\n");
      fs.writeFileSync(nodePath.join(catalog, "shared/SKILL.md"), skill("Catalog"));
      fs.writeFileSync(nodePath.join(installed, "agents/impl/skills/shared/SKILL.md"), skill("Bundle"));
      fs.writeFileSync(nodePath.join(installed, "agents/impl/agent.yaml"), 'name: impl\nversion: "1.0"\nresources:\n  skills:\n    - id: shared\n      path: skills/shared\nprofiles:\n  default:\n    uses:\n      skills: [shared]\n');
      execFileSync("git", ["init", "-q", catalog]);
      execFileSync("git", ["-C", catalog, "add", "."]);
      execFileSync("git", ["-C", catalog, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "catalog"]);
      const reconciler = vi.fn(reconcileSkillLoadout);
      const fixture = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: fs.existsSync },
        skillsRootResolver: () => catalog, skillReconciler: reconciler,
      });
      db = fixture.db;
      const softwareTeam = makeSoftwareTeamSpec({ pods: [{ id: "dev", label: "Dev", edges: [], members: [
        { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime, cwd: project },
      ] }] });
      const result = await fixture.inst.instantiate(SoftwareTeamSpecCodec.serialize(softwareTeam), installed);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(reconciler).toHaveBeenCalledOnce();
      expect(reconciler.mock.results[0]?.value.ok).toBe(true);
      const owner = reconciler.mock.calls[0]![0].topologyOwner;
      expect(JSON.stringify(result)).toContain(`${owner}: skill_bundle_precedence`);
      expect(JSON.stringify(result)).toContain("the managed catalog was not changed");
      const selected = reconciler.mock.calls[0]![0].loadout.entries.find(e => e.id === "shared")!;
      expect(selected.sourceDir).toBe(nodePath.join(installed, "agents/impl/skills/shared"));
      expect(fs.readFileSync(nodePath.join(project, runtime === "codex" ? ".agents" : ".claude", "skills/shared/SKILL.md"), "utf8")).toBe(skill("Bundle"));
      const adapter = runtime === "codex" ? fixture.codexAdapter : fixture.adapter;
      const plan = vi.mocked(adapter.project).mock.calls[0]![0];
      expect(plan.entries.find(e => e.effectiveId === "shared")?.absolutePath).toContain("installed/agents/impl/skills/shared");
    } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["claude-code", "codex"] as const)("projects a selected plugin's skills for %s and keeps a same-name skill it does not own", async (runtime) => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "instantiator-plugin-skills-"));
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const installed = nodePath.join(root, "installed");
      const plugin = nodePath.join(installed, "agents/impl/plugins/core");
      const project = nodePath.join(root, "project");
      const skills = nodePath.join(project, runtime === "codex" ? ".agents" : ".claude", "skills");
      const skill = (id: string, body: string) => `---\nname: ${id}\ndescription: Skill fixture\n---\n${body}\n`;
      for (const manifest of [".claude-plugin", ".codex-plugin"]) {
        fs.mkdirSync(nodePath.join(plugin, manifest), { recursive: true });
        fs.writeFileSync(nodePath.join(plugin, manifest, "plugin.json"), '{"name":"core","version":"0.1.4"}');
      }
      for (const id of ["delegating-work", "softwareteam-skills", "queue-handoff"]) {
        fs.mkdirSync(nodePath.join(plugin, "skills", id), { recursive: true });
        fs.writeFileSync(nodePath.join(plugin, "skills", id, "SKILL.md"), skill(id, "Plugin"));
      }
      fs.mkdirSync(nodePath.join(skills, "delegating-work"), { recursive: true });
      fs.writeFileSync(nodePath.join(skills, "delegating-work/SKILL.md"), skill("delegating-work", "The project's own"));
      fs.writeFileSync(nodePath.join(installed, "agents/impl/agent.yaml"), 'name: impl\nversion: "1.0"\nresources:\n  plugins:\n    - id: core\n      source:\n        kind: local\n        path: plugins/core\nprofiles:\n  default:\n    uses:\n      plugins: [core]\n');
      const reconciler = vi.fn(reconcileSkillLoadout);
      const fixture = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: fs.existsSync },
        skillsRootResolver: () => nodePath.join(root, "no-catalog"), skillReconciler: reconciler,
      });
      db = fixture.db;
      const softwareTeam = makeSoftwareTeamSpec({ pods: [{ id: "dev", label: "Dev", edges: [], members: [
        { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime, cwd: project },
      ] }] });
      const result = await fixture.inst.instantiate(SoftwareTeamSpecCodec.serialize(softwareTeam), installed);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(reconciler.mock.results[0]?.value.ok).toBe(true);
      for (const id of ["softwareteam-skills", "queue-handoff"]) {
        expect(fs.readFileSync(nodePath.join(skills, id, "SKILL.md"), "utf8")).toBe(skill(id, "Plugin"));
      }
      expect(fs.readFileSync(nodePath.join(skills, "delegating-work/SKILL.md"), "utf8")).toBe(skill("delegating-work", "The project's own"));
      const owner = reconciler.mock.calls[0]![0].topologyOwner;
      expect(JSON.stringify(result)).toContain(`${owner}: plugin_skill_kept: delegating-work`);
    } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("starts the seat without plugin skills when they cannot be projected, and says why", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "instantiator-plugin-skills-refused-"));
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const installed = nodePath.join(root, "installed");
      const plugin = nodePath.join(installed, "agents/impl/plugins/core");
      const project = nodePath.join(root, "project");
      fs.mkdirSync(nodePath.join(plugin, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(nodePath.join(plugin, ".claude-plugin/plugin.json"), '{"name":"core","version":"0.1.4"}');
      fs.mkdirSync(nodePath.join(plugin, "skills/queue-handoff"), { recursive: true });
      fs.writeFileSync(nodePath.join(plugin, "skills/queue-handoff/SKILL.md"), "---\nname: queue-handoff\ndescription: Skill fixture\n---\nPlugin\n");
      fs.writeFileSync(nodePath.join(installed, "agents/impl/agent.yaml"), 'name: impl\nversion: "1.0"\nresources:\n  plugins:\n    - id: core\n      source:\n        kind: local\n        path: plugins/core\nprofiles:\n  default:\n    uses:\n      plugins: [core]\n');
      // The project keeps its own ignore file where SoftwareTeam would add its exclusions.
      fs.mkdirSync(nodePath.join(project, ".claude/skills"), { recursive: true });
      fs.writeFileSync(nodePath.join(project, ".claude/skills/.gitignore"), "*.tmp\n");
      execFileSync("git", ["init", "-q", project]);
      const reconciler = vi.fn(reconcileSkillLoadout);
      const fixture = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: fs.existsSync },
        skillsRootResolver: () => nodePath.join(root, "no-catalog"), skillReconciler: reconciler,
      });
      db = fixture.db;
      const softwareTeam = makeSoftwareTeamSpec({ pods: [{ id: "dev", label: "Dev", edges: [], members: [
        { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: project },
      ] }] });
      const result = await fixture.inst.instantiate(SoftwareTeamSpecCodec.serialize(softwareTeam), installed);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(reconciler.mock.results.map((call) => call.value.ok)).toEqual([false, true]);
      expect(JSON.stringify(result)).toContain("plugin_skills_not_projected: git_exclusion_failed");
      expect(fs.existsSync(nodePath.join(project, ".claude/skills/queue-handoff"))).toBe(false);
      expect(fs.readFileSync(nodePath.join(project, ".claude/skills/.gitignore"), "utf8")).toBe("*.tmp\n");
    } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("dedupes role guidance when the same file is referenced by resources.guidance and startup.files", async () => {
    const db = createFullTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const adapter = mockAdapter();
    const fsOps = mockFs({
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: `
name: impl
version: "1.0.0"
resources:
  skills: []
  guidance:
    - id: role
      path: guidance/role.md
      target: claude_md
      merge: managed_block
startup:
  files:
    - path: guidance/role.md
      delivery_hint: guidance_merge
profiles:
  default:
    uses:
      skills: []
      guidance: [role]
      subagents: []
      runtime_resources: []
`.trim(),
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/guidance/role.md`]: "# role",
    });

    const inst = new PodSoftwareTeamInstantiator({
      db, softwareTeamRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator: startupOrch,
      fsOps, adapters: { "claude-code": adapter, codex: mockAdapter(), terminal: mockAdapter() },
      tmuxAdapter: tmux,
    });

    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec()), SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    const deliveredFiles = (adapter.deliverStartup as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[0] as Array<{ path: string }>);
    expect(deliveredFiles.some((f) => f.path === "guidance/role.md")).toBe(false);
    const projectedPlan = (adapter.project as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(projectedPlan.entries.some((entry: { category: string; effectiveId: string }) => entry.category === "guidance" && entry.effectiveId === "role")).toBe(true);
    db.close();
  });

  it("injects SoftwareTeam identity context into launched agent startup actions", async () => {
    const { db, inst, tmux } = setup();
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);

    expect(result.ok).toBe(true);

    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    const identityCall = sendText.mock.calls.find(([, text]) =>
      typeof text === "string" && text.includes("SoftwareTeam session identity:"),
    );

    expect(identityCall).toBeDefined();
    expect(identityCall?.[0]).toBe("dev-impl@test-software-team");
    expect(identityCall?.[1]).toMatch(/^dev-impl@test-software-team\nSoftwareTeam session identity:/);
    // Identity fields preserved
    expect(identityCall?.[1]).toContain("- softwareTeam: test-software-team");
    expect(identityCall?.[1]).toContain("- pod: dev");
    expect(identityCall?.[1]).toContain("- member: impl");
    expect(identityCall?.[1]).toContain("- logical_id: dev.impl");
    expect(identityCall?.[1]).toContain("- session: dev-impl@test-software-team");
    // Whoami pointer
    expect(identityCall?.[1]).toContain("SoftwareTeam whoami --json");

    db.close();
  });

  it("includes softwareteam-start.md onboarding overlay in resolved startup files", async () => {
    const { db, inst } = setup();
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);

    // Check startup context for softwareteam-start.md
    const ctxRows = db.prepare("SELECT * FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    expect(ctxRows.length).toBeGreaterThan(0);
    const allFiles = ctxRows.flatMap((r) => JSON.parse(r.resolved_files_json) as Array<{ path: string }>);
    const onboarding = allFiles.find((f) => f.path === "softwareteam-start.md");
    expect(onboarding).toBeDefined();

    db.close();
  });

  it("delivers the two-part default onboarding pack on fresh starts", async () => {
    const { db, inst } = setup();
    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec()), SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);

    const rows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const files = rows.flatMap((row) => JSON.parse(row.resolved_files_json) as Array<{
      path: string;
      required: boolean;
      appliesOn: string[];
    }>);
    expect(files.filter((file) => file.path.startsWith("softwareteam-onboarding-"))).toEqual([
      expect.objectContaining({
        path: "softwareteam-onboarding-01.md",
        required: true,
        appliesOn: ["fresh_start"],
      }),
      expect.objectContaining({
        path: "softwareteam-onboarding-02.md",
        required: true,
        appliesOn: ["fresh_start"],
      }),
    ]);

    db.close();
  });

  it("omits the default onboarding pack when the typed setting is off", async () => {
    const { db, inst } = setup(undefined, undefined, undefined, () => false);
    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec()), SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);

    const rows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const paths = rows.flatMap((row) =>
      (JSON.parse(row.resolved_files_json) as Array<{ path: string }>).map((file) => file.path),
    );
    expect(paths).toContain("softwareteam-start.md");
    expect(paths.some((path) => path.startsWith("softwareteam-onboarding-"))).toBe(false);

    db.close();
  });

  it("does not rewrite an existing SoftwareTeam when onboarding is enabled for future launches", async () => {
    let onboardingEnabled = false;
    const { db, inst } = setup(undefined, undefined, undefined, () => onboardingEnabled);
    const existing = await inst.instantiate(
      SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec({ name: "existing-software-team" })),
      SOFTWARE_TEAM_ROOT,
    );
    expect(existing.ok).toBe(true);
    if (!existing.ok) throw new Error(existing.error);

    const existingNodeId = existing.result.nodes[0]!.id;
    const readStartup = (nodeId: string) => db.prepare(`
      SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime
        FROM node_startup_context
       WHERE node_id = ?
    `).get(nodeId) as Record<string, unknown>;
    const before = readStartup(existingNodeId);

    onboardingEnabled = true;
    const future = await inst.instantiate(
      SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec({ name: "future-software-team" })),
      SOFTWARE_TEAM_ROOT,
    );
    expect(future.ok).toBe(true);
    if (!future.ok) throw new Error(future.error);

    expect(readStartup(existingNodeId)).toEqual(before);

    db.close();
  });

  it("always includes the default culture when the SoftwareTeam has no culture_file", async () => {
    const { db, inst } = setup();
    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec()), SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);

    const ctxRows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const allFiles = ctxRows.flatMap((row) => JSON.parse(row.resolved_files_json) as Array<{
      path: string;
      deliveryHint: string;
      required: boolean;
    }>);
    expect(allFiles).toContainEqual(expect.objectContaining({
      path: "CULTURE-default.md",
      deliveryHint: "guidance_merge",
      required: true,
    }));

    db.close();
  });

  it("orders the default culture before the SoftwareTeam culture overlay", async () => {
    const { db, inst } = setup();
    const spec = makeSoftwareTeamSpec({ cultureFile: "CULTURE.md" });
    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(spec), SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);

    const ctxRows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const paths = ctxRows.flatMap((row) =>
      (JSON.parse(row.resolved_files_json) as Array<{ path: string }>).map((file) => file.path),
    );
    expect(paths).toContain("CULTURE-default.md");
    expect(paths).toContain("CULTURE.md");
    expect(paths.indexOf("CULTURE-default.md")).toBeLessThan(paths.indexOf("CULTURE.md"));

    db.close();
  });

  it("CULTURE-default.md ships the lightweight operating-model floor", () => {
    const { existsSync, readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const assetPath = resolve(import.meta.dirname, "../src/domain/../../assets/guidance/CULTURE-default.md");
    expect(existsSync(assetPath)).toBe(true);
    const content = readFileSync(assetPath, "utf8");
    expect(content).toContain("Pragmatic truth-seeking");
    expect(content).toContain("Principles over rules");
    expect(content).toContain("Ship good, working product");
    expect(content).toContain("Match rigor to stakes");
    expect(content).not.toContain("full stop on new production");
  });

  it("softwareteam-start.md asset exists on disk and guards the thin-overlay contract", () => {
    const { existsSync, readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const assetPath = resolve(import.meta.dirname, "../src/domain/../../assets/guidance/softwareteam-start.md");
    expect(existsSync(assetPath)).toBe(true);
    const content = readFileSync(assetPath, "utf8");
    // The thin overlay's positive guarantees: identity first, the two peer verbs,
    // the thin-transcript warning (guards a live per-runtime recording condition),
    // and an explicit ask-don't-infer close.
    expect(content).toContain("SoftwareTeam whoami --json");
    expect(content).toContain("SoftwareTeam send");
    expect(content).toContain("SoftwareTeam capture");
    // (wrap-safe fragments: the source is hard-wrapped markdown)
    expect(content).toContain("transcript capture is unreliable");
    expect(content).toContain("mean the session was quiet");
    expect(content).toContain("say so rather than inferring");
    // The product decision to keep the boot overlay thin, pinned as absences: no operating-model SDLC and
    // no skill-library routing may ride the default boot overlay (they are opt-in
    // layers, delivered by profile/startup config, never hardcoded here).
    expect(content).not.toContain("mission-slice-sop");
    expect(content).not.toContain("plan-lock");
    expect(content).not.toContain("softwareteam-user");
    expect(content).not.toContain("softwareteam-skills");
    expect(content).toContain("softwareteam-onboarding-01.md");
    expect(content).toContain("onboarding.default_pack.enabled");
    // Thin means thin: a hard ceiling so accretion back toward the 3.6KB pre-trim
    // overlay fails loudly instead of silently.
    expect(content.length).toBeLessThan(2500);
  });

  // T4: partial failure — one node startup fails, other succeeds
  it("partial node startup failure does not corrupt other nodes", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${SOFTWARE_TEAM_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    };

    const db = createFullTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });

    // Startup orchestrator that fails for qa
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const origStartNode = startupOrch.startNode.bind(startupOrch);
    let callCount = 0;
    startupOrch.startNode = async (input) => {
      callCount++;
      if (callCount === 2) {
        // Fail the second node's startup
        sessionRegistry.updateStartupStatus(input.sessionId, "failed");
        return { ok: false, startupStatus: "failed", errors: ["simulated failure"] };
      }
      return origStartNode(input);
    };

    const adapter = mockAdapter();
    const fsOps = mockFs(files);
    const inst = new PodSoftwareTeamInstantiator({
      db, softwareTeamRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch, fsOps,
      adapters: { "claude-code": adapter },
    });

    const spec = makeSoftwareTeamSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    });
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const launched = result.result.nodes.filter((n) => n.status === "launched");
      const failed = result.result.nodes.filter((n) => n.status === "failed");
      expect(launched.length).toBe(1);
      expect(failed.length).toBe(1);
    }
    db.close();
  });

  // T5: same DB handle shared
  it("validates same DB handle", () => {
    const db = createFullTestDb();
    const db2 = createFullTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    expect(() => new PodSoftwareTeamInstantiator({
      db: db2, softwareTeamRepo, podRepo: new PodRepository(db2), sessionRegistry: new SessionRegistry(db2),
      eventBus: new EventBus(db2), nodeLauncher: new NodeLauncher({ db: db2, softwareTeamRepo: new SoftwareTeamRepository(db2), sessionRegistry: new SessionRegistry(db2), eventBus: new EventBus(db2), tmuxAdapter: mockTmux() }),
      startupOrchestrator: new StartupOrchestrator({ db: db2, sessionRegistry: new SessionRegistry(db2), eventBus: new EventBus(db2), tmuxAdapter: mockTmux() }),
      fsOps: mockFs({}), adapters: {},
    })).toThrow(/same db handle/);
    db.close();
    db2.close();
  });

  // T7: emits startup lifecycle events
  it("emits startup lifecycle events", async () => {
    const { db, eventBus, inst } = setup();
    const events: string[] = [];
    eventBus.subscribe((e) => events.push(e.type));
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(events).toContain("node.startup_pending");
    expect(events).toContain("node.startup_ready");
    db.close();
  });

  // T8: pod membership persisted
  it("persists pod membership on nodes", async () => {
    const { db, softwareTeamRepo, inst } = setup();
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      expect(softwareTeam!.nodes[0]!.podId).toBeTruthy();
    }
    db.close();
  });

  // CP2-R1: Two pods with same member name create distinct nodes (qualified logical_id)
  it("two pods with same member name create distinct nodes", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, softwareTeamRepo, inst } = setup(files);
    const spec = makeSoftwareTeamSpec({
      pods: [
        { id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] },
        { id: "arch", label: "Arch", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] },
      ],
    });
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      expect(softwareTeam!.nodes).toHaveLength(2);
      const logicalIds = softwareTeam!.nodes.map((n) => n.logicalId).sort();
      expect(logicalIds).toEqual(["arch.impl", "dev.impl"]);
    }
    db.close();
  });

  // CP2-R2: Narrowed restore-policy persisted to both node and session
  it("persists narrowed restore-policy to node and session", async () => {
    // Agent spec has checkpoint_only default, member requests resume_if_possible (broadening — should fail)
    // Instead: spec has resume_if_possible, member narrows to relaunch_fresh
    const narrowingAgent = `name: impl\nversion: "1.0.0"\ndefaults:\n  lifecycle:\n    compaction_strategy: harness_native\n    restore_policy: resume_if_possible\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
    const files = { [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: narrowingAgent };
    const { db, softwareTeamRepo, sessionRegistry, inst } = setup(files);
    const spec = makeSoftwareTeamSpec({
      pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", restorePolicy: "relaunch_fresh" }], edges: [] }],
    });
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
      expect(softwareTeam!.nodes[0]!.restorePolicy).toBe("relaunch_fresh");
      // Check session too
      const sessions = sessionRegistry.getSessionsForSoftwareTeam(result.result.softwareTeamId);
      expect(sessions[0]!.restorePolicy).toBe("relaunch_fresh");
    }
    db.close();
  });

  it("threads the three-level resolved mechanic through the real launch path into the cutover registration", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: `
version: "0.2"
name: impl
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: apprentice-handover
    mechanic: default-mechanic@default-software-team
resources:
  skills: []
profiles:
  default:
    lifecycle:
      mechanic: profile-mechanic@profile-software-team
    uses:
      skills: []
`.trim(),
    };
    const register = vi.fn()
      .mockReturnValueOnce({ jobId: "prepare-job" })
      .mockReturnValueOnce({ jobId: "cutover-job" });
    const materializer = new ContinuityPolicyMaterializer({ register }, () => null);
    const { db, inst } = setup(files, undefined, undefined, undefined, materializer);
    const yaml = `
version: "0.2"
name: test-software-team
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
        mechanic: member-mechanic@member-software-team
    edges: []
edges: []
`;

    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);

    expect(result.ok).toBe(true);
    expect(register).toHaveBeenCalledTimes(2);
    const cutover = parseWatchdogSpec(register.mock.calls[1]![0].specYaml);
    expect(cutover.context).toMatchObject({
      continuity_action: { destination: "member-mechanic@member-software-team" },
    });
    db.close();
  });

  it("refuses apprentice arming without a mechanic using field, layering, and SOP teaching", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: `
version: "0.2"
name: impl
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: apprentice-handover
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`.trim(),
    };
    const register = vi.fn().mockReturnValue({ jobId: "must-not-arm" });
    const materializer = new ContinuityPolicyMaterializer({ register }, () => "/tmp/transcript.jsonl");
    const { db, inst } = setup(files, undefined, undefined, undefined, materializer);

    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec()), SOFTWARE_TEAM_ROOT);

    expect(result.ok).toBe(true);
    expect(register).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toMatch(
      /mechanic.*spec-default.*profile.*member.*continuity\/apprentice-cutover\.md/i,
    );
    db.close();
  });

  // CP2-R3: Topological ordering enforced (delegates_to edge)
  it("launches nodes in topological order based on edges", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${SOFTWARE_TEAM_ROOT}/agents/orch/agent.yaml`]: agentYaml("orch"),
    };
    const { db, inst } = setup(files);
    const spec = makeSoftwareTeamSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "worker", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "lead", agentRef: "local:agents/orch", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [{ kind: "delegates_to", from: "lead", to: "worker" }],
      }],
    });
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // lead should be launched before worker (delegates_to: lead -> worker means lead first)
      const leadIdx = result.result.nodes.findIndex((n) => n.logicalId === "dev.lead");
      const workerIdx = result.result.nodes.findIndex((n) => n.logicalId === "dev.worker");
      expect(leadIdx).toBeLessThan(workerIdx);
    }
    db.close();
  });

  // NS-T01: canonical session name {pod}-{member}@{softwareTeam}
  it("launches nodes with canonical session names", async () => {
    const { db, tmux, inst } = setup();
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    // tmux createSession was called with canonical name
    const createSession = tmux.createSession as ReturnType<typeof vi.fn>;
    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession.mock.calls[0]![0]).toBe("dev-impl@test-software-team");
    db.close();
  });

  // NS-T01: invalid session name characters caught at preflight within instantiation
  it("rejects invalid session name characters with per-component error at preflight", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, inst } = setup(files);
    const spec = makeSoftwareTeamSpec({
      name: "my softwareTeam",
      pods: [{
        id: "dev 1", label: "Dev",
        members: [{ id: "impl!", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
    });
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok && "errors" in result) {
      expect(result.errors.some((e: string) => e.includes("pod name") && e.includes(" "))).toBe(true);
      expect(result.errors.some((e: string) => e.includes("member name") && e.includes("!"))).toBe(true);
      expect(result.errors.some((e: string) => e.includes("SoftwareTeam name") && e.includes(" "))).toBe(true);
    }
    db.close();
  });

  // NS-T03: terminal member instantiation — skips agent resolution, executes startup
  it("instantiates terminal member without agent resolution", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, tmux, softwareTeamRepo, inst } = setup(files);
    const spec = makeSoftwareTeamSpec({
      pods: [
        {
          id: "dev", label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
          edges: [],
        },
        {
          id: "infra", label: "Infrastructure",
          members: [{ id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: ".", startup: { files: [], actions: [{ type: "send_text", value: "npm run dev", phase: "after_ready", idempotent: true, appliesOn: ["fresh_start"] }] } }],
          edges: [],
        },
      ],
    });
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes).toHaveLength(2);
      const launched = result.result.nodes.filter((n) => n.status === "launched");
      expect(launched).toHaveLength(2);
      // Terminal node was launched with canonical name
      const createSession = tmux.createSession as ReturnType<typeof vi.fn>;
      const sessionNames = createSession.mock.calls.map((c: string[]) => c[0]);
      expect(sessionNames).toContain("infra-server@test-software-team");
    }
    db.close();
  });

  // NS-T03: terminal member restore_policy propagated to session
  it("terminal member propagates checkpoint_only restore_policy to session row", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, inst } = setup(files);
    const spec = makeSoftwareTeamSpec({
      pods: [{
        id: "infra", label: "Infra",
        members: [{ id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "." }],
        edges: [],
      }],
    });
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Check session has checkpoint_only
      const sessions = db.prepare("SELECT restore_policy FROM sessions").all() as Array<{ restore_policy: string }>;
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0]!.restore_policy).toBe("checkpoint_only");
    }
    db.close();
  });

  // NS-T03: terminal node visible in node-inventory as infrastructure
  it("terminal-instantiated node appears in inventory with nodeKind infrastructure", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, softwareTeamRepo, inst } = setup(files);
    const spec = makeSoftwareTeamSpec({
      pods: [{
        id: "infra", label: "Infra",
        members: [{ id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "." }],
        edges: [],
      }],
    });
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Verify via node-inventory projection
      const { getNodeInventory } = await import("../src/domain/node-inventory.js");
      const inventory = getNodeInventory(db, result.result.softwareTeamId);
      expect(inventory).toHaveLength(1);
      expect(inventory[0]!.nodeKind).toBe("infrastructure");
      expect(inventory[0]!.runtime).toBe("terminal");
    }
    db.close();
  });

  // CP2-R5: Two-node cycle must fail instantiation
  it("rejects dependency cycle between two nodes", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/a/agent.yaml`]: agentYaml("a"),
      [`${SOFTWARE_TEAM_ROOT}/agents/b/agent.yaml`]: agentYaml("b"),
    };
    const { db, inst } = setup(files);
    const spec = makeSoftwareTeamSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "a", agentRef: "local:agents/a", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "b", agentRef: "local:agents/b", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [
          { kind: "delegates_to", from: "a", to: "b" },
          { kind: "delegates_to", from: "b", to: "a" },
        ],
      }],
    });
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) {
      expect(result.code).toBe("cycle_error");
      expect(result.message).toMatch(/cycle/i);
    }
    db.close();
  });

  // OPR.0.3.2.22 Bug 2 — no orphan softwareTeam record on cycle_error.
  // Reorder fix: computePodLaunchOrder must run BEFORE createSoftwareTeam so a
  // detected cycle returns before any DB write happens. Before the fix,
  // every failed `SoftwareTeam up <builtin>` attempt left an orphan stopped-state
  // softwareTeam record that made retries report "ambiguous library-spec vs
  // restore-target" — the second-order UX trap behind the softwareteam-comms
  // hero-flow paper-cut.
  it("cycle_error: no orphan SoftwareTeam record persists (Bug 2 reorder)", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/a/agent.yaml`]: agentYaml("a"),
      [`${SOFTWARE_TEAM_ROOT}/agents/b/agent.yaml`]: agentYaml("b"),
    };
    const { db, softwareTeamRepo, inst } = setup(files);
    const specName = "orphan-cycle-test-software-team";
    const spec = makeSoftwareTeamSpec({
      name: specName,
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "a", agentRef: "local:agents/a", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "b", agentRef: "local:agents/b", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [
          { kind: "delegates_to", from: "a", to: "b" },
          { kind: "delegates_to", from: "b", to: "a" },
        ],
      }],
    });
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) {
      expect(result.code).toBe("cycle_error");
    }
    // Load-bearing: no softwareTeam record persisted under the spec name.
    const orphans = softwareTeamRepo.findSoftwareTeamsByName(specName);
    expect(orphans, `expected no orphan SoftwareTeam records after cycle_error, found ${JSON.stringify(orphans)}`).toHaveLength(0);
    db.close();
  });

  // OPR.0.3.2.22 Bug 2 — rollback on service_boot_failed (prelaunch-hook
  // failure). Unlike cycle_error, the softwareTeam record + pods have been created
  // by the time the hook runs (the hook needs softwareTeamId), so the fix wraps
  // the failure return with softwareTeamRepo.deleteSoftwareTeam(softwareTeamId).
  it.each(["service_boot_failed", "compose_project_conflict"])("%s: propagates hook refusal and rolls back the created SoftwareTeam record", async (code) => {
    const { db, softwareTeamRepo, inst } = setup();
    const specName = "orphan-prelaunch-test-software-team";
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec({ name: specName }));
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT, {
      prelaunchHook: async () => ({ ok: false, code, message: "test: service boot refused" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) {
      expect(result.code).toBe(code);
    }
    const orphans = softwareTeamRepo.findSoftwareTeamsByName(specName);
    expect(orphans, `expected no orphan SoftwareTeam records after service_boot_failed, found ${JSON.stringify(orphans)}`).toHaveLength(0);
    db.close();
  });

  it.each(["boot-failure", "node-failure", "boot-cleanup-failure", "node-cleanup-failure", "inherited", "inherited-boot-failure"].flatMap(scenario =>
    (["leave_running", "down_and_volumes"] as const).map(policy => ({ scenario, policy })),
  ))("retains or cleans up the actual service project on failed instantiation ($scenario, $policy)", async ({ scenario, policy }) => {
    const { db, softwareTeamRepo, inst, adapter, tmux } = setup();
    try {
      tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
      adapter.project = vi.fn(async () => ({ projected: [], skipped: [], failed: [{ effectiveId: "x", error: "disk full" }] }));
      const commands: string[] = [];
      let currentId: string | undefined;
      const composeAdapter = new ComposeServicesAdapter(async cmd => {
        commands.push(cmd);
        if (cmd.includes("down")) {
          expect(softwareTeamRepo.getServicesRecord(currentId!)).not.toBeNull();
          if (scenario.includes("cleanup-failure")) throw new Error("Docker unavailable during cleanup");
        }
        if (cmd.includes("ps --format json") && (scenario.startsWith("boot-") || scenario === "inherited-boot-failure")) throw new Error("status failed after Compose up succeeded");
        return "";
      });
      const serviceOrchestrator = new ServiceOrchestrator({ softwareTeamRepo, composeAdapter });
      const dbHandle = { db };
      const bootstrap = new BootstrapOrchestrator({ db, softwareTeamRepo, serviceOrchestrator, bootstrapRepo: dbHandle,
        runtimeVerifier: dbHandle, installExecutor: dbHandle, packageInstallService: dbHandle,
      } as ConstructorParameters<typeof BootstrapOrchestrator>[0]);
      const predecessor = scenario.startsWith("inherited") ? softwareTeamRepo.createSoftwareTeam("test-software-team") : undefined;
      if (predecessor) softwareTeamRepo.setServicesRecord(predecessor.id, {
        kind: "compose", specJson: "{}", softwareTeamRoot: SOFTWARE_TEAM_ROOT, composeFile: "compose.yaml", projectName: "legacy-project",
      });
      const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec({ services: {
        kind: "compose", composeFile: "compose.yaml", downPolicy: policy,
      } }));
      type HookResult = { ok: true; rollback?: () => Promise<void> } | { ok: false; code: string; message: string; retainSoftwareTeam?: boolean };
      const hook = await (bootstrap as unknown as { buildServicePrelaunchHook(yaml: string, root: string, stages: unknown[], errors: string[]): Promise<((id: string, replaced: readonly string[]) => Promise<HookResult>) | undefined> })
        .buildServicePrelaunchHook(yaml, SOFTWARE_TEAM_ROOT, [], []);
      expect(hook).toBeDefined();
      const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT, { force: true, prelaunchHook: async (id, replaced) => {
        currentId = id;
        return hook!(id, replaced);
      } });
      expect(result.ok).toBe(false);
      const down = commands.filter(cmd => cmd.includes("down"));
      expect(down).toHaveLength(predecessor ? 0 : 1);
      expect(down.every(cmd => !cmd.includes("--volumes"))).toBe(true);
      if (scenario.includes("cleanup-failure")) {
        expect(softwareTeamRepo.getServicesRecord(currentId!)).not.toBeNull();
        if (!result.ok) expect(result.message).toContain("retained for recovery");
      } else {
        expect(softwareTeamRepo.getSoftwareTeam(currentId!)).toBeNull();
      }
      if (predecessor) {
        expect(softwareTeamRepo.findUnarchivedSoftwareTeamsByName("test-software-team").map(softwareTeam => softwareTeam.id)).toContain(predecessor.id);
        expect(commands.some(cmd => cmd.includes("-p 'legacy-project'") && cmd.includes("up -d"))).toBe(true);
        if (scenario === "inherited-boot-failure" && !result.ok) expect(result.message).toContain("Compose up may have changed its runtime");
      }
    } finally { db.close(); }
  });

  // NS-T05: orphan tmux sessions killed on total failure
  it("kills orphan tmux sessions on total failure", async () => {
    const files = {
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    // Create a setup where startup always fails after launch
    const db = createFullTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    // Adapter that fails at project (after launch)
    const failAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [{ effectiveId: "x", error: "disk full" }] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true })),
    };
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const fsOps = mockFs(files);
    const inst = new PodSoftwareTeamInstantiator({
      db, softwareTeamRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator: startupOrch,
      fsOps, adapters: { "claude-code": failAdapter, "codex": failAdapter, "terminal": failAdapter },
      tmuxAdapter: tmux,
    });

    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
    expect(result.ok).toBe(false);

    // tmux.killSession should have been called for the orphan session
    const killSession = tmux.killSession as ReturnType<typeof vi.fn>;
    expect(killSession).toHaveBeenCalled();

    db.close();
  });

  it("removes a failed SoftwareTeam when its launched tmux session is already absent", async () => {
    const { db, softwareTeamRepo, inst, adapter, tmux } = setup({
      [nodePath.resolve(SOFTWARE_TEAM_ROOT, "agents/impl/agent.yaml")]: agentYaml("impl"),
    });
    (adapter.project as ReturnType<typeof vi.fn>).mockResolvedValue({
      projected: [], skipped: [], failed: [{ effectiveId: "x", error: "disk full" }],
    });
    tmux.probeSession = vi.fn(async () => ({ state: "absent" }));
    tmux.killSession = vi.fn(async () => ({ ok: false, code: "guard_target_unknown", message: "ambiguous target" }));
    const prior = softwareTeamRepo.createSoftwareTeam("test-software-team");

    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec()), SOFTWARE_TEAM_ROOT);

    expect(result.ok).toBe(false);
    expect(adapter.project).toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(softwareTeamRepo.findSoftwareTeamsByName("test-software-team").map((softwareTeam) => softwareTeam.id)).toEqual([prior.id]);
    expect(softwareTeamRepo.findUnarchivedSoftwareTeamsByName("test-software-team").map((softwareTeam) => softwareTeam.id)).toEqual([prior.id]);
    db.close();
  });

  it("retains a failed SoftwareTeam when the tmux server cannot be reached", async () => {
    const { db, softwareTeamRepo, inst, adapter, tmux } = setup({
      [nodePath.resolve(SOFTWARE_TEAM_ROOT, "agents/impl/agent.yaml")]: agentYaml("impl"),
    });
    (adapter.project as ReturnType<typeof vi.fn>).mockResolvedValue({
      projected: [], skipped: [], failed: [{ effectiveId: "x", error: "disk full" }],
    });
    tmux.probeSession = vi.fn(async () => ({
      state: "transport_unavailable", cause: "no server running on /tmp/tmux-501/default",
    }));
    tmux.killSession = vi.fn(async () => ({ ok: true }));
    const prior = softwareTeamRepo.createSoftwareTeam("test-software-team");

    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec()), SOFTWARE_TEAM_ROOT);

    expect(result.ok).toBe(false);
    expect(adapter.project).toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(softwareTeamRepo.findSoftwareTeamsByName("test-software-team")).toHaveLength(2);
    expect(softwareTeamRepo.findUnarchivedSoftwareTeamsByName("test-software-team")).toHaveLength(1);
    expect(softwareTeamRepo.findUnarchivedSoftwareTeamsByName("test-software-team")[0]?.id).not.toBe(prior.id);
    db.close();
  });

  it("retains a failed SoftwareTeam if the tmux server vanishes between probe and kill", async () => {
    const { db, softwareTeamRepo, inst, adapter, tmux } = setup({
      [nodePath.resolve(SOFTWARE_TEAM_ROOT, "agents/impl/agent.yaml")]: agentYaml("impl"),
    });
    (adapter.project as ReturnType<typeof vi.fn>).mockResolvedValue({
      projected: [], skipped: [], failed: [{ effectiveId: "x", error: "disk full" }],
    });
    tmux.probeSession = vi.fn(async () => ({ state: "present" }));
    tmux.killSession = vi.fn(async () => ({
      ok: false, code: "session_not_found", message: "no server running on /tmp/tmux-501/default",
    }));
    const prior = softwareTeamRepo.createSoftwareTeam("test-software-team");

    const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec()), SOFTWARE_TEAM_ROOT);

    expect(result.ok).toBe(false);
    expect(tmux.killSession).toHaveBeenCalled();
    expect(softwareTeamRepo.findSoftwareTeamsByName("test-software-team")).toHaveLength(2);
    expect(softwareTeamRepo.findUnarchivedSoftwareTeamsByName("test-software-team")[0]?.id).not.toBe(prior.id);
    db.close();
  });

  // Agent Starter v1 vertical M1 — forward-compat smoke. A member spec
  // carrying the new `starter_ref` field (normalized as `starterRef`)
  // must pass through pod-aware instantiation without breaking the
  // existing pipeline. M1 only lands schema + resolver scaffolding; M2
  // wires `starterRef` into the launch path. This test verifies M1 does
  // not regress existing instantiation when the new field is present.
  //
  // R2 repair: assert the serialized YAML actually contains
  // `starter_ref:` before instantiation. The R1 codec dropped the field
  // (false-proof), so this assertion was added in R2 alongside the codec
  // emission fix. Without this assertion the smoke would be a hollow
  // pass — the existing pipeline always handled YAML without
  // `starter_ref:` already.
  it("forward-compat: pod with starter_ref on a member instantiates without error AND the codec emits it (R2 repair)", async () => {
    // M2 update: the resolver now actively reads the registry when
    // starterRef is set (M2.1/M2.2 wiring). Provide a fixture registry
    // entry so the resolver succeeds; the smoke proves the field flows
    // through to launch without breaking the existing pipeline. The
    // dedicated end-to-end + abort behaviors live in
    // agent-starter-instantiator.test.ts; this test stays as a
    // forward-compat regression catch.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpRegistry = fs.mkdtempSync(path.join(os.tmpdir(), "starter-fwd-compat-"));
    fs.writeFileSync(path.join(tmpRegistry, "fixture-starter.yaml"), `draft: false
starter_id: fixture-starter
runtime: claude-code
manifest_id: softwareteam-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "fwd-compat-fixture"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`);
    process.env.SOFTWARETEAM_AGENT_STARTER_ROOT = tmpRegistry;
    try {
      const { db, inst, softwareTeamRepo } = setup();
      const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec({
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
            starterRef: { name: "fixture-starter" },
          }],
          edges: [],
        }],
      }));
      // R2: prove the serialized YAML actually carries the new field, then
      // verify instantiation still succeeds with it present.
      expect(yaml).toContain("starter_ref:");
      expect(yaml).toContain("fixture-starter");
      const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const softwareTeam = softwareTeamRepo.getSoftwareTeam(result.result.softwareTeamId);
        expect(softwareTeam).not.toBeNull();
        expect(softwareTeam!.nodes).toHaveLength(1);
      }
      db.close();
    } finally {
      delete process.env.SOFTWARETEAM_AGENT_STARTER_ROOT;
      fs.rmSync(tmpRegistry, { recursive: true, force: true });
    }
  });

  // --- Conveyor-Trust Minimal Fix (OPR.0.3.2.CT) ---
  //
  // QA baseline-deep-dogfood found `SoftwareTeam up conveyor --yes` dead-ends on
  // workspace-trust gate: instantiate_error AND failure tears down to
  // zero (softwareTeams=0, nodes=0, sessions=0). The operator has nothing to
  // approve. PRD: missions/release-0.3.2/slices/conveyor-trust-minimal-fix/
  // IMPLEMENTATION-PRD.md.
  //
  // ROOT CAUSE: launchExistingAgentMember collapses
  // startupResult={ok:false, startupStatus:"attention_required"} to
  // status:"failed", then allFailed → tear down.
  //
  // MINIMAL FIX (HG-2, HG-5 gate-zero):
  //   - propagate attention_required through launchExistingAgentMember
  //   - allFailed tear-down ONLY when ALL nodes are TERMINALLY failed
  //     (attention_required nodes are recoverable; preserve softwareTeam + sessions)
  //   - the session's startup_status="attention_required" already exists
  //     (startupOrchestrator sets it); the softwareTeam is now visible via SoftwareTeam ps
  //     in attention_required state
  //   - HG-5: no trust-model / new-user UX / auto-trust changes — only
  //     the failure-handling path is touched

  it("HG-1 repro (PRE-FIX): all nodes hit trust-gate → instantiate_error + zero-collapse", async () => {
    // BEFORE the fix this test SHOULD have shown the broken zero-collapse.
    // Post-fix it documents the OLD behavior so the discriminator is clear.
    // This test passes post-fix because we now preserve the recoverable
    // state — it asserts the NEW expected shape (no tear-down).
    const { db, softwareTeamRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${SOFTWARE_TEAM_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    });
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    // Startup orchestrator that returns attention_required for ALL nodes
    // (simulates trust-gate on a disposable workspace).
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    startupOrch.startNode = async (input) => {
      sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
      return {
        ok: false,
        startupStatus: "attention_required",
        errors: ["Harness launch requires attention: trust_gate"],
        evidence: "Claude is waiting for workspace trust approval before the session can become interactive.",
      };
    };
    const inst = new PodSoftwareTeamInstantiator({
      db, softwareTeamRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({
        [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${SOFTWARE_TEAM_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
      }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });

    const spec = makeSoftwareTeamSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    });
    const yaml = SoftwareTeamSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);

    // HG-2: NO zero-collapse. The result returns ok:false with the new
    // attention_required code (not the old instantiate_error), AND the
    // softwareTeam + sessions are preserved on disk so operator can act.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("attention_required");
      expect(result.message).toMatch(/trust|attention/i);
    }
    // SoftwareTeam + sessions PRESERVED — the operator can list them via SoftwareTeam ps.
    expect(softwareTeamRepo.listSoftwareTeams()).toHaveLength(1);
    if (!result.ok && result.code === "attention_required") {
      const fullSoftwareTeam = softwareTeamRepo.getSoftwareTeam(result.softwareTeamId);
      expect(fullSoftwareTeam).not.toBeNull();
      expect(fullSoftwareTeam!.nodes.length).toBe(2);
    }
    // Tmux sessions NOT killed (no cleanup pass on attention_required).
    expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // Session rows carry startup_status='attention_required' (already
    // persisted by startupOrchestrator — pin it here to anchor the
    // approve-and-resume path).
    const sessions = db.prepare("SELECT startup_status FROM sessions").all() as Array<{ startup_status: string }>;
    expect(sessions.length).toBe(2);
    for (const s of sessions) {
      expect(s.startup_status).toBe("attention_required");
    }
    db.close();
  });

  it("HG-3 attention_required result carries the attentionNodes list (operator approve→resume path)", async () => {
    const { db, softwareTeamRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    });
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    startupOrch.startNode = async (input) => {
      sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
      return {
        ok: false,
        startupStatus: "attention_required",
        errors: ["Harness launch requires attention: trust_gate"],
        evidence: "Claude is waiting for workspace trust approval before the session can become interactive.",
      };
    };
    const inst = new PodSoftwareTeamInstantiator({
      db, softwareTeamRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({ [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "attention_required") {
      expect(result.message).toMatch(/inspect/i);
      expect(result.message).not.toMatch(/approve and resume|NOT failed/);
      expect(result.softwareTeamId).toBeDefined();
      expect(result.attentionNodes).toBeInstanceOf(Array);
      expect(result.attentionNodes!.length).toBe(1);
      expect(result.attentionNodes![0]!.logicalId).toBe("dev.impl");
      expect(result.attentionNodes![0]!.sessionName).toContain("@test-software-team");
    }
    db.close();
  });

  it("HG-2 mixed: one attention_required + one launched → SoftwareTeam preserved (ok:true) with attention warnings", async () => {
    const { db, softwareTeamRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${SOFTWARE_TEAM_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    });
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const origStartNode = startupOrch.startNode.bind(startupOrch);
    let callCount = 0;
    startupOrch.startNode = async (input) => {
      callCount++;
      if (callCount === 2) {
        sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
        return {
          ok: false,
          startupStatus: "attention_required",
          errors: ["trust_gate on qa"],
          evidence: "trust prompt",
        };
      }
      return origStartNode(input);
    };
    const inst = new PodSoftwareTeamInstantiator({
      db, softwareTeamRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({
        [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${SOFTWARE_TEAM_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
      }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });

    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    }));
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const attention = result.result.nodes.filter((n) => n.status === "attention_required");
      const launched = result.result.nodes.filter((n) => n.status === "launched");
      expect(launched.length).toBe(1);
      expect(attention.length).toBe(1);
      expect(attention[0]!.logicalId).toBe("dev.qa");
    }
    // SoftwareTeam preserved; sessions intact.
    expect(softwareTeamRepo.listSoftwareTeams()).toHaveLength(1);
    expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    db.close();
  });

  it("HG-2 negative: all-TERMINALLY-failed still tears down (no regression to terminal-failure cleanup)", async () => {
    const { db, softwareTeamRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    });
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    startupOrch.startNode = async (input) => {
      sessionRegistry.updateStartupStatus(input.sessionId, "failed");
      return {
        ok: false,
        startupStatus: "failed",
        errors: ["terminal failure (NOT trust-gate)"],
      };
    };
    const inst = new PodSoftwareTeamInstantiator({
      db, softwareTeamRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({ [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);

    // Terminal-failure tear-down preserved (no regression to existing
    // cleanup path).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("instantiate_error");
    }
    expect(softwareTeamRepo.listSoftwareTeams()).toHaveLength(0);
    db.close();
  });

  it("HG-2 negative: at least one terminal failure + at least one attention_required → softwareTeam PRESERVED (recoverable wins over tear-down)", async () => {
    const { db, softwareTeamRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${SOFTWARE_TEAM_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    });
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    let callCount = 0;
    startupOrch.startNode = async (input) => {
      callCount++;
      if (callCount === 1) {
        sessionRegistry.updateStartupStatus(input.sessionId, "failed");
        return { ok: false, startupStatus: "failed", errors: ["terminal failure"] };
      }
      sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
      return {
        ok: false,
        startupStatus: "attention_required",
        errors: ["trust_gate"],
        evidence: "trust prompt",
      };
    };
    const inst = new PodSoftwareTeamInstantiator({
      db, softwareTeamRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({
        [`${SOFTWARE_TEAM_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${SOFTWARE_TEAM_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
      }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });
    const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    }));
    const result = await inst.instantiate(yaml, SOFTWARE_TEAM_ROOT);

    // ANY attention_required means recoverable — preserve softwareTeam even if
    // other nodes terminally failed.
    expect(softwareTeamRepo.listSoftwareTeams()).toHaveLength(1);
    // The operator can still see + approve the attention_required node.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("attention_required");
    }
    db.close();
  });

  // r2-B1 (slice-06 BLOCKING 1): the REAL software-team-up door is instantiate(), not
  // materializeValidatedSpec — the bootstrap apply path calls instantiate()
  // (bootstrap-orchestrator.ts), so an installer wired only into materialize
  // ships defaults on import/expand and NOT on `SoftwareTeam up`. This pin drives
  // instantiate() with a REAL temp spec dir carrying topology/ defaults and
  // asserts the files land under the resolved topology root on the REAL fs.
  it("r2-B1: instantiate() — the software-team-up door — installs the spec's topology defaults under topology.root", async () => {
    const realFs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const specDir = realFs.mkdtempSync(nodePath.join(os.tmpdir(), "s06-spec-"));
    const topoRoot = realFs.mkdtempSync(nodePath.join(os.tmpdir(), "s06-topo-"));
    try {
      realFs.mkdirSync(nodePath.join(specDir, "topology", "software-team"), { recursive: true });
      realFs.mkdirSync(nodePath.join(specDir, "topology", "instance"), { recursive: true });
      realFs.writeFileSync(nodePath.join(specDir, "topology", "software-team", "CRAFT.md"), "SoftwareTeam default", "utf-8");
      realFs.writeFileSync(nodePath.join(specDir, "topology", "instance", "CRAFT.md"), "instance default", "utf-8");

      const files = { [`${specDir}/agents/impl/agent.yaml`]: agentYaml("impl") };
      const { db, inst } = setup(files, undefined, () => topoRoot);
      const yaml = SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec());
      const result = await inst.instantiate(yaml, specDir);
      expect(result.ok).toBe(true);
      // The door proof: defaults exist on the REAL filesystem after software-team-up.
      expect(realFs.readFileSync(nodePath.join(topoRoot, "software-teams", "test-software-team", "CRAFT.md"), "utf-8")).toBe("SoftwareTeam default");
      expect(realFs.readFileSync(nodePath.join(topoRoot, "CRAFT.md"), "utf-8")).toBe("instance default");
      db.close();
    } finally {
      realFs.rmSync(specDir, { recursive: true, force: true });
      realFs.rmSync(topoRoot, { recursive: true, force: true });
    }
  });

  it("r2-B1 control: without a topologyRootResolver, instantiate() installs nothing and still succeeds", async () => {
    const realFs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const specDir = realFs.mkdtempSync(nodePath.join(os.tmpdir(), "s06-spec-"));
    try {
      realFs.mkdirSync(nodePath.join(specDir, "topology", "software-team"), { recursive: true });
      realFs.writeFileSync(nodePath.join(specDir, "topology", "software-team", "CRAFT.md"), "x", "utf-8");
      const files = { [`${specDir}/agents/impl/agent.yaml`]: agentYaml("impl") };
      const { db, inst } = setup(files);
      const result = await inst.instantiate(SoftwareTeamSpecCodec.serialize(makeSoftwareTeamSpec()), specDir);
      expect(result.ok).toBe(true);
      db.close();
    } finally {
      realFs.rmSync(specDir, { recursive: true, force: true });
    }
  });
});
