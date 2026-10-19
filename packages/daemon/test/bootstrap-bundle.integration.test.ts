import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runSoftwareTeam, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

const here = dirname(fileURLToPath(import.meta.url));
const softwareTeamBin = resolve(here, "../../cli/dist/bin-wrapper.js");

describe("bootstrap a portable archive", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  const softwareTeamName = "bootstrap-bundle-stub";

  beforeAll(async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    daemon = await spawnScenarioDaemon(scaffold, { softwareTeamBin });
  }, 60_000);

  afterAll(async () => {
    if (!daemon) { scaffold?.cleanup(); return; }
    try { await runSoftwareTeam(["down", softwareTeamName, "--json", "--force"], daemon.readEnv, softwareTeamBin); }
    finally { await daemon.stop(); }
  }, 60_000);

  it("previews a library copy without launching, then installs one team from its archive", async () => {
    const root = scaffold!.root;
    const source = join(root, "author");
    const agent = "name: worker\nversion: \"1.0\"\nprofiles:\n  default:\n    uses:\n      skills: []\n";
    mkdirSync(join(source, "agents/worker"), { recursive: true });
    writeFileSync(join(source, "agents/worker/agent.yaml"), agent);
    writeFileSync(join(source, "software-team.yaml"), `version: "0.2"
name: ${softwareTeamName}
pods:
  - id: work
    label: Work
    members:
      - {id: worker, agent_ref: "local:agents/worker", profile: default, runtime: stub, cwd: .}
    edges: []
edges: []
`);
    const archive = join(root, "team.softwareteambundle");
    const target = join(root, "installed");
    const cwd = join(root, "project");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "owned.txt"), "Keep my project\n");
    const cli = async (args: string[]) => {
      const r = await runSoftwareTeam(args, daemon!.readEnv, softwareTeamBin, 120_000);
      expect(r.code, JSON.stringify({ args, ...r })).toBe(0);
      return JSON.parse(r.stdout);
    };
    // Browsing an external team's graph adds source to the library, not a softwareTeam.
    // Installation must still use the portable source with its explicit target.
    const added = await cli(["specs", "add", source, "--json"]);
    const previewPath = added.entry.sourcePath;
    const previewBytes = readFileSync(previewPath, "utf8");
    expect(previewBytes).toBe(readFileSync(join(source, "software-team.yaml"), "utf8"));
    const preview = await cli(["specs", "preview", softwareTeamName, "--kind", "softwareTeam", "--json"]);
    expect(preview.graph.nodes.map((node: { id: string }) => node.id)).toEqual(["work.worker"]);
    expect(await cli(["ps", "--nodes", "--all-software-teams", "--json"])).toEqual([]);

    await cli(["bundle", "create", join(source, "software-team.yaml"), "--output", archive, "--name", "portable-team", "--json"]);
    rmSync(source, { recursive: true });

    // Planning must leave the requested target absent and launch no members.
    const plan = await cli(["bootstrap", archive, "--target", target, "--plan", "--json"]);
    expect(plan.status).toBe("planned");
    expect(existsSync(target)).toBe(false);
    expect(await cli(["ps", "--nodes", "--all-software-teams", "--json"])).toEqual([]);

    const applied = await cli(["bootstrap", archive, "--target", target, "--cwd", cwd, "--yes", "--json"]);
    expect(applied.status).toBe("completed");
    expect(readFileSync(join(target, "agents/worker/agent.yaml"), "utf8")).toBe(agent);
    expect(readFileSync(join(target, "software-team.yaml"), "utf8")).toContain(`name: ${softwareTeamName}`);
    expect(readFileSync(join(cwd, "owned.txt"), "utf8")).toBe("Keep my project\n");
    const nodes = await cli(["ps", "--nodes", "--software-team", softwareTeamName, "--full", "--json"]);
    expect(nodes.map((n: { canonicalSessionName: string }) => n.canonicalSessionName)).toEqual([`work-worker@${softwareTeamName}`]);
    expect(nodes[0].sessionStatus).toBe("running");
    expect(nodes[0].cwd).toBe(cwd);
    expect(await cli(["ps", "--nodes", "--all-software-teams", "--json"])).toHaveLength(1);
    expect(readFileSync(previewPath, "utf8")).toBe(previewBytes);
    const library = await cli(["specs", "ls", "--kind", "softwareTeam", "--json"]);
    expect(library.filter((entry: { name: string }) => entry.name === softwareTeamName)).toHaveLength(1);

    // A copied manifest in the seats' project must not turn it into the install folder.
    await cli(["down", softwareTeamName, "--json", "--force"]);
    writeFileSync(join(cwd, "bundle.yaml"), readFileSync(join(target, "bundle.yaml")));
    writeFileSync(join(cwd, "software-team.yaml"), "my unrelated project file\n");
    const refused = await runSoftwareTeam(["bootstrap", archive, "--target", cwd, "--cwd", cwd, "--yes", "--json"], daemon!.readEnv, softwareTeamBin, 120_000);
    expect(JSON.parse(refused.stdout).status).toBe("failed");
    expect(readFileSync(join(cwd, "software-team.yaml"), "utf8")).toBe("my unrelated project file\n");

    // The original folder still supports replacement, including backup disclosure.
    writeFileSync(join(target, "software-team.yaml"), "# local edit\n" + readFileSync(join(target, "software-team.yaml"), "utf8"));
    const reinstalled = await cli(["bootstrap", archive, "--target", target, "--cwd", cwd, "--yes", "--json"]);
    expect(reinstalled.status).toBe("completed");
    expect(reinstalled.warnings.join("\n")).toContain("bundle-backups");
    expect(readFileSync(join(cwd, "owned.txt"), "utf8")).toBe("Keep my project\n");
    rmSync(archive);
  }, 120_000);
});
