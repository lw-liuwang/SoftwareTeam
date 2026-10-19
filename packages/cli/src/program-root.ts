import type { Command } from "commander";
import { CLI_VERSION } from "./version.js";

/** The root `softwareTeam` command's own name, description, version and help text, shared by the full
 *  program (index.ts) and the one-command program the binary builds (lazy-program.ts). */
export function configureRoot(program: Command): Command {
  return program
    .name("SoftwareTeam")
    .description("CLI for the SoftwareTeam local control plane")
    .version(CLI_VERSION)
    .addHelpText("after", "\nThe SoftwareTeam TUI and operator (after install, and whenever the person wants their agents):\n  SoftwareTeam terminal open saved:kernel --window\n  Opens a new desktop terminal itself: TUI | advisor | operator.\n  An installing agent can run this from its shell on the daemon's desktop.\n  Start a stopped daemon with SoftwareTeam daemon start.\n  Herdr needs a terminal the person can see; TUI navigation does not open one.\n  Over headless SSH, give the exact connection/attach command for a new terminal/tab.\n  Only if the window cannot open: SoftwareTeam tui --shared is the dashboard-only fallback.\n");
}
