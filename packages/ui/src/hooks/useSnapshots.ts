import { useQuery } from "@tanstack/react-query";

export interface Snapshot {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
}

async function fetchSnapshots(softwareTeamId: string): Promise<Snapshot[]> {
  const res = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/snapshots`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useSnapshots(softwareTeamId: string) {
  return useQuery({
    queryKey: ["softwareTeam", softwareTeamId, "snapshots"],
    queryFn: () => fetchSnapshots(softwareTeamId),
    enabled: !!softwareTeamId,
  });
}
