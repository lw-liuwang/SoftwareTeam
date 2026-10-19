import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface UnarchiveResult {
  ok: boolean;
  softwareTeamId: string;
  unarchived?: boolean;
}

/**
 * `softwareTeam unarchive <softwareTeamId>` - OPR.0.3.3.19. Reverse of `softwareTeam archive`: clears the
 * `archived_at` flag so the softwareTeam returns to the default explorer + `SoftwareTeam ps` view.
 * Always non-destructive (the row and snapshots were retained while archived);
 * no `--force` and no running-softwareTeam guard - unarchiving only makes a softwareTeam visible.
 */
export function unarchiveCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("unarchive").description(
    "Unarchive a softwareTeam (reverse of 'SoftwareTeam archive'): returns it to the default view. Always safe.",
  );
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<softwareTeamId>", "SoftwareTeam identifier to unarchive")
    .option("--json", "JSON output for agents")
    .action(async (softwareTeamId: string, opts: { json?: boolean }) => {
      const deps = getDepsF();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<UnarchiveResult | { error: string }>(
        `/api/software-teams/${encodeURIComponent(softwareTeamId)}/unarchive`,
        {},
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status === 404) {
        console.error(`SoftwareTeam not found: ${softwareTeamId}. List archived softwareTeams with: SoftwareTeam ps --include-archived`);
        process.exitCode = 1;
        return;
      }
      if (res.status >= 400) {
        console.error(`Unarchive failed (HTTP ${res.status}).`);
        process.exitCode = 2;
        return;
      }

      const r = res.data as UnarchiveResult;
      if (r.unarchived) {
        console.log(`SoftwareTeam ${softwareTeamId} unarchived. It is back in the default view.`);
      } else {
        console.log(`SoftwareTeam ${softwareTeamId} was not archived.`);
      }
    });

  return cmd;
}
