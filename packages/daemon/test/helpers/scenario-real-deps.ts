/**
 * Slice 51-02 (L2 test-system) — the REAL-DEPS adapter.
 *
 * Binds the dumb runner core (scenario-runner.ts) to a LIVE scenario-local daemon:
 *   • runAction — maps each action verb to the SHIPPED `softwareTeam … --json` invocation
 *     (product-is-truth transport), run as a real subprocess against the daemon.
 *   • observe   — reads a shipped surface via readSurface (bound to the daemon).
 *   • the `daemon` verb drives the scenario-local daemon LIFECYCLE (sigterm/restart)
 *     directly — it is the test harness's own daemon, not a softwareTeam subprocess.
 *
 * Verb → shipped `softwareTeam` command (traced at 13e26355):
 *   up            → SoftwareTeam up <topology> --json --yes         (captures softwareTeamId/softwareTeamName)
 *   send          → SoftwareTeam send <to> <text> --json
 *   restart <seat>→ SoftwareTeam launch <softwareTeamId> <seat> --json       (seat relaunch/resume;
 *                                                            there is no top-level
 *                                                            `restart` command)
 *   down          → SoftwareTeam down <softwareTeamName|softwareTeamId> --json --force
 *   daemon {op}   → the ScenarioDaemon lifecycle (sigterm | restart)
 *
 * seed_regression calls an explicitly supplied test fault controller. With no
 * controller it fails loud; a declaration alone never counts as a seeded test.
 * restore/emit/mutate/policy have NO shipped runtime binding at v1
 * (they ride 51-03 / A5 items 6-8) — the adapter FAILS LOUD with a named
 * UnboundActionError rather than fabricating a call (same floor as the FLAG-1
 * `proof` surface: unbound is never silently-skipped).
 *
 * `softwareTeamBin` is injected (the single 51-04 container-mode seam); `runSoftwareTeam` is injected
 * so the verb→argv MAPPING is unit-testable without a live daemon.
 */

import { runSoftwareTeam as realRunSoftwareTeam, type SoftwareTeamResult, type ScenarioDaemon } from "./scenario-daemon.js";
import { readSurface } from "./scenario-surfaces.js";
import type { ExpectSurface } from "./scenario-schema.js";
import type { ScenarioRunnerDeps, ActionResult } from "./scenario-runner.js";
import type { RunRecord } from "./scenario-run-record.js";

/** Thrown when an action verb has no shipped runtime binding in v1 (FLAG-1-style floor). */
export class UnboundActionError extends Error {
  readonly verb: string;
  constructor(verb: string) {
    super(
      `action verb "${verb}" is UNBOUND in v1: it has no shipped runtime binding, so the ` +
        `runner FAILS LOUD here rather than fabricating a call (its binding rides 51-03 / A5 ` +
        `items 6-8). This is not a silently-skipped action.` +
        (verb === "emit"
          ? ` WHY (measured at source): the stub runner has NO input channel — no stdin reader, ` +
            `no socket, no CLI/daemon route triggers a behavior; behaviors execute only from the ` +
            `LAUNCH script it reads at boot. A step-time emit therefore cannot be honestly bound ` +
            `without 51-01 source work (routed to the 51-01 backlog), and simulating one would be ` +
            `a green that means nothing. THE V1 PATH: declare env.stub_scripts to deliver a ` +
            `per-seat launch script whose steps carry the behaviors you need.`
          : ""),
    );
    this.name = "UnboundActionError";
    this.verb = verb;
  }
}

/** The subset of a live ScenarioDaemon the adapter needs (readEnv + lifecycle). */
export type RealDepsDaemon = Pick<ScenarioDaemon, "readEnv" | "baseUrl" | "sigterm" | "restart">;

export interface RealDepsOptions {
  daemon: RealDepsDaemon;
  /** Path to the shipped `softwareTeam` bin (the single 51-04 injectable invocation seam). */
  softwareTeamBin: string;
  /** Resolved software-team-spec path for the `up` verb (the scenario's `topology`). */
  topologyPath: string;
  /**
   * Scratch working directory passed to `SoftwareTeam up --cwd` so a seat's `cwd: "."`
   * resolves under the hermetic scaffold (its managed-file writes — AGENTS.md,
   * the stub readiness sidecar — never pollute the launch cwd). Omitted → the
   * shipped default (the daemon's cwd).
   */
  seatCwd?: string;
  /** Injected `softwareTeam` runner (defaults to the real subprocess runner; tests inject a spy). */
  runSoftwareTeam?: (
    args: string[],
    env: Record<string, string | undefined>,
    softwareTeamBin: string,
    timeoutMs?: number,
  ) => Promise<SoftwareTeamResult>;
  /** Injected scenario-local clock (ms) for the poll bound. Defaults to Date.now. */
  now?: () => number;
  /** Injected sleep between polls. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional run-record sink. */
  appendRecord?: (rec: RunRecord) => void;
  /** The single default within/poll pair. */
  defaults?: { withinMs: number; pollIntervalMs: number };
  /** The v1 runner-internal normalizer seam for the `equals` mode (lock amendment
   *  A-N1: runner-internal interface of record; the DECLARATIVE artifact remains
   *  the only scenario-facing form, rides 51-03, and lowers to this seam). */
  normalizer?: (surface: ExpectSurface, value: unknown) => unknown;
  /** The mission scope reads audit (D3) — threaded from the scenario's
   *  env.scope_mission into `SoftwareTeam scope audit --mission <name> --json`. */
  scopeMission?: string;
  /** Arm a named, scenario-local test fault (or explicitly record its healthy
   * control). The paired harness owns injection timing and verifies the actual
   * failing observation; this must never invoke a production `softwareTeam` command. */
  seedRegression?: (regressionClass: string) => Promise<ActionResult>;
}

/** `SoftwareTeam up` is heavy (real tmux seat launch) — give it a generous ceiling. */
const UP_TIMEOUT_MS = 120_000;

const fail = (stderr: string): ActionResult => ({ code: 1, stdout: "", stderr });

/** Build the live ScenarioRunnerDeps for the dumb runner core. */
export function buildRealDeps(opts: RealDepsOptions): ScenarioRunnerDeps {
  const { daemon, softwareTeamBin, topologyPath } = opts;
  const runSoftwareTeam = opts.runSoftwareTeam ?? realRunSoftwareTeam;

  // Captured from the `up` result so down/restart target the real softwareTeam (never fabricated).
  let softwareTeamId: string | undefined;
  let softwareTeamName: string | undefined;

  const runAction = async (verb: string, payload: unknown, seat?: string): Promise<ActionResult> => {
    switch (verb) {
      case "up": {
        const upArgs = ["up", topologyPath, "--json", "--yes"];
        if (opts.seatCwd) upArgs.push("--cwd", opts.seatCwd);
        const r = await runSoftwareTeam(upArgs, daemon.readEnv, softwareTeamBin, UP_TIMEOUT_MS);
        if (r.code === 0) {
          try {
            const j = JSON.parse(r.stdout) as Record<string, unknown>;
            const softwareTeam = (j.softwareTeam as Record<string, unknown> | undefined) ?? undefined;
            softwareTeamId = (j.softwareTeamId as string) ?? (softwareTeam?.id as string) ?? softwareTeamId;
            softwareTeamName = (j.softwareTeamName as string) ?? (softwareTeam?.name as string) ?? softwareTeamName;
          } catch {
            /* non-JSON up output — leave the softwareTeam ids uncaptured; down/restart will fail loud */
          }
        }
        return r;
      }
      case "send": {
        const p = (payload && typeof payload === "object" ? payload : {}) as { to?: string; text?: string };
        const to = p.to ?? seat;
        const text = p.text ?? "";
        if (!to) return fail("send: no recipient (payload.to or a seat is required)");
        return runSoftwareTeam(["send", to, text, "--json"], daemon.readEnv, softwareTeamBin);
      }
      case "restart": {
        // Seat relaunch/resume — SoftwareTeam launch <softwareTeamId> <seat>. Distinct from the
        // `daemon` verb (which restarts the scenario-local DAEMON, not a seat).
        const node = typeof payload === "string" ? payload : seat;
        const target = softwareTeamId ?? softwareTeamName;
        if (!target) return fail("restart: no SoftwareTeam brought up yet (no softwareTeamId/softwareTeamName captured from `up`)");
        if (!node) return fail("restart: no seat named (restart <seat>)");
        return runSoftwareTeam(["launch", target, node, "--json"], daemon.readEnv, softwareTeamBin);
      }
      case "down": {
        const target = softwareTeamName ?? softwareTeamId;
        if (!target) return fail("down: no SoftwareTeam brought up yet (no softwareTeamId/softwareTeamName captured from `up`)");
        return runSoftwareTeam(["down", target, "--json", "--force"], daemon.readEnv, softwareTeamBin);
      }
      case "daemon": {
        const op = (payload && typeof payload === "object" ? (payload as { op?: string }).op : undefined);
        if (op === "sigterm") { await daemon.sigterm(); return { code: 0, stdout: "", stderr: "" }; }
        if (op === "restart") { await daemon.restart(); return { code: 0, stdout: "", stderr: "" }; }
        return fail(`daemon: unknown op ${JSON.stringify(op)} (allowed: sigterm, restart)`);
      }
      case "seed_regression": {
        const regressionClass = payload && typeof payload === "object"
          ? (payload as { class?: unknown }).class : undefined;
        if (typeof regressionClass !== "string" || regressionClass.length === 0) {
          return fail("seed_regression: a non-empty class is required");
        }
        if (!opts.seedRegression) throw new UnboundActionError(verb);
        return opts.seedRegression(regressionClass);
      }
      default:
        // restore / emit / mutate / policy — no shipped binding at v1.
        throw new UnboundActionError(verb);
    }
  };

  const observe = (surface: ExpectSurface, o: { seat?: string }): Promise<unknown> =>
    readSurface(
      surface,
      { softwareTeamBin, readEnv: daemon.readEnv, baseUrl: daemon.baseUrl },
      { seat: o.seat, scopeMission: opts.scopeMission },
    );

  return {
    runAction,
    observe,
    now: opts.now ?? (() => Date.now()),
    sleep: opts.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms))),
    appendRecord: opts.appendRecord,
    defaults: opts.defaults ?? { withinMs: 15_000, pollIntervalMs: 250 },
    normalizer: opts.normalizer,
  };
}
