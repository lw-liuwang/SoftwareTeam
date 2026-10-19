import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface ArchiveResult {
  ok: boolean;
  softwareTeamId: string;
  archived?: boolean;
}

interface ThreePartErrorBody {
  error:
    | { fact: string; consequence: string; action: string }
    | string;
}

/**
 * `softwareTeam archive <softwareTeamId>` - OPR.0.3.3.19. Soft, REVERSIBLE archive: hides a softwareTeam
 * from the default explorer + `SoftwareTeam ps`, while RETAINING the softwareTeams row, topology,
 * and snapshots. This is NOT `SoftwareTeam down --delete` (which is destructive). Reverse
 * with `softwareTeam unarchive <softwareTeamId>`. Running/degraded softwareTeams require `--force`.
 */
export function archiveCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("archive").description(
    "Archive a softwareTeam (soft + reversible: hides it from the default view, retains all data). NOT a delete; reverse with 'SoftwareTeam unarchive'.",
  );
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<softwareTeamId>", "SoftwareTeam identifier to archive")
    .option("--force", "Archive even if the SoftwareTeam is running or degraded")
    .option("--json", "JSON output for agents")
    .action(async (softwareTeamId: string, opts: { force?: boolean; json?: boolean }) => {
      const deps = getDepsF();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<ArchiveResult | ThreePartErrorBody>(
        `/api/software-teams/${encodeURIComponent(softwareTeamId)}/archive`,
        { force: opts.force ?? false },
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status === 409 ? 2 : 1;
        return;
      }

      if (res.status === 404) {
        console.error(`SoftwareTeam not found: ${softwareTeamId}. Check the id with: SoftwareTeam ps`);
        process.exitCode = 1;
        return;
      }
      // AC-6: running/degraded without --force returns a 3-part honest error.
      if (res.status === 409) {
        const err = (res.data as ThreePartErrorBody).error;
        if (err && typeof err === "object") {
          process.stderr.write(`Error: ${err.fact}\n${err.consequence}\n${err.action}\n`);
        } else {
          process.stderr.write(`Error: ${String(err)}\n`);
        }
        process.exitCode = 2;
        return;
      }
      if (res.status >= 400) {
        console.error(`Archive failed (HTTP ${res.status}).`);
        process.exitCode = 2;
        return;
      }

      const r = res.data as ArchiveResult;
      if (r.archived) {
        console.log(`SoftwareTeam ${softwareTeamId} archived (reversible). It is hidden from the default view.`);
        console.log(`  See it with:   SoftwareTeam ps --include-archived`);
        console.log(`  Bring it back: SoftwareTeam unarchive ${softwareTeamId}`);
      } else {
        console.log(`SoftwareTeam ${softwareTeamId} was already archived.`);
      }
    });

  return cmd;
}
