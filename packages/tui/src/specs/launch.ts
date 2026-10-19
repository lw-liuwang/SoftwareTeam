import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { CopyTerminal } from "../print-for-copy.js";
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, MOUSE_DISABLE, MOUSE_ENABLE, PASTE_DISABLE, PASTE_ENABLE } from "../input.js";

export interface SpecLaunch { source: string; folder: string; host: string }

export function launchArgs(launch: SpecLaunch): string[] {
  if (!launch.folder || !isAbsolute(launch.folder)) throw new Error("Choose an absolute working folder with launch-folder /path first.");
  // Name-form input deliberately retains SoftwareTeam up's library/existing-softwareTeam collision handling.
  // No --yes, --existing, fresh, provider adaptation or retry is introduced here.
  return ["up", "--cwd", launch.folder, ...(launch.host && launch.host !== "local" ? ["--host", launch.host] : []), "--", launch.source];
}

export function launchCommand(launch: SpecLaunch): string {
  return (launch.host === "local" ? "SOFTWARETEAM_HOST_SELECTED=local " : "") + ["softwareTeam", ...launchArgs(launch)].map(s => /^[\w/.:=-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`).join(" ");
}

export interface LaunchProcess { executable: string; args: string[]; env: NodeJS.ProcessEnv }
export function launchProcess(launch: SpecLaunch, endpoint: string, env: NodeJS.ProcessEnv, executable: string, prefix: string[] = []): LaunchProcess {
  return { executable, args: [...prefix, ...launchArgs(launch)], env: { ...env, SOFTWARETEAM_URL: endpoint,
    ...(launch.host === "local" ? { SOFTWARETEAM_HOST_SELECTED: "local" } : {}) } };
}

export function spawnLaunch(command: LaunchProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { env: command.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", resolve);
  });
}

/** Give SoftwareTeam up the real terminal, including its own prompts and partial/collision output.
 * Wait before restoring the TUI so its result is not erased or translated into a success claim. */
export async function runSpecLaunch(d: {
  command: LaunchProcess; terminal: CopyTerminal; run?: typeof spawnLaunch;
  pauseInput(): void; resumeInput(): void; setSuspended(on: boolean): void;
  isShuttingDown(): boolean; notice(message: string): void; draw(): void;
}): Promise<void> {
  d.setSuspended(true);
  let result = "SoftwareTeam up outcome unknown; inspect SoftwareTeam ps before retrying.";
  try {
    d.terminal.setRawMode(false);
    d.terminal.write(PASTE_DISABLE + MOUSE_DISABLE + ALT_SCREEN_OFF);
    d.pauseInput();
    try {
      const code = await (d.run ?? spawnLaunch)(d.command);
      result = code === null ? "SoftwareTeam up ended by signal; inspect SoftwareTeam ps before retrying." : `SoftwareTeam up exited ${code}. Read its result above, including any partial launch or attention required.`;
    } catch (err) {
      result = `SoftwareTeam up: ${err instanceof Error ? err.message : String(err)}. Inspect SoftwareTeam ps before retrying.`;
    } finally { d.resumeInput(); }
    d.terminal.write(`\r\n${result}\r\nPress Enter to return to SoftwareTeam.\r\n`);
    await d.terminal.waitForEnter();
  } finally {
    if (!d.isShuttingDown()) {
      try { d.terminal.setRawMode(true); } catch { /* terminal may have closed */ }
      try { d.terminal.write(ALT_SCREEN_ON + MOUSE_ENABLE + PASTE_ENABLE); } catch { /* output may have closed */ }
    }
    d.setSuspended(false);
    d.notice(result);
    if (!d.isShuttingDown()) d.draw();
  }
}
