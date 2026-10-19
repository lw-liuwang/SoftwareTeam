import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

interface GraphData {
  nodes: unknown[];
  edges: unknown[];
}

async function fetchGraph(softwareTeamId: string, hostId: string): Promise<GraphData> {
  // OPR.0.4.6.MH2 FR-2 — selected-host envelope; origin shape verbatim;
  // local path unchanged (withHostParam is identity for local).
  const res = await fetch(withHostParam(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/graph`, hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useSoftwareTeamGraph(softwareTeamId: string) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["softwareTeam", softwareTeamId, "graph", hostId],
    queryFn: () => fetchGraph(softwareTeamId, hostId),
    enabled: !!softwareTeamId,
    refetchInterval: 30_000, // Refetch every 30s for context usage updates
    placeholderData: keepPreviousData,
  });
}
