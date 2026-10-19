export interface DemoSoftwareTeamSummaryLike {
  softwareTeamId: string;
  name: string;
  status?: string;
}

export interface DemoNodeLike {
  softwareTeamId: string;
}

export function selectCurrentSoftwareTeamSummary<T extends DemoSoftwareTeamSummaryLike>(
  softwareTeams: T[],
  softwareTeamName: string
): T | null {
  const matches = softwareTeams.filter((entry) => entry.name === softwareTeamName);
  if (matches.length === 0) {
    return null;
  }
  const runningMatches = matches.filter((entry) => entry.status === "running");
  if (runningMatches.length === 1) {
    return runningMatches[0] ?? null;
  }
  if (runningMatches.length > 1) {
    throw new Error(
      `SoftwareTeam '${softwareTeamName}' is ambiguous — ${runningMatches.length} running softwareTeams share that name.`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `SoftwareTeam '${softwareTeamName}' is ambiguous — ${matches.length} stopped softwareTeams share that name and none are running.`
    );
  }
  return matches[0] ?? null;
}

export function filterNodesForSoftwareTeamId<T extends DemoNodeLike>(
  nodes: T[],
  softwareTeamId: string
): T[] {
  return nodes.filter((entry) => entry.softwareTeamId === softwareTeamId);
}
