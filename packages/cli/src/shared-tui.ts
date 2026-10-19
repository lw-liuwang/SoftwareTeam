import { spawn } from "node:child_process";
import { DaemonClient } from "./client.js";

interface SharedTuiClient {
  readonly baseUrl?: string;
  get<T>(path: string): Promise<{ status: number; data: T }>;
}

/** Resolve the terminal on the selected instance, not a remembered tmux name. */
export async function sharedTuiTarget(client: SharedTuiClient = new DaemonClient()): Promise<string> {
  if (client.baseUrl && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname)) {
    throw new Error("Shared attachment uses local tmux. Run SoftwareTeam tui --shared on the selected daemon's machine; standalone SoftwareTeam tui can use this remote connection.");
  }
  const softwareTeams = await client.get<Array<{ softwareTeamId: string; softwareTeamName?: string; name?: string }>>("/api/ps");
  if (softwareTeams.status >= 400) throw new Error(`Cannot read softwareTeams (HTTP ${softwareTeams.status}); run SoftwareTeam status.`);
  const kernels = softwareTeams.data.filter((r) => (r.softwareTeamName ?? r.name) === "kernel");
  if (kernels.length > 1) throw new Error("Multiple kernels are registered. Inspect SoftwareTeam ps and reconcile the intended binding before shared attachment.");
  const kernel = kernels[0];
  if (!kernel) throw new Error("No kernel is registered on this instance. Run SoftwareTeam status; complete runtime authentication before starting the daemon. Standalone: SoftwareTeam tui.");
  const nodes = await client.get<Array<{
    logicalId: string; runtime: string | null;
    canonicalSessionName: string | null; tmuxAttachCommand: string | null;
  }>>(`/api/software-teams/${encodeURIComponent(kernel.softwareTeamId)}/nodes`);
  if (nodes.status >= 400) throw new Error(`Cannot read kernel terminals (HTTP ${nodes.status}); run SoftwareTeam status.`);
  const terminal = nodes.data.find((n) => n.logicalId === "operator.human" && n.runtime === "terminal");
  if (!terminal?.canonicalSessionName || !terminal.tmuxAttachCommand) {
    throw new Error("The kernel has no bound shared terminal. Inspect SoftwareTeam ps --nodes --software-team kernel; restore the existing terminal rather than launching another kernel. Standalone: SoftwareTeam tui.");
  }
  return terminal.canonicalSessionName;
}

export async function attachSharedTui(target: string): Promise<number> {
  // Attach a new client even inside tmux. switch-client would retarget somebody
  // else's client when invoked from an agent's child shell.
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TMUX;
    const child = spawn("tmux", ["attach-session", "-t", `=${target}`], { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
