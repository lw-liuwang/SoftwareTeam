import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_TIMEOUT_MS = 45_000;

export function envCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("env")
    .description("Inspect and control SoftwareTeam environment services for service-backed softwareTeams and managed apps")
    .addHelpText("after", `
Examples:
  SoftwareTeam env status secrets-manager
  SoftwareTeam env logs secrets-manager vault
  SoftwareTeam env down secrets-manager
`);
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  async function resolveSoftwareTeamId(client: DaemonClient, softwareTeamRef: string): Promise<string> {
    const summaries = await client.get<Array<{ id: string; name: string }> | { error?: string }>("/api/software-teams/summary");
    if (summaries.status >= 400) {
      const error = !Array.isArray(summaries.data) ? summaries.data?.error : undefined;
      throw new Error(error ?? `Failed to list softwareTeams (HTTP ${summaries.status})`);
    }
    if (!Array.isArray(summaries.data)) throw new Error("The daemon returned an invalid SoftwareTeam summary.");
    const match = summaries.data.find((r) => r.name === softwareTeamRef || r.id === softwareTeamRef);
    if (!match) throw new Error(`SoftwareTeam '${softwareTeamRef}' not found`);
    return match.id;
  }

  // softwareTeam env status <softwareTeam>
  cmd
    .command("status")
    .argument("<softwareTeam>", "SoftwareTeam name or ID")
    .option("--json", "JSON output")
    .action(async (softwareTeam: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let softwareTeamId: string;
      try { softwareTeamId = await resolveSoftwareTeamId(client, softwareTeam); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const res = await client.get<Record<string, unknown>>(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/env`);

      if (res.status >= 400) {
        if (opts.json) console.log(JSON.stringify(res.data, null, 2));
        else console.error(res.data?.["error"] ?? `Failed to get service status (HTTP ${res.status})`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      if (!res.data["hasServices"]) {
        console.log("No services configured for this softwareTeam.");
        return;
      }

      const receipt = res.data["receipt"] as Record<string, unknown> | null;
      const probeStatus = res.data["probeStatus"];
      if (probeStatus === "stale" || probeStatus === "no_orchestrator") {
        const probeError = res.data["probeError"];
        console.error(`Service status is ${probeStatus === "stale" ? "stale" : "unverified"} (probe: ${probeStatus}); ${receipt ? "showing the saved receipt" : "no saved receipt is available"}.${typeof probeError === "string" && probeError ? ` ${probeError}` : ""}`);
      }

      if (!receipt) {
        console.log("Services configured but no receipt available yet.");
        return;
      }

      console.log(`Env: ${res.data["kind"]} (${res.data["projectName"]})`);
      const services = receipt["services"] as Array<{ name: string; status: string; health?: string | null }>;
      if (services) {
        for (const svc of services) {
          const health = svc.health ? ` (${svc.health})` : "";
          console.log(`  ${svc.name}: ${svc.status}${health}`);
        }
      }
    });

  // softwareTeam env logs <softwareTeam> [service]
  cmd
    .command("logs")
    .argument("<softwareTeam>", "SoftwareTeam name or ID")
    .argument("[service]", "Specific service name")
    .option("--tail <n>", "Number of lines", "100")
    .action(async (softwareTeam: string, service: string | undefined, opts: { tail: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let softwareTeamId: string;
      try { softwareTeamId = await resolveSoftwareTeamId(client, softwareTeam); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const params = new URLSearchParams({ tail: opts.tail });
      if (service) params.set("service", service);

      const res = await client.get<{ ok: boolean; output?: string; error?: string }>(
        `/api/software-teams/${encodeURIComponent(softwareTeamId)}/env/logs?${params}`,
      );

      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `Failed to get logs (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(res.data.output ?? "");
    });

  // softwareTeam env down <softwareTeam> [--volumes]
  cmd
    .command("down")
    .argument("<softwareTeam>", "SoftwareTeam name or ID")
    .option("--volumes", "Also remove volumes")
    .action(async (softwareTeam: string, opts: { volumes?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let softwareTeamId: string;
      try { softwareTeamId = await resolveSoftwareTeamId(client, softwareTeam); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const res = await client.post<{ ok: boolean; error?: string; kept?: string }>(
        `/api/software-teams/${encodeURIComponent(softwareTeamId)}/env/down`,
        { volumes: opts.volumes ?? false },
        { timeoutMs: LONG_RUNNING_TIMEOUT_MS },
      );

      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `Failed to stop services (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(res.data.kept ?? `Services stopped for ${softwareTeam}.`);
    });

  return cmd;
}
