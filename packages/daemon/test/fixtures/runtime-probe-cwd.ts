// A child-only cwd mutation: never change the test runner or daemon cwd.
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { execPreflightCommand } from "../../src/adapters/preflight-exec.js";
import { execCommand } from "../../src/adapters/tmux-exec.js";
import { SoftwareTeamSpecPreflight, softwareTeamPreflight } from "../../src/domain/software-team-spec-preflight.js";
import { softwareTeamSpecImportRoutes } from "../../src/routes/software-team-spec.js";
import { BootstrapOrchestrator } from "../../src/domain/bootstrap-orchestrator.js";
import { bootstrapRoutes } from "../../src/routes/bootstrap.js";

const [root, mode, runtime] = process.argv.slice(2) as [string, string, string];
const work = path.join(root, "working");
fs.mkdirSync(work);
process.chdir(work);
if (mode === "deleted-cached") process.cwd(); // Node may cache getcwd until chdir.
if (mode === "deleted" || mode === "deleted-cached") fs.rmdirSync(work);
process.env.PATH = mode === "relative" ? "../bin" : path.join(root, mode === "missing" ? "empty-bin" : "bin");
const softwareTeamRoot = path.join(root, "software-team");
const yaml = `version: "0.2"
name: probe
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: ${runtime}
        cwd: ${path.join(root, "seat")}
    edges: []
edges: []
`;
const fsOps = { exists: fs.existsSync, readFile: (p: string) => fs.readFileSync(p, "utf8") };
// The production startup executor, through the same core used by SoftwareTeam up.
const core = await softwareTeamPreflight({ softwareTeamSpecYaml: yaml, softwareTeamRoot, fsOps, exec: execPreflightCommand });
// The production synchronous executor, through the real route.
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("podInstantiator" as never, { resolveSkillsRoot: () => undefined } as never);
  await next();
});
app.route("/api/software-teams/import", softwareTeamSpecImportRoutes);
const response = await app.request("/api/software-teams/import/preflight", {
  method: "POST", headers: { "X-Software-Team-Root": softwareTeamRoot }, body: yaml,
});
// The legacy caller uses the same production preflight executor.
const legacy = new SoftwareTeamSpecPreflight({
  softwareTeamRepo: { listSoftwareTeams: () => [] }, tmuxAdapter: { hasSession: async () => false },
  exec: execPreflightCommand, cmuxExec: async () => "",
} as never);
const legacyResult = await legacy.check({
  name: "probe", schemaVersion: 1,
  nodes: [{ id: "impl", runtime, cwd: path.join(root, "seat") }], edges: [],
} as never);
// Exercise bootstrap's own synchronous preflight executor through its real
// route/orchestrator. Only its persistence collaborators are inert fixtures.
const sourceRef = path.join(softwareTeamRoot, "software-team.yaml");
fs.writeFileSync(sourceRef, yaml);
const db = {};
const bootstrap = new BootstrapOrchestrator({
  db, bootstrapRepo: { db, createRun: () => ({ id: "probe" }), updateRunStatus: () => {} },
  runtimeVerifier: { db }, installExecutor: { db }, packageInstallService: { db }, fsOps,
  podInstantiator: { deps: { fsOps }, resolveSkillsRoot: () => undefined },
} as never);
const bootstrapApp = new Hono();
bootstrapApp.use("*", async (c, next) => {
  c.set("bootstrapOrchestrator" as never, bootstrap as never);
  c.set("eventBus" as never, { emit: () => {} } as never);
  await next();
});
bootstrapApp.route("/api/bootstrap", bootstrapRoutes);
const bootstrapResponse = await bootstrapApp.request("/api/bootstrap/plan", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ sourceRef, cwdOverride: path.join(root, "seat") }),
});
// Non-version commands retain their current-directory semantics in both the
// dedicated and generic executor. Use only a synthetic executable here.
let nonVersion: string | null = null;
let generic: string | null = null;
if (mode === "stable" || mode === "relative") {
  nonVersion = (await execPreflightCommand("codex -p fixture mcp list")).trim();
  generic = (await execCommand("pi --version")).trim();
}
console.log(JSON.stringify({ core, route: await response.json(), status: response.status, nonVersion, generic, work,
  legacy: legacyResult, bootstrap: { status: bootstrapResponse.status, result: await bootstrapResponse.json() } }));
