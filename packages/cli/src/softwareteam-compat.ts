import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const warnedKeys = new Set<string>();

/**
 * Sentinel file a QA/test fixture drops in its scratch SOFTWARETEAM_HOME to mark
 * the home as fixture-scoped. This is the preferred (most-honest) signal.
 */
export const FIXTURE_HOME_MARKER = ".softwareteam-fixture";

/**
 * OPR.0.4.3.12 — PATH-ONLY predicate: is `home` a fixture-scoped SoftwareTeam home?
 *
 * Recognizes a fixture home by EITHER an explicit sentinel marker file
 * (`.softwareteam-fixture`, preferred/most-honest) OR the temp-path QA convention
 * (an `softwareteam-qa*` home under a system temp root, e.g.
 * `SOFTWARETEAM_HOME=/tmp/softwareteam-qa-…-home`).
 *
 * Deliberately has NO ConfigStore dependency: `ConfigStore` imports this
 * module, so importing it here would create a cycle. Callers that need the
 * divergent-daemon-target confirmation (restore-check) compose this path
 * predicate with `ConfigStore.resolveWithSource` at the call site.
 */
export function isFixtureScopedHome(home: string): boolean {
  if (!home) return false;
  // 1. Explicit sentinel marker file in the home — the most honest signal.
  if (existsSync(join(home, FIXTURE_HOME_MARKER))) return true;
  // 2. Temp-path QA-fixture convention: an `softwareteam-qa*` home under a
  //    system temp root.
  const tempRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders"];
  const underTemp = tempRoots.some(
    (root) => home === root || home.startsWith(root.endsWith("/") ? root : `${root}/`),
  );
  return underTemp && /(^|\/)softwareteam-qa[^/]*/.test(home);
}

export function getSoftwareTeamHome(): string {
  return readSoftwareTeamEnv("SOFTWARETEAM_HOME") ?? join(homedir(), ".softwareteam");
}

export const SOFTWARETEAM_HOME = getSoftwareTeamHome();

export function readSoftwareTeamEnv(primary: string, _legacy?: string): string | undefined {
  const value = process.env[primary];
  return value === "" ? undefined : value;
}

export function getPreferredSoftwareTeamHome(): string {
  return getSoftwareTeamHome();
}

export function getDefaultSoftwareTeamPath(filename: string): string {
  return join(getSoftwareTeamHome(), filename);
}

export function getCompatibleSoftwareTeamPath(filename: string): string {
  return getDefaultSoftwareTeamPath(filename);
}
