import { describe, it, expect, vi } from "vitest";
import { buildRealDeps, UnboundActionError } from "./helpers/scenario-real-deps.js";
import type { SoftwareTeamResult } from "./helpers/scenario-daemon.js";

// Slice 51-02 — the REAL-DEPS adapter: it binds the dumb runner core to a live
// ScenarioDaemon. runAction maps each action verb to the SHIPPED `softwareTeam` invocation
// (the product-is-truth transport); observe binds to readSurface; the daemon verb
// drives the scenario-local daemon lifecycle (never a softwareTeam subprocess). Unbound v1
// verbs FAIL LOUD (mirrors the FLAG-1 proof-surface floor — never fabricate).

function fakeDaemon(over: Record<string, unknown> = {}) {
  return {
    readEnv: { SOFTWARETEAM_URL: "http://127.0.0.1:9", HOME: "/x" } as Record<string, string | undefined>,
    baseUrl: "http://127.0.0.1:9",
    sigterm: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    ...over,
  };
}

const ok = (stdout = ""): SoftwareTeamResult => ({ code: 0, stdout, stderr: "" });

describe("buildRealDeps runAction verb->SoftwareTeam map", () => {
  it("maps up to `SoftwareTeam up <topology> --json --yes` and captures softwareTeamId/softwareTeamName", async () => {
    const calls: string[][] = [];
    const runSoftwareTeam = vi.fn(async (args: string[]) => { calls.push(args); return ok(JSON.stringify({ softwareTeamId: "r-1", softwareTeamName: "demo" })); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), softwareTeamBin: "/bin/softwareTeam", topologyPath: "/t/spec.yaml", runSoftwareTeam });
    const r = await deps.runAction("up", {}, undefined);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual(["up", "/t/spec.yaml", "--json", "--yes"]);
  });

  it("appends `--cwd <seatCwd>` to up so seat writes land in scratch (no launch-cwd pollution)", async () => {
    const calls: string[][] = [];
    const runSoftwareTeam = vi.fn(async (args: string[]) => { calls.push(args); return ok(JSON.stringify({ softwareTeamId: "r-1", softwareTeamName: "demo" })); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), softwareTeamBin: "/bin/softwareTeam", topologyPath: "/t/spec.yaml", seatCwd: "/scratch/seat", runSoftwareTeam });
    await deps.runAction("up", {}, undefined);
    expect(calls[0]).toEqual(["up", "/t/spec.yaml", "--json", "--yes", "--cwd", "/scratch/seat"]);
  });

  it("maps send to `SoftwareTeam send <to> <text> --json` (recipient from payload.to or the seat)", async () => {
    const calls: string[][] = [];
    const runSoftwareTeam = vi.fn(async (args: string[]) => { calls.push(args); return ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), softwareTeamBin: "/bin/softwareTeam", topologyPath: "/t/spec.yaml", runSoftwareTeam });
    await deps.runAction("send", { to: "a@r", text: "hello" }, undefined);
    expect(calls[0]).toEqual(["send", "a@r", "hello", "--json"]);
  });

  it("maps restart <seat> to `SoftwareTeam launch <softwareTeamId> <seat> --json` after up captured the softwareTeamId", async () => {
    const calls: string[][] = [];
    const runSoftwareTeam = vi.fn(async (args: string[]) => { calls.push(args); return args[0] === "up" ? ok(JSON.stringify({ softwareTeamId: "r-9", softwareTeamName: "demo" })) : ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), softwareTeamBin: "/bin/softwareTeam", topologyPath: "/t/spec.yaml", runSoftwareTeam });
    await deps.runAction("up", {}, undefined);
    await deps.runAction("restart", "seat-a", "seat-a");
    expect(calls[1]).toEqual(["launch", "r-9", "seat-a", "--json"]);
  });

  it("maps down to `SoftwareTeam down <softwareTeamName> --json --force` using the captured softwareTeam", async () => {
    const calls: string[][] = [];
    const runSoftwareTeam = vi.fn(async (args: string[]) => { calls.push(args); return args[0] === "up" ? ok(JSON.stringify({ softwareTeamId: "r-9", softwareTeamName: "demo" })) : ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), softwareTeamBin: "/bin/softwareTeam", topologyPath: "/t/spec.yaml", runSoftwareTeam });
    await deps.runAction("up", {}, undefined);
    await deps.runAction("down", {}, undefined);
    expect(calls[1]).toEqual(["down", "demo", "--json", "--force"]);
  });

  it("drives the scenario-local daemon lifecycle for the daemon verb, never a SoftwareTeam subprocess", async () => {
    const runSoftwareTeam = vi.fn(async () => ok());
    const daemon = fakeDaemon();
    const deps = buildRealDeps({ daemon, softwareTeamBin: "/bin/softwareTeam", topologyPath: "/t/spec.yaml", runSoftwareTeam });
    expect((await deps.runAction("daemon", { op: "sigterm" }, undefined)).code).toBe(0);
    expect(daemon.sigterm).toHaveBeenCalledOnce();
    expect((await deps.runAction("daemon", { op: "restart" }, undefined)).code).toBe(0);
    expect(daemon.restart).toHaveBeenCalledOnce();
    expect(runSoftwareTeam).not.toHaveBeenCalled();
  });

  it("FAILs down when no SoftwareTeam was brought up — no fabricated target", async () => {
    const runSoftwareTeam = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), softwareTeamBin: "/bin/softwareTeam", topologyPath: "/t/spec.yaml", runSoftwareTeam });
    const r = await deps.runAction("down", {}, undefined);
    expect(r.code).not.toBe(0);
    expect(runSoftwareTeam).not.toHaveBeenCalled();
  });

  it("throws UnboundActionError for a v1-unbound verb (restore/emit/mutate/policy/seed_regression) — fail loud", async () => {
    const runSoftwareTeam = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), softwareTeamBin: "/bin/softwareTeam", topologyPath: "/t/spec.yaml", runSoftwareTeam });
    await expect(deps.runAction("emit", { seat: "a@r", behavior: "restore" }, "a@r")).rejects.toBeInstanceOf(UnboundActionError);
    await expect(deps.runAction("seed_regression", { class: "x" }, undefined)).rejects.toBeInstanceOf(UnboundActionError);
    expect(runSoftwareTeam).not.toHaveBeenCalled();
  });

  it("exposes injectable clock/sleep and the default within/poll pair", async () => {
    const deps = buildRealDeps({ daemon: fakeDaemon(), softwareTeamBin: "/bin/softwareTeam", topologyPath: "/t/spec.yaml", now: () => 42, sleep: async () => {} });
    expect(deps.now()).toBe(42);
    expect(deps.defaults.withinMs).toBeGreaterThan(0);
    expect(deps.defaults.pollIntervalMs).toBeGreaterThan(0);
  });

  it("binds a named seed to the caller's fault controller and preserves its failure", async () => {
    const result = { code: 1, stdout: "", stderr: "fault could not be armed" };
    const seedRegression = vi.fn(async () => result);
    const runSoftwareTeam = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), softwareTeamBin: "/bin/softwareTeam", topologyPath: "/t.yaml", runSoftwareTeam, seedRegression });
    expect(await deps.runAction("seed_regression", { class: "baton-drop" })).toBe(result);
    expect(seedRegression).toHaveBeenCalledExactlyOnceWith("baton-drop");
    expect(runSoftwareTeam).not.toHaveBeenCalled();
  });

  it("rejects a malformed seed before invoking the fault controller", async () => {
    const seedRegression = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), softwareTeamBin: "/bin/softwareTeam", topologyPath: "/t.yaml", seedRegression });
    for (const payload of [undefined, {}, { class: "" }, { class: 42 }]) {
      expect((await deps.runAction("seed_regression", payload)).code).toBe(1);
    }
    expect(seedRegression).not.toHaveBeenCalled();
  });
});

describe("D2 — the unbound-verb message states WHY and names the v1 path", () => {
  it("emit's refusal names the missing input channel and points at env.stub_scripts", async () => {
    const deps = buildRealDeps({
      daemon: { readEnv: {}, baseUrl: "http://127.0.0.1:1", sigterm: async () => {}, restart: async () => {} },
      softwareTeamBin: "/bin/softwareTeam",
      topologyPath: "/t.yaml",
    });
    let msg = "";
    try { await deps.runAction("emit", { seat: "a@r", behavior: "compaction" }, "a@r"); } catch (e) { msg = (e as Error).message; }
    // the measured reason: the stub runner has no stdin/input channel, so a
    // step-time emit cannot be honestly bound without 51-01 source work
    expect(msg).toContain("input channel");
    // and the path that DOES work today
    expect(msg).toContain("env.stub_scripts");
    expect(msg.toLowerCase()).toContain("launch");
  });
});
