import { useQuery, useMutation } from "@tanstack/react-query";

export interface SpecGraphData {
  nodes: Array<{ id: string; label: string; pod?: string; runtime: string; kind: "agent" | "infrastructure" }>;
  edges: Array<{ source: string; target: string; kind: string }>;
}

interface PodReview {
  id: string;
  namespace?: string;
  label?: string;
  members: Array<{ id: string; agentRef: string; runtime: string; profile?: string }>;
  edges: Array<{ from: string; to: string; kind: string }>;
}

interface NodeReview {
  id: string;
  runtime: string;
  role?: string;
  model?: string;
}

export interface SoftwareTeamSpecServicesReview {
  kind: "compose";
  composeFile: string;
  projectName?: string;
  downPolicy?: string;
  waitFor: Array<{
    service?: string;
    url?: string;
    tcp?: string;
    condition?: "healthy";
  }>;
  surfaces?: {
    urls?: Array<{ name: string; url: string }>;
    commands?: Array<{ name: string; command: string }>;
  };
  composePreview?: {
    services: Array<{ name: string; image?: string }>;
  };
}

export interface SoftwareTeamSpecReview {
  sourceState: string;
  kind: "softwareTeam";
  name: string;
  version: string;
  summary?: string;
  cultureFile?: string;
  services?: SoftwareTeamSpecServicesReview;
  format: "pod_aware" | "legacy";
  pods?: PodReview[];
  nodes?: NodeReview[];
  edges: Array<{ from: string; to: string; kind: string }>;
  graph: SpecGraphData;
  raw: string;
}

export interface AgentSpecReview {
  sourceState: string;
  kind: "agent";
  name: string;
  version: string;
  description?: string;
  profiles: Array<{ name: string; description?: string }>;
  resources: {
    skills: string[];
    guidance: string[];
    plugins: string[];
    subagents: string[];
  };
  startup: {
    files: Array<{ path: string; required: boolean }>;
    actions: Array<{ type: string; value: string }>;
  };
  raw: string;
}

async function fetchSoftwareTeamReview(yaml: string, sourceState = "draft"): Promise<SoftwareTeamSpecReview> {
  const res = await fetch("/api/specs/review/softwareTeam", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml, sourceState }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { errors?: string[] }).errors?.join("; ") ?? `HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchAgentReview(yaml: string, sourceState = "draft"): Promise<AgentSpecReview> {
  const res = await fetch("/api/specs/review/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml, sourceState }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { errors?: string[] }).errors?.join("; ") ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** Simple string hash for cache keys — avoids truncation collisions. */
function hashYaml(yaml: string): number {
  let hash = 0;
  for (let i = 0; i < yaml.length; i++) {
    hash = ((hash << 5) - hash + yaml.charCodeAt(i)) | 0;
  }
  return hash;
}

export function useSoftwareTeamSpecReview(yaml: string | null, sourceState = "draft") {
  return useQuery({
    queryKey: ["spec-review", "softwareTeam", yaml ? hashYaml(yaml) : null, sourceState],
    queryFn: () => fetchSoftwareTeamReview(yaml!, sourceState),
    enabled: !!yaml,
  });
}

export function useAgentSpecReview(yaml: string | null, sourceState = "draft") {
  return useQuery({
    queryKey: ["spec-review", "agent", yaml ? hashYaml(yaml) : null, sourceState],
    queryFn: () => fetchAgentReview(yaml!, sourceState),
    enabled: !!yaml,
  });
}
