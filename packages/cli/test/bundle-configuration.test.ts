// Spec 03: a preset or per-seat choice resolves to one checked mapping and configuration ID, and is
// applied to an owned copy of the softwareTeam folder, never to the author's folder.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { parse as parseYaml } from "yaml";
import {
  readDeclaredConfigurations, authoredMapping, resolveConfiguration, listConfigurations, checkDeclaredConfigurations, stageConfiguration, ConfigurationError,
} from "../src/lib/bundle-configuration.js";

const SOFTWARE_TEAM = `version: "0.2"
name: softwareteam-dev
# the authored team
pods:
  - id: build
    members:
      - { id: lead, agent_ref: "local:agents/dev", profile: lead, runtime: claude-code, cwd: "." }
      - { id: impl, agent_ref: "local:agents/dev", profile: implementer, runtime: claude-code, cwd: "." }
  - id: check
    members:
      - { id: review, agent_ref: "local:agents/dev", profile: reviewer, runtime: codex, cwd: "." }
      - { id: qa, agent_ref: "local:agents/dev", profile: qa, runtime: codex, cwd: "." }
`;
const CONFIGS = `schema: softwareteam.bundle-configurations/v1
recommended: recommended
seats:
  build.lead: { runtimes: { claude-code: lead, codex: lead, pi: lead-pi } }
  build.impl: { runtimes: { claude-code: implementer, codex: implementer, pi: implementer-pi } }
  check.review: { runtimes: { codex: reviewer, claude-code: reviewer, pi: reviewer-pi } }
  check.qa: { runtimes: { codex: qa, claude-code: qa, pi: qa-pi } }
presets:
  recommended: { build.lead: claude-code, build.impl: claude-code, check.review: codex, check.qa: codex }
  all-claude: { build.lead: claude-code, build.impl: claude-code, check.review: claude-code, check.qa: claude-code }
  all-pi: { build.lead: pi, build.impl: pi, check.review: pi, check.qa: pi }
`;
const RECOMMENDED = "build.impl=claude-code,build.lead=claude-code,check.qa=codex,check.review=codex";

describe("bundle configurations", () => {
  let softwareTeamDir: string;
  let staged: string[];

  beforeEach(() => {
    softwareTeamDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "software-team-configs-"));
    fs.writeFileSync(nodePath.join(softwareTeamDir, "software-team.yaml"), SOFTWARE_TEAM);
    fs.writeFileSync(nodePath.join(softwareTeamDir, "configurations.yaml"), CONFIGS);
    fs.mkdirSync(nodePath.join(softwareTeamDir, "agents", "dev"), { recursive: true });
    fs.writeFileSync(nodePath.join(softwareTeamDir, "agents", "dev", "agent.yaml"), "name: dev\n");
    staged = [];
  });

  afterEach(() => {
    for (const dir of [softwareTeamDir, ...staged]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const declared = () => readDeclaredConfigurations(softwareTeamDir)!;
  const authored = () => authoredMapping(nodePath.join(softwareTeamDir, "software-team.yaml"));

  it("no choice gives the authored software-team.yaml, which the recommended preset matches", () => {
    expect(resolveConfiguration(declared(), authored(), {})).toEqual({ mapping: authored(), configurationId: RECOMMENDED, preset: "recommended" });
  });

  it("a preset and the equivalent per-seat choices give the same configuration", () => {
    const viaPreset = resolveConfiguration(declared(), authored(), { preset: "all-claude" });
    const viaSeats = resolveConfiguration(declared(), authored(), { seats: ["check.review=claude-code", "check.qa=claude-code"] });
    expect(viaSeats).toEqual(viaPreset);
    expect(viaPreset.configurationId).toBe("build.impl=claude-code,build.lead=claude-code,check.qa=claude-code,check.review=claude-code");
  });

  it("a custom mix gets its own ID and no preset name", () => {
    const custom = resolveConfiguration(declared(), authored(), { preset: "recommended", seats: ["build.impl=pi"] });
    expect(custom).toEqual({ mapping: { ...authored(), "build.impl": "pi" }, configurationId: "build.impl=pi,build.lead=claude-code,check.qa=codex,check.review=codex" });
  });

  it("an undeclared runtime is refused with the allowed set", () => {
    expect(() => resolveConfiguration(declared(), authored(), { seats: ["build.lead=gemini"] })).toThrow(/can't use 'gemini'; it can use: claude-code, codex, pi/);
    expect(() => resolveConfiguration(declared(), authored(), { preset: "all-codex" })).toThrow(/declared presets: recommended, all-claude, all-pi/);
    expect(() => resolveConfiguration(declared(), authored(), { seats: ["build.ops=pi"] })).toThrow(ConfigurationError);
  });

  it("lists every preset with its ID, the recommended one, and the one software-team.yaml matches", () => {
    expect(listConfigurations(declared(), authored())).toContainEqual({ preset: "recommended", configurationId: RECOMMENDED, recommended: true, authored: true });
    expect(listConfigurations(declared(), authored()).filter((c) => c.authored)).toHaveLength(1);
  });

  it("stages the choice in an owned copy: runtime and profile change there, the author's folder doesn't", () => {
    const chosen = resolveConfiguration(declared(), authored(), { preset: "all-pi" });
    const { stagingDir, softwareTeamSpecPath } = stageConfiguration(softwareTeamDir, nodePath.join(softwareTeamDir, "software-team.yaml"), declared(), chosen);
    staged.push(stagingDir);

    expect(fs.readFileSync(nodePath.join(softwareTeamDir, "software-team.yaml"), "utf-8")).toBe(SOFTWARE_TEAM);
    const spec = parseYaml(fs.readFileSync(softwareTeamSpecPath, "utf-8")) as { pods: Array<{ members: Array<{ id: string; runtime: string; profile: string }> }> };
    expect(spec.pods.flatMap((p) => p.members.map((m) => `${m.id}:${m.runtime}:${m.profile}`))).toEqual(["lead:pi:lead-pi", "impl:pi:implementer-pi", "review:pi:reviewer-pi", "qa:pi:qa-pi"]);
    expect(fs.existsSync(nodePath.join(stagingDir, "agents", "dev", "agent.yaml"))).toBe(true);
    expect(authoredMapping(softwareTeamSpecPath)).toEqual(chosen.mapping);
  });

  const stagingCopies = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("software-team-configuration-")).length;

  it("a symlinked software-team.yaml is staged as its own file, and the author's file it points to is unchanged", () => {
    fs.renameSync(nodePath.join(softwareTeamDir, "software-team.yaml"), nodePath.join(softwareTeamDir, "real.yaml"));
    fs.symlinkSync("real.yaml", nodePath.join(softwareTeamDir, "software-team.yaml"));
    const chosen = resolveConfiguration(declared(), authored(), { preset: "all-pi" });
    const { stagingDir, softwareTeamSpecPath } = stageConfiguration(softwareTeamDir, nodePath.join(softwareTeamDir, "software-team.yaml"), declared(), chosen);
    staged.push(stagingDir);

    expect(fs.readFileSync(nodePath.join(softwareTeamDir, "real.yaml"), "utf-8")).toBe(SOFTWARE_TEAM);
    expect(fs.lstatSync(softwareTeamSpecPath).isSymbolicLink()).toBe(false);
    expect(authoredMapping(softwareTeamSpecPath)).toEqual(chosen.mapping);
  });

  it("a spec outside the SoftwareTeam folder is refused before anything is copied, and the author's spec is unchanged", () => {
    const elsewhere = fs.mkdtempSync(nodePath.join(os.tmpdir(), "software-team-elsewhere-"));
    staged.push(elsewhere);
    fs.writeFileSync(nodePath.join(elsewhere, "software-team.yaml"), SOFTWARE_TEAM);
    const chosen = resolveConfiguration(declared(), authored(), { preset: "all-pi" });
    const before = stagingCopies();
    expect(() => stageConfiguration(softwareTeamDir, nodePath.join(elsewhere, "software-team.yaml"), declared(), chosen)).toThrow(/isn't inside the SoftwareTeam folder/);
    expect(stagingCopies()).toBe(before);
    expect(fs.readFileSync(nodePath.join(elsewhere, "software-team.yaml"), "utf-8")).toBe(SOFTWARE_TEAM);
  });

  it("a staging failure removes the copy and says why", () => {
    fs.symlinkSync("missing.md", nodePath.join(softwareTeamDir, "dangling.md"));
    const chosen = resolveConfiguration(declared(), authored(), { preset: "all-pi" });
    const before = stagingCopies();
    expect(() => stageConfiguration(softwareTeamDir, nodePath.join(softwareTeamDir, "software-team.yaml"), declared(), chosen)).toThrow(/couldn't stage a copy of/);
    expect(stagingCopies()).toBe(before);
  });

  it("the recommended preset must be software-team.yaml as written", () => {
    fs.writeFileSync(nodePath.join(softwareTeamDir, "configurations.yaml"), CONFIGS.replace("recommended: recommended", "recommended: all-pi"));
    expect(() => checkDeclaredConfigurations(declared(), authored())).toThrow(/the recommended preset 'all-pi' must be software-team.yaml as written \(build\.impl=claude-code,build\.lead=claude-code,check\.qa=codex,check\.review=codex\)/);
    expect(() => resolveConfiguration(declared(), authored(), { preset: "all-claude" })).toThrow(ConfigurationError);
  });

  it("a preset and --seat meet the same rule: a listed seat may use only its declared runtimes", () => {
    // build.impl lists only pi, yet the recommended preset (software-team.yaml) gives it claude-code
    fs.writeFileSync(nodePath.join(softwareTeamDir, "configurations.yaml"),
      CONFIGS.replace("build.impl: { runtimes: { claude-code: implementer, codex: implementer, pi: implementer-pi } }", "build.impl: { runtimes: { pi: implementer-pi } }"));
    expect(() => resolveConfiguration(declared(), authored(), { preset: "recommended" })).toThrow(/preset 'recommended': seat 'build\.impl' can't use 'claude-code'; it can use: pi/);
    expect(() => checkDeclaredConfigurations(declared(), authored())).toThrow(/seat 'build\.impl' can't use 'claude-code'/);
  });

  it("a malformed configurations.yaml is named, not a crash", () => {
    fs.writeFileSync(nodePath.join(softwareTeamDir, "configurations.yaml"), "schema: softwareteam.bundle-configurations/v1\nrecommended: recommended\nseats:\n  build.lead: { runtimes: { pi: lead-pi } }\n");
    expect(() => readDeclaredConfigurations(softwareTeamDir)).toThrow(/presets must declare at least one preset/);
    fs.writeFileSync(nodePath.join(softwareTeamDir, "configurations.yaml"), "schema: softwareteam.bundle-configurations/v1\nrecommended: recommended\nseats:\n  build.lead: pi\npresets:\n  recommended: { build.lead: claude-code }\n");
    expect(() => readDeclaredConfigurations(softwareTeamDir)).toThrow(/seats\.build\.lead\.runtimes must map each runtime to a profile/);
  });
});
