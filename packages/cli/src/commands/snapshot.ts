import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function snapshotCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("snapshot").description("Manage SoftwareTeam snapshots");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  // SoftwareTeam snapshot <softwareTeamId> — default action creates a snapshot
  cmd
    .argument("<softwareTeamId>", "SoftwareTeam ID to snapshot")
    .option("--intended-seats <ids>", "Comma-separated intended topology roster stored with the snapshot")
    .action(async (softwareTeamId: string, opts: { intendedSeats?: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const intendedSeats = opts.intendedSeats?.split(",").map((seat) => seat.trim()).filter(Boolean);
      const res = await client.post<{ id: string }>(
        `/api/software-teams/${encodeURIComponent(softwareTeamId)}/snapshots`,
        intendedSeats ? { intendedSeats } : undefined,
      );
      if (res.status === 404) {
        console.error(`SoftwareTeam '${softwareTeamId}' not found`);
        process.exitCode = 1;
      } else if (res.status >= 400) {
        console.error(`Snapshot failed: ${(res.data as { error?: string }).error ?? "unknown error"}`);
        process.exitCode = 1;
      } else {
        console.log(`Snapshot created: ${res.data.id}`);
        console.log(`To restore: SoftwareTeam restore ${res.data.id} --software-team ${softwareTeamId}`);
      }
    });

  // SoftwareTeam snapshot list <softwareTeamId>
  cmd
    .command("list <softwareTeamId>")
    .description("List snapshots for a softwareTeam")
    .action(async (softwareTeamId: string) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.get<Array<{ id: string; kind: string; status: string; createdAt: string }>>(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/snapshots`);
      if (res.status >= 400) {
        console.error(`Failed to list snapshots: ${(res.data as { error?: string }).error ?? "unknown error"}`);
        process.exitCode = 1;
        return;
      }

      const snapshots = res.data;
      if (snapshots.length === 0) {
        console.log("No snapshots");
        return;
      }

      console.log("ID                         Kind    Status    Created");
      for (const snap of snapshots) {
        console.log(`${snap.id.padEnd(27)} ${snap.kind.padEnd(8)} ${snap.status.padEnd(10)} ${snap.createdAt}`);
      }
    });

  return cmd;
}
