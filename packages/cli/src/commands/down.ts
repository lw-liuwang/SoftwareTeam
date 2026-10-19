import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { resolveSoftwareTeamHandle } from "../software-team-handle.js";
import { shellQuote } from "../cross-host-executor.js";

interface TeardownResult {
  softwareTeamId: string;
  sessionsKilled: number;
  snapshotId: string | null;
  deleted: boolean;
  deleteBlocked: boolean;
  alreadyStopped: boolean;
  errors: string[];
}

interface DownAgentEntry {
  nodeKind: string;
  logicalId: string;
  canonicalSessionName?: string | null;
  sessionStatus: string | null;
  activityState?: { display?: string } | null;
  agentActivity?: { state?: string };
}

/** Best-effort facts from the ordinary inventory, before teardown changes it. */
async function showAgentsBeforeDown(softwareTeamId: string, readInventory: () => Promise<unknown>): Promise<void> {
  let facts = "agent sessions unknown; work status unknown";
  try {
    const inventory = await readInventory();
    if (Array.isArray(inventory) && inventory.every(n => n && typeof n.nodeKind === "string"
      && typeof n.logicalId === "string" && (n.sessionStatus === null || typeof n.sessionStatus === "string"))) {
      const agents = (inventory as DownAgentEntry[]).filter(n => n.nodeKind === "agent"
        && ["running", "idle", "unknown"].includes(n.sessionStatus ?? ""));
      facts = agents.length === 0 ? "no agent sessions reported live" : "recorded agent sessions: " + agents.map(n => {
        // A running process or an assigned queue row does not prove work in progress.
        // Prefer the daemon's arbitrated activity; older daemons expose agentActivity.
        const activity = n.activityState
          ? n.activityState.display
          : n.agentActivity?.state === "running" ? "working"
          : n.agentActivity?.state === "idle" ? "idle"
          : n.agentActivity?.state === "needs_input" ? "needs-input" : "unknown";
        const work = ["working", "idle", "needs-input"].includes(activity ?? "") ? activity : "unknown";
        return `${n.canonicalSessionName || n.logicalId} (activity: ${work})`;
      }).join(", ");
    }
  } catch { /* Unavailable inventory is an unknown fact, never a teardown gate. */ }
  console.error(`Before stopping ${softwareTeamId}: ${facts}.`);
}

const LONG_RUNNING_TIMEOUT_MS = 45_000;

/**
 * `SoftwareTeam down <softwareTeam>` - tear down a softwareTeam by name or id.
 * @param depsOverride - injectable deps for testing
 * @returns Commander command
 */
export function downCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("down").description("Tear down a softwareTeam")
    .addHelpText("after", `
SoftwareTeam down stops every agent in the softwareTeam: their sessions end, and any work in progress stops with them.
Before running it, check who is working (SoftwareTeam ps --nodes --software-team <softwareTeam>) and that the person asked for it;
don't stop a team you didn't start unless asked. SoftwareTeam snapshots the SoftwareTeam first (best-effort), and
SoftwareTeam up <softwareTeam> --existing brings it back, resuming each seat's conversation where its harness allows. With
--delete the SoftwareTeam record is removed too, so it can't be brought back that way.`);
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<softwareTeam>", "SoftwareTeam name or id to tear down")
    .option("--delete", "Delete SoftwareTeam record after stopping")
    .option("--force", "Kill sessions immediately")
    .option("--snapshot", "Take snapshot before teardown")
    .option("--json", "JSON output for agents")
    .option("--host <id>", "Run on a remote host declared in ~/.softwareteam/hosts.yaml")
    .action(async (softwareTeamHandle: string, opts: { delete?: boolean; force?: boolean; snapshot?: boolean; json?: boolean; host?: string }) => {
      // OPR.0.4.6.MH1 FR-2: selected-host routing — explicit --host wins;
      // else the persisted selection feeds the SHIPPED --host path; no
      // selection = today exactly.
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDepsF();

      if (opts.host) {
        const { runRemoteHttpOp, resolveRemoteSoftwareTeamId } = await import("../remote-host-ops.js");
        const softwareTeamIdResult = await resolveRemoteSoftwareTeamId(opts.host, softwareTeamHandle, deps);
        if (!softwareTeamIdResult.ok) {
          if (opts.json) console.log(JSON.stringify(softwareTeamIdResult));
          else console.error(`Error: ${softwareTeamIdResult.error}`);
          process.exitCode = 1;
          return;
        }
        if (!opts.json) {
          await showAgentsBeforeDown(softwareTeamIdResult.softwareTeamId, async () => {
            const inventory = await runRemoteHttpOp(opts.host!, "GET", `/api/software-teams/${encodeURIComponent(softwareTeamIdResult.softwareTeamId)}/nodes`, undefined, deps, { timeoutMs: 2_000 });
            return inventory.ok ? inventory.data : undefined;
          });
        }
        const result = await runRemoteHttpOp(opts.host, "POST", `/api/down`, { softwareTeamId: softwareTeamIdResult.softwareTeamId, delete: opts.delete, force: opts.force, snapshot: opts.snapshot }, deps, opts);
        if (opts.json) {
          console.log(JSON.stringify(result));
          if (!result.ok) process.exitCode = 1;
        } else if (result.ok) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          console.error(`Error on host ${opts.host}: ${result.error}`);
          process.exitCode = 1;
        }
        if (result.ok) {
          const teardown = result.data as Partial<TeardownResult> | undefined;
          if (teardown?.errors && teardown.errors.length > 0) process.exitCode = 2;
        }
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // Resolve the handle (name OR id) to a concrete id BEFORE the teardown POST.
      // Ambiguous/not-found halt here and never reach `/api/down` - for a
      // destructive op, ambiguity must stop, never guess (AC-3 load-bearing).
      const resolution = await resolveSoftwareTeamHandle(client, softwareTeamHandle);

      if (resolution.kind === "ambiguous") {
        const fact = `'${resolution.name}' matches ${resolution.ids.length} softwareTeams.`;
        const consequence = "Refusing to tear down: an ambiguous name could destroy the wrong softwareTeam.";
        const action = `Re-run with the specific id, e.g. ${resolution.ids.map((id) => `SoftwareTeam down ${id}`).join("  |  ")}`;
        if (opts.json) {
          console.log(JSON.stringify({ error: { fact, consequence, action, candidates: resolution.ids } }));
        } else {
          console.error(`Error: ${fact}`);
          console.error(`  ${consequence}`);
          console.error(`  ${action}`);
        }
        process.exitCode = 2;
        return;
      }

      if (resolution.kind === "not_found") {
        const fact = `No SoftwareTeam found matching '${resolution.handle}'.`;
        const consequence = "Nothing was torn down.";
        const action = "List softwareTeams with: SoftwareTeam ps";
        if (opts.json) {
          console.log(JSON.stringify({ error: { fact, consequence, action } }));
        } else {
          console.error(`Error: ${fact}`);
          console.error(`  ${consequence}`);
          console.error(`  ${action}`);
        }
        process.exitCode = 2;
        return;
      }

      // resolved -> the looked-up id; passthrough -> the raw handle (summary
      // unavailable; daemon resolves by exact id, 404s if absent). Either way
      // the SAME existing teardown path + guards run below - no forked path.
      const softwareTeamId = resolution.kind === "resolved" ? resolution.id : resolution.handle;

      if (!opts.json) {
        await showAgentsBeforeDown(softwareTeamId, async () => {
          const inventory = await client.get<unknown>(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/nodes`, { timeoutMs: 2_000 });
          return inventory.status === 200 ? inventory.data : undefined;
        });
      }

      const res = await client.post<TeardownResult | { error: string }>("/api/down", {
        softwareTeamId,
        delete: opts.delete ?? false,
        force: opts.force ?? false,
        snapshot: opts.snapshot ?? false,
      }, { timeoutMs: LONG_RUNNING_TIMEOUT_MS });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) {
          process.exitCode = 2;
        } else {
          const r = res.data as TeardownResult;
          if (r.errors && r.errors.length > 0) process.exitCode = 2;
          else if (r.alreadyStopped && !r.deleted) process.exitCode = 1;
        }
        return;
      }

      // HTTP error
      if (res.status >= 400) {
        const errMsg = (res.data as { error: string }).error ?? "unknown error";
        console.error(`Down failed: ${errMsg} (HTTP ${res.status}). Check softwareTeam ID with: SoftwareTeam ps`);
        process.exitCode = 2;
        return;
      }

      const result = res.data as TeardownResult;

      // Exit code: errors first, then deleted, then alreadyStopped
      if (result.errors.length > 0) {
        console.log(`SoftwareTeam ${softwareTeamId}: ${result.sessionsKilled} session(s) killed`);
        if (result.deleted) console.log("SoftwareTeam deleted");
        if (result.snapshotId) console.log(`Snapshot: ${result.snapshotId}`);
        for (const e of result.errors) console.error(`  warning: ${e}`);
        process.exitCode = 2;
        return;
      }

      if (result.deleted) {
        console.log(`SoftwareTeam ${softwareTeamId} deleted. ${result.sessionsKilled} session(s) killed.`);
        if (result.snapshotId) console.log(`Snapshot: ${result.snapshotId}`);
        return;
      }

      if (result.alreadyStopped) {
        console.log(`SoftwareTeam ${softwareTeamId} already stopped`);
        process.exitCode = 1;
        return;
      }

      // Clean stop with post-command handoff
      console.log(`SoftwareTeam ${softwareTeamId} stopped. ${result.sessionsKilled} session(s) killed.`);
      if (result.snapshotId) {
        console.log(`Snapshot: ${result.snapshotId}`);
        // Post-command handoff: how to restore (check for duplicate names)
        const softwareTeamName = (res.data as Record<string, unknown>)["softwareTeamName"] as string | undefined;
        const isUniqueName = (res.data as Record<string, unknown>)["isUniqueName"] as boolean | undefined;
        if (softwareTeamName && isUniqueName !== false) {
          console.log(`To restore: SoftwareTeam up ${shellQuote(softwareTeamName)} --existing`);
        } else {
          console.log(`To restore: SoftwareTeam restore ${result.snapshotId} --software-team ${softwareTeamId}`);
        }
      }
    });

  return cmd;
}
