// OPR.0.3.4.1 — SoftwareTeam start: one-command recovery orchestrator.
// Sequences existing primitives: daemon-start -> kernel auto-boot observe ->
// candidate listing (restore-usable snapshots) -> picker/flags ->
// per-SoftwareTeam restore (slice-02 /api/up) + reconcile (slice-03). Re-codes nothing.

import { Command } from "commander";
import { DaemonClient, DaemonConnectionError } from "../client.js";
import {
  getDaemonStatus,
  getDaemonUrl,
  startDaemon,
  waitForKernelReady,
  type LifecycleDeps,
} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_UP_TIMEOUT_MS = 120_000;
const KERNEL_WAIT_MS = 60_000;

interface SoftwareTeamSummary {
  id: string;
  name: string;
  nodeCount?: number;
  lifecycleState?: string;
  // Includes intentional stops for restore selection; absent on older daemons.
  restoreLifecycleState?: string;
}

interface PlanPreviewNode {
  logicalId: string;
  intendedAction: string;
  reason?: string;
  // OPR.0.4.3.20 FR-6 — per-seat token truth on the wire (SoftwareTeam start's picker
  // only aggregates intendedAction; `SoftwareTeam up --plan` renders these per seat).
  tokenState?: "present" | "missing" | "stale" | "unverified";
  provenance?: string | null;
  lastVerified?: string | null;
  freshRequired?: boolean;
  runtimePrompt?: string;
}

interface PlanPreviewResponse {
  status: string;
  mode: string;
  softwareTeamId: string;
  softwareTeamName: string;
  snapshot: { id: string; kind: string; createdAt: string } | null;
  wouldCaptureCurrentState: boolean;
  nodes: PlanPreviewNode[];
  mutated: boolean;
}

export interface StartCandidate {
  softwareTeamId: string;
  softwareTeamName: string;
  lifecycleState: string;
  nodeCount: number;
  lastActivity: string | null;
  preview: PlanPreviewResponse | null;
  /** What the seats say about the last stop; read only under `--last`, where `down` is kept down. */
  lastStop: LastStopState | null;
}

/**
 * `down`: at least one seat was launched and every launched seat carries the recorded stop
 * intent (`intentionallyStopped`, set by `SoftwareTeam down` and `softwareTeam seat stop`).
 * `was_running`: anything else, including a plain `exited` without the intent, a seat the boot
 * reconciler marked `detached` when tmux was lost, and a daemon that does not report the intent.
 * `unknown`: the seat statuses could not be read.
 */
export type LastStopState = "was_running" | "down" | "unknown";

export function lastStopState(nodes: unknown): LastStopState {
  if (!Array.isArray(nodes)) return "unknown";
  let launched = 0;
  let allStoppedOnPurpose = true;
  for (const node of nodes) {
    if (!node || typeof node !== "object" || !("sessionStatus" in node)) return "unknown";
    const { sessionStatus, intentionallyStopped } = node as { sessionStatus: unknown; intentionallyStopped?: unknown };
    if (sessionStatus !== null && typeof sessionStatus !== "string") return "unknown";
    if (intentionallyStopped !== undefined && typeof intentionallyStopped !== "boolean") return "unknown";
    if (sessionStatus === null) continue; // never launched: neutral
    launched++;
    if (intentionallyStopped !== true) allStoppedOnPurpose = false;
  }
  return launched > 0 && allStoppedOnPurpose ? "down" : "was_running";
}

/** Default interactive [y/N] prompt (same shape as up.ts, reused for the TTY path). */
async function defaultPromptYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Minimal spacebar multi-select picker for TTY (NET-NEW, lightweight). */
async function multiSelectPicker(items: Array<{ label: string; value: string; checked: boolean }>): Promise<string[]> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.close();

  const { createInterface } = readline;
  return new Promise<string[]>((resolve) => {
    const state = items.map((item) => ({ ...item }));
    let cursor = 0;

    const render = () => {
      process.stdout.write("\x1b[?25l");
      for (let i = 0; i < state.length; i++) {
        const prefix = i === cursor ? ">" : " ";
        const check = state[i]!.checked ? "[x]" : "[ ]";
        process.stdout.write(`\r${prefix} ${check} ${state[i]!.label}\n`);
      }
      process.stdout.write(`\r  (space=toggle, enter=confirm, a=all, n=none)\n`);
      process.stdout.write(`\x1b[${state.length + 1}A`);
    };

    render();

    if (!process.stdin.isTTY) {
      resolve(state.filter((s) => s.checked).map((s) => s.value));
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write(`\x1b[${state.length + 1}B\r`);
      process.stdout.write("\x1b[?25h");
    };

    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === " ") {
        state[cursor]!.checked = !state[cursor]!.checked;
        render();
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(state.filter((s) => s.checked).map((s) => s.value));
      } else if (key === "\x1b[A" || key === "k") {
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = Math.min(state.length - 1, cursor + 1);
        render();
      } else if (key === "a") {
        state.forEach((s) => { s.checked = true; });
        render();
      } else if (key === "n") {
        state.forEach((s) => { s.checked = false; });
        render();
      } else if (key === "\x03") {
        cleanup();
        process.exitCode = 130;
        resolve([]);
      }
    };
    process.stdin.on("data", onData);
  });
}

export interface StartDeps extends StatusDeps {
  promptYesNo?: (question: string) => Promise<boolean>;
  /** Test seam (mirrors upCommand's): inject the preflight exec so auto-start tests
   *  never run real system commands. */
  preflightExec?: (cmd: string) => Promise<string>;
}

export function startCommand(depsOverride?: StartDeps): Command {
  const cmd = new Command("start")
    .description("Start the daemon, verify kernel, and restore softwareTeams that were last running")
    .addHelpText("after", `
Examples:
  SoftwareTeam start                         Interactive: daemon + kernel + pick-and-restore
  SoftwareTeam start --last                  Headless: restore everything that was running, except softwareTeams stopped on purpose
  SoftwareTeam start --all                   Headless: restore all softwareTeams with restore-usable snapshots
  SoftwareTeam start --software-teams prod-software-team dev-software-team Headless: restore only the named softwareTeams
`);
  const getDepsF = (): StartDeps =>
    depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--last", "Headless: restore all softwareTeams that were last running; a SoftwareTeam stopped on purpose (with SoftwareTeam down or SoftwareTeam seat stop) stays down (zero prompts)")
    .option("--all", "Headless: restore all softwareTeams with restore-usable snapshots (zero prompts)")
    .option("--software-teams <names...>", "Headless: restore only the named softwareTeams (zero prompts)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { last?: boolean; all?: boolean; softwareTeams?: string[]; json?: boolean }) => {
      const deps = getDepsF();

      // ---- PHASE 1: ensure daemon is running ----
      let status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running") {
        if (!opts.json) console.log("Starting daemon...");
        try {
          const { ConfigStore } = await import("../config-store.js");
          const configStore = new ConfigStore();
          const resolvedConfig = configStore.resolve();
          const hostResolution = configStore.resolveWithSource("daemon.host");
          const { SystemPreflight } = await import("../system-preflight.js");
          const { execSync } = await import("node:child_process");
          const { SOFTWARETEAM_DIR, resolveBindIntent } = await import("../daemon-lifecycle.js");
          // S20 (r2 repair): the SHARED dedicated-intent seam — an env-sourced
          // daemon.host (ENV_MAP ← SOFTWARETEAM_HOST, the injected routing channel) never
          // creates bind intent through auto-start; flag-less auto-start honors only a
          // FILE-sourced daemon.host or SOFTWARETEAM_BIND_HOST.
          const hostForDaemon = resolveBindIntent({
            flagHost: undefined,
            envBindHost: process.env["SOFTWARETEAM_BIND_HOST"],
            configSource: hostResolution.source,
            configHost: resolvedConfig.daemon.host,
          }).host;
          const preflight = new SystemPreflight({
            exec: depsOverride?.preflightExec ?? (async (cmd: string) =>
              execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })),
            configStore,
            getDaemonStatus: () => getDaemonStatus(deps.lifecycleDeps),
            softwareteamHome: SOFTWARETEAM_DIR,
          });
          const preflightResult = await preflight.run();
          if (!preflightResult.ready) {
            for (const check of preflightResult.checks.filter((c) => !c.ok)) {
              console.error(`  ${check.name}: ${check.error}`);
              if (check.fix) console.error(`    Fix: ${check.fix}`);
            }
            process.exitCode = 1;
            return;
          }
          await startDaemon({
            port: resolvedConfig.daemon.port,
            host: hostForDaemon,
            db: resolvedConfig.db.path,
            transcriptsEnabled: resolvedConfig.transcripts.enabled,
            transcriptsPath: resolvedConfig.transcripts.path,
            workspaceRoot: resolvedConfig.workspace.root,
            contextRoot: resolvedConfig.context.root,
            skillsRoot: resolvedConfig.skills.root,
            topologyRoot: resolvedConfig.topology.root,
          }, deps.lifecycleDeps);
          status = await getDaemonStatus(deps.lifecycleDeps);
        } catch (err) {
          console.error(`Daemon start failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 2;
          return;
        }
      }

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon is not healthy. Check with: SoftwareTeam daemon status");
        process.exitCode = 1;
        return;
      }

      const baseUrl = getDaemonUrl(status);
      const client = deps.clientFactory(baseUrl);

      // ---- PHASE 2: kernel invariant — verify/await kernel readiness ----
      if (!opts.json) console.log("Waiting for kernel...");
      const kernelResult = await waitForKernelReady(baseUrl, KERNEL_WAIT_MS);
      if (!kernelResult.ok) {
        if (kernelResult.kernelState === "skipped") {
          // The daemon also skips its boot when a kernel softwareTeam already exists (kernel-boot.ts).
          // That softwareTeam need not be running, after a reboot it is not, and this command does not restore it.
          if (!opts.json) console.log(kernelResult.detail === "kernel SoftwareTeam already managed"
            ? "Kernel auto-boot skipped (kernel SoftwareTeam already managed). If its seats are not running, for example after a reboot, bring it back with: SoftwareTeam up kernel --existing"
            : "Kernel auto-boot skipped (--no-kernel or test mode), including the operator that helps you start a team. To start it later, run softwareTeam, set up or select kernel, then start its operator seat.");
        } else {
          const terminalFailure = ["auth_blocked", "spec_missing", "bootstrap_failed", "degraded"].includes(kernelResult.kernelState ?? "");
          console.error(`${terminalFailure ? "Kernel failed to start" : "Kernel did not report ready before the deadline"}: state=${kernelResult.kernelState ?? "unknown"}, detail=${kernelResult.detail ?? "none"}`);
          console.error("Cannot proceed to SoftwareTeam restore without a working kernel.");
          console.error("Fix: resolve the kernel issue, then rerun: SoftwareTeam start");
          process.exitCode = 1;
          return;
        }
      } else if (!opts.json) {
        console.log("Kernel ready.");
      }

      // Verify UI is actually serving before announcing the URL.
      let uiUrl: string | null = null;
      try {
        const healthRes = await fetch(`${baseUrl}/healthz`);
        if (healthRes.ok) {
          uiUrl = baseUrl;
        }
      } catch { /* UI not serving yet — degrade gracefully */ }
      if (uiUrl && !opts.json) {
        console.log(`UI: ${uiUrl}`);
      }

      // ---- PHASE 3: list last-running candidates ----
      let allSummaries: SoftwareTeamSummary[];
      try {
        const res = await client.get<SoftwareTeamSummary[]>("/api/software-teams/summary");
        if (res.status !== 200) throw new Error(`Daemon returned HTTP ${res.status}`);
        allSummaries = res.data ?? [];
      } catch (err) {
        console.error(`Failed to list softwareTeams: ${err instanceof Error ? err.message : String(err)}. Daemon may not be ready.`);
        process.exitCode = 1;
        return;
      }

      // Guard BLOCKING f359e3a3: use the id-based Explorer route for candidate
      // preview (POST /api/software-teams/:id/up with plan:true) instead of the name-based
      // POST /api/up which 409s on same-name softwareTeams and silently drops them.
      const candidates: StartCandidate[] = [];
      // Guard BLOCKING bfed4ce3: track preview errors so they are not collapsed
      // into a clean empty-candidate result.
      const previewErrors: Array<{ softwareTeamId: string; softwareTeamName: string; code: string; message: string }> = [];
      // Not errors: the run still succeeds. Only --last adds them (seat_status_unreadable).
      const warnings: Array<{ softwareTeamId: string; softwareTeamName: string; code: string; message: string }> = [];
      // --all wins over --last; only --last reads the seats.
      const lastOnly = Boolean(opts.last && !opts.all);
      for (const softwareTeam of allSummaries) {
        if (softwareTeam.name === "kernel") continue;
        const lifecycleState = softwareTeam.restoreLifecycleState ?? softwareTeam.lifecycleState;
        if (lifecycleState === "running") continue;

        try {
          const planRes = await client.post<Record<string, unknown>>(
            `/api/software-teams/${encodeURIComponent(softwareTeam.id)}/up`,
            { plan: true },
          );
          if (planRes.status === 200 && planRes.data["status"] === "plan") {
            const preview = planRes.data as unknown as PlanPreviewResponse;

            let lastActivity: string | null = null;
            try {
              const softwareTeamDetail = await client.get<{ sessions?: Array<{ lastSeenAt?: string | null }> }>(`/api/software-teams/${softwareTeam.id}`);
              const sessions = softwareTeamDetail.data?.sessions ?? [];
              const dates = sessions.map((s) => s.lastSeenAt).filter((d): d is string => !!d).sort();
              lastActivity = dates.length > 0 ? dates[dates.length - 1]! : null;
            } catch { /* degrade: lastActivity stays null */ }

            let lastStop: LastStopState | null = null;
            if (lastOnly) {
              lastStop = "unknown";
              try {
                const nodesRes = await client.get<unknown>(`/api/software-teams/${encodeURIComponent(softwareTeam.id)}/nodes`);
                if (nodesRes.status === 200) lastStop = lastStopState(nodesRes.data);
              } catch { /* lastStop stays unknown; --last restores the softwareTeam with a warning */ }
            }

            candidates.push({
              softwareTeamId: softwareTeam.id,
              softwareTeamName: softwareTeam.name,
              lifecycleState: lifecycleState ?? "unknown",
              nodeCount: softwareTeam.nodeCount ?? 0,
              lastActivity,
              preview,
              lastStop,
            });
          } else if (planRes.status === 404) {
            // no_snapshot or not found — this softwareTeam is not a candidate (expected exclusion).
          } else {
            const code = String(planRes.data["code"] ?? `http_${planRes.status}`);
            const errorText = String(planRes.data["error"] ?? "preview failed");
            previewErrors.push({ softwareTeamId: softwareTeam.id, softwareTeamName: softwareTeam.name, code, message: errorText });
            if (!opts.json) console.error(`  ${softwareTeam.name}: candidate preview failed -- ${errorText} (${code})`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          previewErrors.push({ softwareTeamId: softwareTeam.id, softwareTeamName: softwareTeam.name, code: "transport_error", message: msg });
          if (!opts.json) console.error(`  ${softwareTeam.name}: candidate preview unavailable (transport error)`);
        }
      }

      if (candidates.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({
            status: previewErrors.length > 0 ? "started_with_errors" : "started",
            candidates: [],
            keptDown: lastOnly ? [] : undefined,
            restoredSoftwareTeams: [],
            previewErrors: previewErrors.length > 0 ? previewErrors : undefined,
          }));
        } else {
          if (previewErrors.length > 0) {
            console.error(`${previewErrors.length} softwareTeam(s) failed preview (see errors above). Some candidates may be missing.`);
          } else {
            console.log("Daemon and kernel are up. No softwareTeams to restore.");
          }
        }
        if (previewErrors.length > 0) process.exitCode = 1;
        return;
      }

      // ---- PHASE 4: selection (id-grounded, rev1 BLOCKING b4c6ada4) ----
      let selectedCandidates: StartCandidate[];
      // --last keeps down a softwareTeam whose every launched seat carries the recorded stop intent, and
      // names the command that brings it back. Any other softwareTeam, including one whose seats could not
      // be read (a warning, not an error), is restored as --all would. --all and --software-teams restore all.
      const keptDown = lastOnly ? candidates.filter((c) => c.lastStop === "down") : [];
      if (opts.all) {
        selectedCandidates = [...candidates];
      } else if (opts.last) {
        selectedCandidates = candidates.filter((c) => c.lastStop !== "down");
        for (const c of candidates.filter((x) => x.lastStop === "unknown")) {
          const message = "selected for restore because its seat statuses could not be read";
          warnings.push({ softwareTeamId: c.softwareTeamId, softwareTeamName: c.softwareTeamName, code: "seat_status_unreadable", message });
          if (!opts.json) console.error(`  ${c.softwareTeamName}: ${message}`);
        }
        if (!opts.json) {
          for (const c of keptDown) console.log(`  ${c.softwareTeamName}: stopped on purpose (with SoftwareTeam down or SoftwareTeam seat stop), so --last leaves it down. Bring it back: ${restoreCommand(c)}`);
        }
      } else if (opts.softwareTeams) {
        selectedCandidates = candidates.filter((c) => opts.softwareTeams!.includes(c.softwareTeamName));
        const missing = opts.softwareTeams.filter((n) => !candidates.some((c) => c.softwareTeamName === n));
        if (missing.length > 0) {
          console.error(`SoftwareTeam(s) not found in candidate set: ${missing.join(", ")}`);
          console.error(`Available candidates: ${candidates.map((c) => c.softwareTeamName).join(", ")}`);
          process.exitCode = 1;
          return;
        }
      } else {
        // TTY interactive: offer fast default + picker
        const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
        if (!interactive) {
          console.error("No TTY available. Use --last, --all, or --software-teams <names> for headless mode.");
          if (opts.json) {
            console.log(JSON.stringify({ status: "started", candidates: candidates.map((c) => ({ softwareTeamName: c.softwareTeamName, lifecycleState: c.lifecycleState })), restoredSoftwareTeams: [] }));
          }
          process.exitCode = 1;
          return;
        }

        console.log(`\n${candidates.length} softwareTeam(s) were last running:\n`);
        for (const c of candidates) {
          const readiness = summarizeReadiness(c);
          const activity = c.lastActivity ? `last active ${c.lastActivity}` : "";
          console.log(`  ${c.softwareTeamName}  (${c.nodeCount} seats, ${c.lifecycleState}${activity ? ", " + activity : ""})  ${readiness}`);
        }
        console.log("");

        const ask = depsOverride?.promptYesNo ?? defaultPromptYesNo;
        const restoreAll = await ask(`Restore all ${candidates.length} softwareTeam(s)? [Y/pick] `);

        if (restoreAll) {
          selectedCandidates = [...candidates];
        } else {
          const pickedIds = await multiSelectPicker(
            candidates.map((c) => ({
              label: `${c.softwareTeamName}  (${c.nodeCount} seats, ${c.lifecycleState})  ${summarizeReadiness(c)}`,
              value: c.softwareTeamId,
              checked: true,
            })),
          );
          selectedCandidates = candidates.filter((c) => pickedIds.includes(c.softwareTeamId));
        }
      }

      if (selectedCandidates.length === 0) {
        if (!opts.json) console.log("No softwareTeams selected for restore.");
        else if (lastOnly) {
          console.log(JSON.stringify({
            status: previewErrors.length > 0 ? "started_with_errors" : "started",
            uiUrl,
            candidates: candidates.map((c) => ({ softwareTeamName: c.softwareTeamName, lifecycleState: c.lifecycleState })),
            keptDown: keptDown.map(keptDownEntry),
            restoredSoftwareTeams: [],
            previewErrors: previewErrors.length > 0 ? previewErrors : undefined,
          }));
        }
        if (lastOnly && previewErrors.length > 0) process.exitCode = 1;
        return;
      }

      // ---- PHASE 5: restore each selected softwareTeam via id-based route (compose slice-02 path) ----
      if (!opts.json) console.log(`\nRestoring ${selectedCandidates.length} softwareTeam(s)...\n`);

      const results: Array<{ softwareTeamName: string; status: string; nodes: Array<{ logicalId: string; status: string; error?: string }> }> = [];

      for (const candidate of selectedCandidates) {
        const softwareTeamName = candidate.softwareTeamName;
        const softwareTeamId = candidate.softwareTeamId;

        // Check if the softwareTeam is already running (idempotent rerun: reconcile, don't relaunch).
        try {
          const freshSummary = await client.get<SoftwareTeamSummary[]>("/api/software-teams/summary");
          const current = (freshSummary.data ?? []).find((r) => r.id === softwareTeamId);
          if ((current?.restoreLifecycleState ?? current?.lifecycleState) === "running") {
            if (!opts.json) console.log(`  ${softwareTeamName}: already running (skipping)`);
            results.push({ softwareTeamName, status: "already_running", nodes: [] });
            continue;
          }
        } catch { /* proceed with restore attempt */ }

        try {
          // Rev1 BLOCKING b4c6ada4: use id-based route for restore too (not
          // name-based /api/up which 409s on same-name softwareTeams).
          const res = await client.post<Record<string, unknown>>(
            `/api/software-teams/${encodeURIComponent(softwareTeamId)}/up`,
            { plan: false },
            { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS },
          );

          // Guard BLOCKING 25661f72: check HTTP status before treating the response
          // as a success. The daemon returns non-2xx JSON payloads (software_team_not_stopped,
          // pre_restore_validation_failed, ambiguous_name) without throwing.
          if (res.status >= 400) {
            const code = res.data["code"] as string | undefined;
            const errorText = String(res.data["error"] ?? "restore failed");
            if (code === "pre_restore_validation_failed") {
              console.error(`  ${softwareTeamName}: restore blocked (pre-validation failed)`);
              const blockers = (res.data["blockers"] as Array<{ message: string; remediation: string }>) ?? [];
              for (const b of blockers) {
                console.error(`    ${b.message}`);
                console.error(`      fix: ${b.remediation}`);
              }
            } else {
              console.error(`  ${softwareTeamName}: ${errorText} (${code ?? `HTTP ${res.status}`})`);
            }
            results.push({ softwareTeamName, status: code ?? "error", nodes: [] });
            continue;
          }

          const resStatus = res.data["status"] as string;
          const nodes = (res.data["nodes"] as Array<{ logicalId: string; status: string; error?: string }>) ?? [];
          const softwareTeamResult = res.data["softwareTeamResult"] as string | undefined;

          if (!opts.json) {
            console.log(`  ${softwareTeamName}: ${softwareTeamResult ?? resStatus}`);
            for (const n of nodes) {
              if (n.status === "awaiting-decision" && n.error) {
                console.log(`    ${n.logicalId}: awaiting-decision -- ${n.error}`);
              } else {
                console.log(`    ${n.logicalId}: ${n.status}`);
              }
            }
          }

          // Handle the awaiting-decision ASK (compose the slice-02 TTY flow).
          const awaiting = nodes.filter((n) => n.status === "awaiting-decision");
          if (awaiting.length > 0) {
            const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) || Boolean(depsOverride?.promptYesNo);
            if (interactive) {
              const ask = depsOverride?.promptYesNo ?? defaultPromptYesNo;
              const accepted: string[] = [];
              for (const n of awaiting) {
                const reason = n.error ?? "original session unresumable";
                const yes = await ask(`    Couldn't resume ${n.logicalId} (reason: ${reason}). Fresh-prime? [y/N] `);
                if (yes) accepted.push(n.logicalId);
              }
              if (accepted.length > 0) {
                try {
                  const freshRes = await client.post<Record<string, unknown>>(
                    `/api/software-teams/${encodeURIComponent(softwareTeamId)}/up`,
                    { plan: false, freshLogicalIds: accepted },
                    { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS },
                  );
                  if (freshRes.status >= 400) {
                    const freshError = String(freshRes.data["error"] ?? "fresh-prime failed");
                    console.error(`    Fresh-prime for ${softwareTeamName}: ${freshError} (HTTP ${freshRes.status})`);
                  } else {
                    const freshNodes = (freshRes.data["nodes"] as Array<{ logicalId: string; status: string }>) ?? [];
                    for (const fn of freshNodes.filter((fn) => accepted.includes(fn.logicalId))) {
                      if (!opts.json) console.log(`    ${fn.logicalId}: ${fn.status}`);
                    }
                  }
                } catch (err) {
                  if (err instanceof DaemonConnectionError) {
                    console.error(`    Fresh-prime timed out for ${softwareTeamName}; the daemon may still be processing. Verify with: SoftwareTeam ps`);
                  } else {
                    throw err;
                  }
                }
              } else if (!opts.json) {
                console.log(`    No fresh sessions started for ${softwareTeamName}.`);
              }
            } else {
              // Headless: report honestly, no auto-substitute.
              for (const n of awaiting) {
                if (!opts.json) console.error(`    ${n.logicalId}: awaiting-decision -- to fresh-prime: SoftwareTeam up --existing ${softwareTeamName} --fresh ${n.logicalId}`);
              }
            }
          }

          results.push({ softwareTeamName, status: softwareTeamResult ?? resStatus, nodes });
        } catch (err) {
          if (err instanceof DaemonConnectionError) {
            console.error(`  ${softwareTeamName}: timed out; the daemon may still be processing. Verify with: SoftwareTeam ps`);
            results.push({ softwareTeamName, status: "timeout", nodes: [] });
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  ${softwareTeamName}: ${msg}`);
            results.push({ softwareTeamName, status: "error", nodes: [] });
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({
          status: previewErrors.length > 0 ? "started_with_errors" : "started",
          uiUrl,
          candidates: candidates.map((c) => ({ softwareTeamName: c.softwareTeamName, lifecycleState: c.lifecycleState })),
          keptDown: lastOnly ? keptDown.map(keptDownEntry) : undefined,
          restoredSoftwareTeams: results,
          previewErrors: previewErrors.length > 0 ? previewErrors : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        }));
      }

      // Exit code: 1 if any softwareTeam has non-clean outcome. Include HTTP error codes
      // and non-clean softwareTeamResult values (partially_restored, failed, not_attempted).
      const NON_CLEAN_STATUSES = new Set(["timeout", "error", "skipped", "partially_restored", "failed", "not_attempted", "software_team_not_stopped", "ambiguous_name", "pre_restore_validation_failed"]);
      const hasFailure = previewErrors.length > 0 || results.some((r) =>
        NON_CLEAN_STATUSES.has(r.status) ||
        r.nodes.some((n) => n.status === "failed" || n.status === "awaiting-decision"),
      );
      if (hasFailure) process.exitCode = 1;
    });

  return cmd;
}

function restoreCommand(c: StartCandidate): string {
  return `SoftwareTeam start --software-teams ${c.softwareTeamName}`;
}

function keptDownEntry(c: StartCandidate): { softwareTeamName: string; restoreCommand: string } {
  return { softwareTeamName: c.softwareTeamName, restoreCommand: restoreCommand(c) };
}

function summarizeReadiness(c: StartCandidate): string {
  if (!c.preview) return "";
  const actions = c.preview.nodes.map((n) => n.intendedAction);
  if (actions.every((a) => a === "resume-original")) return "[ready to resume]";
  if (actions.some((a) => a === "awaiting-decision")) return "[will ask before fresh]";
  if (actions.every((a) => a === "fresh-primed")) return "[fresh start]";
  return "[mixed]";
}
