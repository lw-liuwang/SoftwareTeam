import { useQuery } from "@tanstack/react-query";

export interface SoftwareTeamEnvData {
  ok: boolean;
  hasServices: boolean;
  kind?: "compose";
  composeFile?: string;
  projectName?: string;
  receipt?: {
    kind: "compose";
    composeFile: string;
    projectName: string;
    services: Array<{ name: string; status: string; health?: string | null }>;
    waitFor: Array<{ target: Record<string, unknown>; status: string; detail?: string | null }>;
    capturedAt: string;
  };
  surfaces?: {
    urls?: Array<{ name: string; url: string }>;
    commands?: Array<{ name: string; command: string }>;
  };
}

async function fetchSoftwareTeamEnv(softwareTeamId: string): Promise<SoftwareTeamEnvData> {
  const res = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/env`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useSoftwareTeamEnv(softwareTeamId: string) {
  return useQuery({
    queryKey: ["software-team-env", softwareTeamId],
    queryFn: () => fetchSoftwareTeamEnv(softwareTeamId),
    refetchInterval: 10_000,
  });
}
