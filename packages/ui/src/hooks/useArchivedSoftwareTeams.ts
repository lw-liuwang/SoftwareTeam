import { useQuery } from "@tanstack/react-query";
import type { SoftwareTeamSummary } from "./useSoftwareTeamSummary.js";

// OPR.0.3.3.19 - archived-only softwareTeam summaries for the explorer's "Archive"
// section. This is a SEPARATE query from useSoftwareTeamSummary (the default view) so
// the default tree/graph/table stay active-only; we do NOT client-filter the
// all-softwareTeams list (multiple surfaces share useSoftwareTeamSummary). Mirrors the shipped
// stream-items archived precedent: a dedicated archived-only read.
async function fetchArchived(): Promise<SoftwareTeamSummary[]> {
  const res = await fetch("/api/software-teams/summary?archived=only");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetches ONLY archived softwareTeams. `enabled` lets the caller keep the fan-out lazy
 * (e.g. fetch only once the Archive section is expanded) so a collapsed
 * archive costs nothing.
 */
export function useArchivedSoftwareTeams(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["softwareTeams", "summary", "archived"],
    queryFn: fetchArchived,
    enabled: options?.enabled ?? true,
  });
}
