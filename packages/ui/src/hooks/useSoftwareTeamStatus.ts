// OPR.0.4.3.22 — the composed software-team-status object (GET /api/software-teams/:id/status).
//
// Mirrors the daemon `composeSoftwareTeamStatus` fold: a softwareTeam's status is COMPOSED from
// backend signals (ps-lifecycle + restore-plan + restore-check + kernel-status),
// NEVER inferred from pane text or /healthz. `src[]` is the composed provenance.
// The per-seat truths are preserved (the LOCK: no global-fresh flip).

import { useQuery } from "@tanstack/react-query";

export type SoftwareTeamAggStatus = "up" | "partial" | "down" | "blocked" | "unknown";
export type SeatTokenState = "present" | "missing" | "stale" | "unverified";
export type SeatIntendedAction = "resume-original" | "fresh-primed" | "awaiting-decision";

export interface SoftwareTeamStatusSeat {
  logicalId: string;
  runtime: string | null;
  lifecycleState: "running" | "detached" | "recoverable" | "attention_required";
  tokenState: SeatTokenState;
  intendedAction: SeatIntendedAction;
  freshRequired: boolean;
  blocked: boolean;
  provenance?: string | null;
  lastVerified?: string | null;
  reason?: string;
  runtimePrompt?: string;
}

export interface SoftwareTeamStatusObject {
  softwareTeamId: string;
  softwareTeamName: string;
  isKernel: boolean;
  status: SoftwareTeamAggStatus;
  seatsTotal: number;
  seatsRunning: number;
  recoverable: boolean;
  perSeat: SoftwareTeamStatusSeat[];
  src: string[];
}

async function fetchSoftwareTeamStatus(softwareTeamId: string): Promise<SoftwareTeamStatusObject> {
  const res = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useSoftwareTeamStatus(softwareTeamId: string | undefined) {
  return useQuery({
    queryKey: ["softwareTeam", softwareTeamId, "status"],
    queryFn: () => fetchSoftwareTeamStatus(softwareTeamId!),
    enabled: !!softwareTeamId,
    // Status folds restore-check (some filesystem probing) — poll gently, not
    // at the 3s ps cadence.
    refetchInterval: 10_000,
  });
}
