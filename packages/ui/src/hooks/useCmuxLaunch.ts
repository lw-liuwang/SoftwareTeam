// V1 attempt-3 Phase 4 — useCmuxLaunch.
//
// Thin wrapper around the daemon open-or-focus endpoint.
// `POST /api/software-teams/:softwareTeamId/nodes/:logicalId/open-cmux` creates a cmux
// surface when the node is not already bound, and focuses the existing
// surface when it is.

import { useMutation } from "@tanstack/react-query";
import { terminalAuthHeaders } from "../components/mission-control/missionControlAuth.js";

interface CmuxLaunchInput {
  softwareTeamId: string;
  logicalId: string;
}

interface OpenCmuxResult {
  ok?: boolean;
  action?: string;
  code?: string;
  error?: string;
  message?: string;
}

export async function postOpenCmux({ softwareTeamId, logicalId }: CmuxLaunchInput): Promise<OpenCmuxResult> {
  const res = await fetch(
    `/api/software-teams/${encodeURIComponent(softwareTeamId)}/nodes/${encodeURIComponent(logicalId)}/open-cmux`,
    { method: "POST", headers: terminalAuthHeaders() },
  );
  const body = (await res.json().catch(() => null)) as OpenCmuxResult | null;
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.message ?? body?.error ?? body?.code ?? `HTTP ${res.status}`);
  }
  return body ?? { ok: true };
}

export function useCmuxLaunch() {
  return useMutation({
    mutationFn: postOpenCmux,
  });
}
