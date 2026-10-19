import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runSoftwareTeam, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// One community agent app end to end, through the real CLI, daemon, SQLite and a private tmux server: a synthetic
// Node app installed as a preset, then discovery, start, delivery through `SoftwareTeam send`, activity, resume, a missing
// preset and a built-in name collision. Nothing here runs a real agent app or touches a real home.
const here = dirname(fileURLToPath(import.meta.url));
const softwareTeamBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const appScript = resolve(here, "fixtures/agent-app/synth-app.mjs");
const agents = resolve(here, "../../test-system/scenarios/agents");
const session = "work-worker@agent-app-software-team";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("a community agent app from a data preset", () => {
  let scaffold: HermeticScaffold;
  let daemon: ScenarioDaemon;
  let softwareTeamRoot: string;
  let softwareTeamId: string;

  const softwareTeam = (args: string[], timeout?: number) => runSoftwareTeam(args, daemon.readEnv, softwareTeamBin, timeout);
  async function json(args: string[]) {
    const result = await softwareTeam(args);
    expect(result.code, JSON.stringify({ args, ...result })).toBe(0);
    return JSON.parse(result.stdout);
  }
  async function node() {
    const nodes = await json(["ps", "--nodes", "--software-team", "agent-app-software-team", "--full", "--json"]);
    return nodes[0];
  }
  const capture = () => execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "capture-pane", "-p", "-t", `=${session}:`], { env: scaffold.env as NodeJS.ProcessEnv }).toString();
  async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 30_000): Promise<T> {
    const end = Date.now() + ms;
    let value = await read();
    while (!ok(value) && Date.now() < end) { await sleep(500); value = await read(); }
    return value;
  }
  const presetDir = () => join(scaffold.env.SOFTWARETEAM_HOME!, "agent-apps");
  const writePreset = (file: string, body: string) => { mkdirSync(presetDir(), { recursive: true }); writeFileSync(join(presetDir(), file), body); };
  const specFor = (name: string, runtime: string) => {
    const path = join(softwareTeamRoot, `${name}.yaml`);
    writeFileSync(path, `version: "0.2"\nname: ${name}\npods:\n  - id: work\n    label: Work\n    members:\n      - {id: worker, agent_ref: "local:agents/worker", profile: default, runtime: ${runtime}, cwd: .}\n    edges: []\n`);
    return path;
  };

  beforeAll(async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    softwareTeamRoot = join(scaffold.root, "software-team");
    mkdirSync(softwareTeamRoot);
    cpSync(agents, join(softwareTeamRoot, "agents"), { recursive: true });
    writePreset("synth-app.yaml", [
      "format: 1", "name: synth-app", `command: node ${appScript}`, "maintainer: Example Maintainer",
      "limits:", "  - resume unsupported", "  - fork unsupported", "  - no approval-prompt detection", "",
    ].join("\n"));
    writePreset("codex.yaml", ["format: 1", "name: codex", "command: node -e 0", "maintainer: someone", ""].join("\n"));
    daemon = await spawnScenarioDaemon(scaffold, { softwareTeamBin });
  }, 120_000);

  afterAll(async () => {
    try { if (daemon) for (const r of ["agent-app-software-team", "free-software-team"]) await softwareTeam(["down", r, "--json", "--force"]); }
    finally { await daemon?.stop(); }
  }, 60_000);

  it("is discoverable with its maintainer and limits, and a preset can't take a built-in name", async () => {
    const listed = await json(["agent-app", "list", "--json"]);
    const byName = Object.fromEntries(listed.apps.map((app: { name: string }) => [app.name, app]));
    expect(byName["synth-app"]).toMatchObject({ usable: true, community: true, testedBySoftwareTeam: false, maintainer: "Example Maintainer",
      limits: ["resume unsupported", "fork unsupported", "no approval-prompt detection"] });
    expect(byName["codex"]).toMatchObject({ usable: false, problem: '"codex" is a built-in runtime; an agent app preset can\'t use that name' });
  });

  it("starts from the preset, labelled as a community app with identity not confirmed", async () => {
    const up = await softwareTeam(["up", specFor("agent-app-software-team", "synth-app"), "--cwd", softwareTeamRoot, "--json", "--yes"], 120_000);
    expect(up.code, JSON.stringify(up)).toBe(0);
    softwareTeamId = JSON.parse(up.stdout).softwareTeamId;
    expect(await until(async () => capture(), text => text.includes("synth-app 1.0 started"))).toContain("app> ");
    const seat = await node();
    expect(seat).toMatchObject({ runtime: "synth-app", sessionStatus: "running",
      agentApp: { app: "synth-app", maintainer: "Example Maintainer", identity: "not confirmed", needsInput: "from the screen only: no app prompt pattern" } });
    const human = await softwareTeam(["ps", "--nodes", "--software-team", "agent-app-software-team"]);
    expect(human.stdout).toContain(`Community app (${session}): synth-app, maintained by Example Maintainer, not tested by SoftwareTeam. Identity not confirmed`);
    const verdict = await until(() => json(["ps", "--nodes", "--software-team", "agent-app-software-team", "--full", "--json"]).then(n => n[0]?.identityVerdict),
      v => v?.verdict === "unconfirmed", 20_000);
    expect(verdict).toMatchObject({ verdict: "unconfirmed", reason: "process_identity_unconfirmed" });
  }, 150_000);

  it("delivers a message through SoftwareTeam send while identity isn't confirmed", async () => {
    const sent = await softwareTeam(["send", session, "hello-from-software-team", "--json"]);
    expect(sent.code, JSON.stringify(sent)).toBe(0);
    expect(await until(async () => capture(), text => text.includes("got: hello-from-software-team"))).toContain("got: hello-from-software-team");
  }, 60_000);

  it("reads a quiet screen as unknown, a changing one as working from window sampling", async () => {
    await sleep(8_000);
    const quiet = await node();
    expect(quiet.activityState).toMatchObject({ activity: "unknown", decidedBy: null });
    expect(quiet.activityState.display).not.toBe("idle");
    await softwareTeam(["send", session, "busy", "--json"]);
    const busy = await until(node, n => n.activityState?.activity === "working", 15_000);
    expect(busy.activityState).toMatchObject({ activity: "working", decidedBy: "window-sampling" });
    const after = await until(node, n => n.activityState?.activity !== "working", 30_000);
    expect(after.activityState.activity).toBe("unknown");
  }, 90_000);

  it("refuses to type into a visible approval prompt", async () => {
    const asked = await softwareTeam(["send", session, "ask", "--json"]);
    expect(asked.code, JSON.stringify(asked)).toBe(0);
    await until(async () => capture(), text => text.includes("Do you want to proceed?"));
    const refused = await softwareTeam(["send", session, "should-not-arrive", "--json"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("target_needs_input");
    expect(capture()).not.toContain("should-not-arrive");
    // SoftwareTeam ps keeps the prompt the screen shows: the app's default-zero needs-input isn't a clearance.
    // The ACTIVITY cell is clipped to its width, as for a built-in's "needs-input x1".
    const row = (out: string) => out.split("\n").find(line => line.includes(session)) ?? "";
    const shown = await until(() => softwareTeam(["ps", "--nodes", "--software-team", "agent-app-software-team"]).then(r => row(r.stdout)), line => line.includes("needs-input"), 20_000);
    expect(shown).toContain("needs-input");
    // The person answers it at the pane.
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "send-keys", "-t", `=${session}:`, "y", "Enter"], { env: scaffold.env as NodeJS.ProcessEnv });
    expect(await until(async () => capture(), text => text.includes("answered: y"))).not.toContain("Do you want to proceed?");
  }, 60_000);

  it("refuses to send once the app has exited to a shell", async () => {
    // The answered prompt is still in the pane's scrollback, which the send guard reads; start this case clean.
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "clear-history", "-t", `=${session}:`], { env: scaffold.env as NodeJS.ProcessEnv });
    const quit = await softwareTeam(["send", session, "quit", "--json"]);
    expect(quit.code, JSON.stringify(quit)).toBe(0);
    await until(async () => capture(), text => text.includes("bye"));
    await sleep(1_000);
    const refused = await softwareTeam(["send", session, "after-exit", "--json"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("target_runtime_unverified");
    // A subset launch calls the app not running, names the recovery, keeps the pane and starts nothing.
    await softwareTeam(["snapshot", softwareTeamId]);
    const launched = await softwareTeam(["launch", softwareTeamId, "work.worker", "--json"], 60_000);
    const seat = JSON.parse(launched.stdout).launched?.find((n: { logicalId: string }) => n.logicalId === "work.worker");
    expect(seat, launched.stdout).toMatchObject({ status: "attention_required" });
    expect(seat.error).toContain(`Session alive, agent not running for 'work.worker'`);
    expect(seat.error).toContain(`SoftwareTeam seat launch ${session} --fresh --stop`);
    expect(capture()).toContain("bye");
    const foreground = execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "display-message", "-p", "-t", `=${session}:`, "#{pane_current_command}"], { env: scaffold.env as NodeJS.ProcessEnv }).toString().trim();
    expect(["bash", "sh", "zsh", "dash"]).toContain(foreground);
  }, 60_000);

  it("reports resume as unsupported and starts nothing", async () => {
    const snapshot = await softwareTeam(["snapshot", softwareTeamId]);
    expect(snapshot.code, JSON.stringify(snapshot)).toBe(0);
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "kill-session", "-t", `=${session}`], { env: scaffold.env as NodeJS.ProcessEnv });
    await until(node, n => n.sessionStatus !== "running", 20_000);
    const launched = await softwareTeam(["launch", softwareTeamId, "work.worker", "--json"], 60_000);
    expect(launched.code).not.toBe(0);
    expect(JSON.parse(launched.stdout)).toMatchObject({ status: "awaiting-decision",
      error: `Resume is unsupported for agent app "synth-app": its preset is launch-only. No session was started, and the earlier conversation is left as it is. Re-run with --fresh work.worker only if you want a new conversation.` });
    expect(() => capture()).toThrow();
    // A new conversation stays the person's deliberate choice.
    const fresh = await softwareTeam(["up", "agent-app-software-team", "--existing", "--fresh", "work.worker", "--json"], 120_000);
    expect(JSON.parse(fresh.stdout).nodes, fresh.stdout).toEqual([expect.objectContaining({ logicalId: "work.worker", status: "fresh-primed" })]);
    expect(await until(async () => capture(), text => text.includes("synth-app 1.0 started"))).toContain("app> ");
    await softwareTeam(["send", session, "quit", "--json"]);
    await until(async () => capture(), text => text.includes("bye"));
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "kill-session", "-t", `=${session}`], { env: scaffold.env as NodeJS.ProcessEnv });
    await until(node, n => n.sessionStatus !== "running", 20_000);
  }, 240_000);

  it("says plainly when a SoftwareTeam names an app that isn't installed, and starts nothing", async () => {
    const up = await softwareTeam(["up", specFor("missing-app-software-team", "no-such-app"), "--cwd", softwareTeamRoot, "--json", "--yes"], 60_000);
    expect(up.code).not.toBe(0);
    expect(JSON.parse(up.stdout)).toMatchObject({ code: "preflight_failed" });
    expect(JSON.parse(up.stdout).errors.join("\n")).toContain(`work.worker: unsupported runtime "no-such-app": it isn't built in, and no agent app preset named "no-such-app" is installed`);
    const all = await json(["ps", "--nodes", "--all-software-teams", "--json"]);
    expect(all.map((n: { softwareTeamName: string }) => n.softwareTeamName)).not.toContain("missing-app-software-team");
  }, 90_000);

  it("keeps an app's seat an agent app after its preset is removed, across a daemon restart and a snapshot", async () => {
    // A fresh start while the preset is installed: this occupant was launched for the app.
    const fresh = await softwareTeam(["up", "agent-app-software-team", "--existing", "--fresh", "work.worker", "--json"], 120_000);
    expect(JSON.parse(fresh.stdout).nodes, fresh.stdout).toEqual([expect.objectContaining({ logicalId: "work.worker", status: "fresh-primed" })]);
    await until(async () => capture(), text => text.includes("synth-app 1.0 started"));
    rmSync(join(presetDir(), "synth-app.yaml"));
    await daemon.restart();
    const seat = await until(node, n => n.identityVerdict?.verdict === "unconfirmed", 30_000);
    expect(seat).toMatchObject({ runtime: "synth-app", identityVerdict: { verdict: "unconfirmed", reason: "process_identity_unconfirmed" } });
    expect(seat.agentApp.presetError).toContain(`no agent app preset named "synth-app" is installed`);
    await sleep(8_000);
    expect((await node()).activityState).toMatchObject({ activity: "unknown", decidedBy: null });
    // Stopped, then a snapshot: still launch-only, so nothing resumes and nothing starts in its place.
    await softwareTeam(["send", session, "quit", "--json"]);
    await until(async () => capture(), text => text.includes("bye"));
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "kill-session", "-t", `=${session}`], { env: scaffold.env as NodeJS.ProcessEnv });
    await until(node, n => n.sessionStatus !== "running", 20_000);
    expect((await softwareTeam(["snapshot", softwareTeamId])).code).toBe(0);
    const launched = await softwareTeam(["launch", softwareTeamId, "work.worker", "--json"], 60_000);
    expect(launched.code).not.toBe(0);
    expect(JSON.parse(launched.stdout)).toMatchObject({ status: "awaiting-decision",
      error: expect.stringContaining(`Resume is unsupported for agent app "synth-app"`) });
    expect(() => capture()).toThrow();
    const again = await softwareTeam(["up", "agent-app-software-team", "--existing", "--fresh", "work.worker", "--json"], 120_000);
    expect(again.stdout + again.stderr).toContain("Harness not started: no synth-app runtime adapter for work.worker.");
    expect(capture()).not.toContain("synth-app 1.0 started");
    expect((await node()).agentApp.presetError).toContain(`no agent app preset named "synth-app" is installed`);
    expect(readFileSync(join(softwareTeamRoot, "agent-app-software-team.yaml"), "utf-8")).toContain("runtime: synth-app");
  }, 300_000);

  /** Self-attach from a new pane on the private tmux server, the way a person runs `softwareTeam attach --self`. */
  async function attachSelf(tmuxSession: string, args: string[]) {
    const script = join(scaffold.root, `${tmuxSession}.sh`);
    const out = join(scaffold.root, `${tmuxSession}.json`);
    const exports = Object.entries(daemon.readEnv).filter(([, v]) => v !== undefined)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n");
    writeFileSync(script, `${exports}\nnode ${JSON.stringify(softwareTeamBin)} attach --self ${args.map(a => JSON.stringify(a)).join(" ")} --json > ${JSON.stringify(out)} 2>&1\nexec sh\n`);
    execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "new-session", "-d", "-s", tmuxSession, "sh", script], { env: scaffold.env as NodeJS.ProcessEnv });
    const text = await until(async () => { try { return readFileSync(out, "utf-8"); } catch { return ""; } }, t => t.trim().endsWith("}"), 30_000);
    return JSON.parse(text);
  }

  it("leaves a free-text self-attached seat as it was, before and after a same-named preset appears", async () => {
    const up = await softwareTeam(["up", specFor("free-software-team", "stub"), "--cwd", softwareTeamRoot, "--json", "--yes"], 120_000);
    expect(up.code, JSON.stringify(up)).toBe(0);
    const freeSoftwareTeamId = JSON.parse(up.stdout).softwareTeamId;
    const attached = await attachSelf("free-seat", ["--software-team", freeSoftwareTeamId, "--pod", "work", "--member", "free", "--runtime", "free-app", "--cwd", softwareTeamRoot]);
    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true });
    const freeSeat = async () => (await json(["ps", "--nodes", "--software-team", "free-software-team", "--full", "--json"])).find((n: { logicalId: string }) => n.logicalId === "work.free");
    const check = async () => {
      const seat = await until(freeSeat, n => n?.identityVerdict?.verdict === "verified" && n?.activityState?.activity === "idle-at-prompt", 30_000);
      expect(seat).toMatchObject({ runtime: "free-app", identityVerdict: { verdict: "verified", reason: null },
        activityState: { activity: "idle-at-prompt", decidedBy: "window-sampling" } });
      expect(seat).not.toHaveProperty("agentApp");
    };
    await check();
    writePreset("free-app.yaml", ["format: 1", "name: free-app", `command: node ${appScript}`, "maintainer: Example Maintainer", ""].join("\n"));
    await sleep(4_000);
    await check();
    // A relaunch doesn't start the same-named app in its place.
    expect((await softwareTeam(["down", "free-software-team", "--json", "--force"])).code).toBe(0);
    // A deliberate fresh launch of the seat gets main's refusal (a self-attached seat has no startup context, checked
    // before any adapter lookup) and starts nothing.
    const seatLaunch = await softwareTeam(["seat", "launch", "work.free@free-software-team", "--fresh", "--reason", "relaunch a free-text seat", "--json"], 60_000);
    expect(seatLaunch.code, JSON.stringify(seatLaunch)).not.toBe(0);
    expect(JSON.parse(seatLaunch.stdout)).toMatchObject({ ok: false, code: "startup_context_missing" });
    const relaunch = await softwareTeam(["up", "free-software-team", "--existing", "--fresh", "work.free", "--json"], 120_000);
    const freeResult = (JSON.parse(relaunch.stdout).nodes ?? []).find((n: { logicalId: string }) => n.logicalId === "work.free");
    // Restore doesn't relaunch a self-attached seat, as on main; with the preset installed it still starts nothing.
    expect(freeResult, relaunch.stdout).toBeUndefined();
    const panes = execFileSync("tmux", ["-S", scaffold.tmuxSocketPath, "list-panes", "-a", "-F", "#{session_name} #{pane_current_command}"], { env: scaffold.env as NodeJS.ProcessEnv }).toString();
    expect(panes).not.toMatch(/free\S* node/);
    await softwareTeam(["down", "free-software-team", "--json", "--force"]);
  }, 300_000);

  it("doesn't pass the agent-app classification to a different occupant of the same seat", async () => {
    expect((await softwareTeam(["down", "agent-app-software-team", "--json", "--force"])).code).toBe(0);
    const attached = await attachSelf("other-occupant", ["--software-team", softwareTeamId, "--node", "work.worker"]);
    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true });
    const seat = await until(node, n => n.identityVerdict?.verdict === "verified", 30_000);
    expect(seat.identityVerdict).toMatchObject({ verdict: "verified", reason: null });
    expect(seat).not.toHaveProperty("agentApp");
  }, 120_000);
});
