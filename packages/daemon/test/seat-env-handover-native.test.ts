import { describe, it, expect, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";

// A one-off `SoftwareTeam up --env` value reaches the first pane and stays with it. This launches a seat through
// the real NodeLauncher and hands it over through the real SeatHandoverService, on an ISOLATED tmux
// server (per-run -L socket, torn down by session name, never kill-server), and reads what each
// pane's shell actually has in its environment. It runs wherever tmux does (Linux and macOS).

const pexec = promisify(execFile);
const SOCK = `softwareteam-seatenv-${process.pid}`;
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
delete cleanEnv.TMUX;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const exec = async (cmd: string): Promise<string> => {
  const safe = cmd.startsWith("tmux ") ? `tmux -L ${SOCK} ${cmd.slice(5)}` : cmd;
  return (await pexec("sh", ["-c", safe], { env: cleanEnv })).stdout;
};
const tmux = (a: string) => exec(`tmux ${a}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const available = (() => { try { execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" }); return true; } catch { return false; } })();

const SEAT = "dev-impl@envhandover-software-team";
const scratch = mkdtempSync(path.join(tmpdir(), "seatenv-"));
afterAll(async () => {
  await tmux(`kill-session -t ${q(SEAT)}`).catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
});

/** What the pane's shell has exported right now: the shell writes it out, so no /proc is needed. */
async function paneEnviron(tag: string): Promise<Record<string, string>> {
  const file = path.join(scratch, `${tag}.env`);
  const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
  await tmux(`send-keys -t ${q(pane)} -l -- ${q(`env > ${q(file)}.part && mv ${q(file)}.part ${q(file)}`)}`);
  await tmux(`send-keys -t ${q(pane)} Enter`);
  for (let i = 0; i < 50 && !existsSync(file); i++) await sleep(100);
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("a one-off --env value stays with the first launch (real tmux)", () => {
  it.runIf(available)("the first pane has it; a handover successor gets the spec's env and SoftwareTeam's values, and the handover never touches the session environment", async () => {
    const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
    const softwareTeamRepo = new SoftwareTeamRepository(db), sessionRegistry = new SessionRegistry(db);
    const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("envhandover-software-team");
    softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "codex", cwd: scratch, env: { SHARED: "from-spec", MEMBER_ONLY: "m" } });
    softwareTeamRepo.setSoftwareTeamEnv(softwareTeam.id, { SOFTWARE_TEAM_ONLY: "r" });

    // The first launch through NodeLauncher: a one-off over a declared name, a one-off-only name, and
    // HOME, which SoftwareTeam sets for the seat.
    const adapter = new TmuxAdapter(exec);
    const launcher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: adapter, sessionEnv: { HOME: "/softwareteam/home" } });
    const launched = await launcher.launchNode(softwareTeam.id, "dev.impl", {
      sessionName: SEAT, cwd: scratch,
      env: { SHARED: "one-off-wins", ONLY_THIS_LAUNCH: "debug", HOME: "/one-off/home" },
    });
    expect(launched.ok).toBe(true);
    await sleep(300);
    const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
    await tmux(`send-keys -t ${q(pane)} -l -- ${q("trap 'exit 0' TERM")}`);
    await tmux(`send-keys -t ${q(pane)} Enter`);
    await sleep(200);

    // The first pane was started with the one-offs.
    expect(await paneEnviron("first")).toMatchObject({ SHARED: "one-off-wins", ONLY_THIS_LAUNCH: "debug", HOME: "/one-off/home", MEMBER_ONLY: "m", SOFTWARE_TEAM_ONLY: "r" });
    // The session no longer carries them: the spec's value, SoftwareTeam's value, and nothing for the one-off-only name.
    expect(await adapter.getSessionEnv(SEAT, "SHARED")).toBe("from-spec");
    expect(await adapter.getSessionEnv(SEAT, "HOME")).toBe("/softwareteam/home");
    expect(await adapter.getSessionEnv(SEAT, "ONLY_THIS_LAUNCH")).toBeUndefined();

    sessionRegistry.updateStartupStatus(sessionRegistry.getSessionsForSoftwareTeam(softwareTeam.id)[0]!.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
    // The handover gets a tmux adapter whose environment calls all fail: it must not need them.
    const environmentCalls = new Set(["getSessionEnv", "setSessionEnv", "unsetSessionEnv"]);
    const handoverTmux = new Proxy(adapter, {
      get(target, prop) {
        if (typeof prop === "string" && environmentCalls.has(prop)) return async () => { throw new Error("the handover read or wrote the session environment"); };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtime = {
      runtime: "codex",
      async launchHarness() { return { ok: true, resumeToken: "tok", resumeType: "codex_id" }; },
      async checkReady() { return { ready: true }; },
    };
    const service = new SeatHandoverService({
      db, softwareTeamRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: handoverTmux, runtimeAdapters: { codex: runtime as never },
      predecessorRecapResolver: () => ({ recap: [], recordPath: path.join(scratch, "none.jsonl") }),
      readinessTimeoutMs: 3000, sleep,
    });

    const result = await service.handover({ seatRef: SEAT, reason: "context ~85%", source: "fresh", operator: "orch@seat" });
    expect(result.ok).toBe(true);
    await sleep(300);

    // The successor shell has the spec's env and SoftwareTeam's HOME; the one-off name and values are gone.
    const env = await paneEnviron("successor");
    expect(env).toMatchObject({ SHARED: "from-spec", MEMBER_ONLY: "m", SOFTWARE_TEAM_ONLY: "r", HOME: "/softwareteam/home" });
    expect(env).not.toHaveProperty("ONLY_THIS_LAUNCH");
    expect(Object.values(env)).not.toContain("one-off-wins");
    expect(Object.values(env)).not.toContain("/one-off/home");
    db.close();
  }, 60_000);
});
