import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareTeam, expertRoles } from "../../../scripts/software-team.mjs";
import { validateRigSpecFromYaml } from "../src/domain/spec-validation-service.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import { resolveAgentRef } from "../src/domain/agent-resolver.js";
import { resolveNodeConfig } from "../src/domain/profile-resolver.js";
import { planProjection } from "../src/domain/projection-planner.js";

const repository = resolve(import.meta.dirname, "../../..");
const fsOps = { readFile: (file: string) => readFileSync(file, "utf8"), exists: existsSync };
const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("this repository's specialist software team", () => {
  it.each(["codex", "claude-code"])("resolves seven resident %s experts with independent skill projections", async runtime => {
    const root = mkdtempSync(join(tmpdir(), "software-team-rig-"));
    fixtures.push(root);
    cpSync(join(repository, "team"), join(root, "team"), { recursive: true, filter: file => !file.includes("workspaces") && !file.endsWith("rig.local.yaml") });
    cpSync(join(repository, "packages/daemon/specs/agents/software-team"), join(root, "packages/daemon/specs/agents/software-team"), { recursive: true });
    const { output } = prepareTeam(root, runtime);
    const yaml = readFileSync(output, "utf8");
    const validation = validateRigSpecFromYaml(yaml);
    expect(validation.valid, validation.errors.join("\n")).toBe(true);
    const spec = RigSpecSchema.normalize(RigSpecCodec.parse(yaml) as Record<string, unknown>);
    const rigRoot = dirname(output);
    expect(spec.workspace?.workspaceRoot).toBe(root);
    expect(spec.workspace?.knowledgeRoot).toBe(join(root, "team/knowledge"));
    const preflight = await rigPreflight({ rigSpecYaml: yaml, rigRoot, fsOps });
    expect(preflight.errors).toEqual([]);
    expect(preflight.ready).toBe(true);
    const members = spec.pods.flatMap(pod => pod.members);
    expect(members.map(member => member.role)).toEqual(expertRoles);
    for (const pod of spec.pods) for (const member of pod.members) {
      const agent = resolveAgentRef(member.agentRef, rigRoot, fsOps);
      if (!agent.ok) throw new Error(agent.error);
      const result = resolveNodeConfig({ baseSpec: agent.resolved, importedSpecs: agent.imports,
        collisions: agent.collisions, profileName: member.profile, specRoot: rigRoot,
        homedir: homedir(), systemSkills: [], member, pod, rig: spec });
      if (!result.ok) throw new Error(result.errors.join("\n"));
      const config = result.config;
      expect(config.cwd).toBe(join(root, "team/workspaces", member.role!));
      expect(config.runtime).toBe(runtime);
      expect(config.lifecycle?.executionMode).toBe("interactive_resident");
      expect(config.restorePolicy).toBe("resume_if_possible");
      expect(config.selectedResources.skills.map(skill => skill.resource.id).sort()).toEqual([
        `software-team-${member.role}`, "software-team-contract",
      ].sort());
      expect(config.selectedResources.runtimeResources).toEqual([]);
      expect(config.selectedResources.plugins).toEqual([]);
      expect(config.startup.files.some(file => file.path === "PROJECT.md" && file.deliveryHint === "send_text")).toBe(true);
      for (const skill of config.selectedResources.skills) {
        expect(existsSync(resolve(skill.sourcePath, (skill.resource as { path: string }).path, "SKILL.md"))).toBe(true);
      }
      const projection = planProjection({ config, collisions: agent.collisions, fsOps });
      if (!projection.ok) throw new Error(projection.errors.join("\n"));
      expect(projection.plan.entries.some(entry => entry.category === "runtime_resource")).toBe(false);
    }
  });
});
