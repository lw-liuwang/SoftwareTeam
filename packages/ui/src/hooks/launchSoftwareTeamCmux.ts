// Slice 24 — launchSoftwareTeamCmux.
//
// Promise helper that POSTs to /api/software-teams/:softwareTeamId/cmux/launch (the new
// daemon endpoint shipped in slice 24 Checkpoint C). Returns the
// workspaces array from the daemon's response on success; throws an
// Error carrying the daemon's honest 3-part message on 4xx/5xx.
//
// Distinct from useCmuxLaunch.ts which targets a single node's
// open-or-focus endpoint POST /api/software-teams/:softwareTeamId/nodes/:logicalId/open-cmux.

export interface SoftwareTeamCmuxLaunchInput {
  softwareTeamId: string;
}

export interface CmuxLaunchedWorkspace {
  name: string;
  agents: string[];
  blanks: number;
}

export interface MissingSeat {
  logicalId: string;
  reason: string;
}

export interface SoftwareTeamCmuxLaunchSuccess {
  ok: true;
  workspaces: CmuxLaunchedWorkspace[];
  missing?: MissingSeat[];
}

interface SoftwareTeamCmuxLaunchErrorBody {
  error: string;
  message: string;
  partial?: CmuxLaunchedWorkspace[];
}

export async function launchSoftwareTeamCmux({ softwareTeamId }: SoftwareTeamCmuxLaunchInput): Promise<SoftwareTeamCmuxLaunchSuccess> {
  const res = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/cmux/launch`, {
    method: "POST",
  });
  if (!res.ok) {
    let body: SoftwareTeamCmuxLaunchErrorBody | null = null;
    try {
      body = (await res.json()) as SoftwareTeamCmuxLaunchErrorBody;
    } catch {
      // fall through
    }
    const message = body?.message ?? body?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return (await res.json()) as SoftwareTeamCmuxLaunchSuccess;
}
