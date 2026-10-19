import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

/** Resolve a path for comparison, following symlinks on the part that exists. */
function canonical(p: string): string {
  const resolved = nodePath.resolve(p);
  const tail: string[] = [];
  let probe = resolved;
  for (;;) {
    try {
      return nodePath.join(fs.realpathSync.native(probe), ...tail);
    } catch {
      const parent = nodePath.dirname(probe);
      if (parent === probe) return resolved;
      tail.unshift(nodePath.basename(probe));
      probe = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = nodePath.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel));
}

/**
 * An advisory when SOFTWARETEAM_HOME is isolated but HOME or CODEX_HOME still resolve to somewhere else.
 *
 * "Isolated" means SOFTWARETEAM_HOME is not `<account home>/.softwareteam`, where the account home is the user's
 * passwd home, which a scratch HOME variable doesn't change. The isolation root is whichever of HOME and
 * SOFTWARETEAM_HOME contains the other (a scratch HOME carrying its own `.softwareteam`, or a HOME nested inside
 * SOFTWARETEAM_HOME), except that the account's own home is never a root. HOME is a leak when neither contains
 * the other, or when it is the account home (SOFTWARETEAM_HOME=~/.softwareteam-dev with the real HOME);
 * a root that contains the account home (SOFTWARETEAM_HOME=<account home>, or HOME=/) isn't isolated at all; CODEX_HOME (explicit, or `<HOME>/.codex`) is a leak
 * when it is outside the root. Returns undefined for the default layout and for consistent isolation.
 */
export function homeIsolationAdvisory(input: { softwareteamHome: string; home: string; codexHome?: string; accountHome?: string }): string | undefined {
  const softwareteamHome = canonical(input.softwareteamHome);
  const home = canonical(input.home);
  let accountHome = input.accountHome;
  if (!accountHome) {
    try { accountHome = os.userInfo().homedir; } catch { return undefined; }
  }
  if (softwareteamHome === nodePath.join(canonical(accountHome), ".softwareteam")) return undefined;

  // The account's own home is never an isolation root, even when it contains SOFTWARETEAM_HOME.
  const homeIsAccount = home === canonical(accountHome);
  const homeContainsSoftwareTeam = !homeIsAccount && isInside(softwareteamHome, home);
  const softwareTeamContainsHome = isInside(home, softwareteamHome);
  const homeInside = homeContainsSoftwareTeam || softwareTeamContainsHome;
  const root = homeContainsSoftwareTeam ? home : softwareteamHome;
  if (isInside(canonical(accountHome), root)) {
    return `[softwareteam] home isolation advisory: SOFTWARETEAM_HOME=${input.softwareteamHome} is not the default location, `
      + `but the isolated root ${root} contains the real home ${accountHome}, so nothing inside it is isolated. `
      + `Point SOFTWARETEAM_HOME, HOME and CODEX_HOME at a directory that does not contain the real home, or unset SOFTWARETEAM_HOME. Starting anyway.`;
  }
  const codexHome = canonical(input.codexHome || nodePath.join(input.home, ".codex"));
  const leaks: string[] = [];
  if (!homeInside) leaks.push(`HOME=${input.home}`);
  if (!isInside(codexHome, root)) leaks.push(`CODEX_HOME=${input.codexHome || `${nodePath.join(input.home, ".codex")} (derived from HOME)`}`);
  if (leaks.length === 0) return undefined;
  return `[softwareteam] home isolation advisory: SOFTWARETEAM_HOME=${input.softwareteamHome} is not the default location, `
    + `but ${leaks.join(" and ")} resolve${leaks.length === 1 ? "s" : ""} outside it. `
    + `A seat or startup step run by this daemon can read or write outside the isolated home. `
    + `Point HOME and CODEX_HOME inside the isolated home, or unset SOFTWARETEAM_HOME. Starting anyway.`;
}
