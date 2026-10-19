import { homedir } from "node:os";
import { join } from "node:path";

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
