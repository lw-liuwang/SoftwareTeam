// Token / Context Usage Surface v0 (PL-012) — fleet-wide context view.
//
// Fetches /api/ps then per-softwareTeam /api/software-teams/:id/nodes (matching how
// SoftwareTeam ps --nodes -A assembles the cross-softwareTeam list — daemon API, unaffected
// by the v0.4.4 CLI default flip), enriches each node with
// the existing contextUsage block, and projects a flat per-seat list
// for the /context dashboard.
//
// No new daemon route at v0; reuses what's already shipped.

import { useQuery } from "@tanstack/react-query";
import type { NodeInventoryEntry } from "./useNodeInventory.js";

export type ContextTier = "critical" | "warning" | "low" | "unknown";

export interface FleetSeat {
  softwareTeamId: string;
  softwareTeamName: string;
  logicalId: string;
  canonicalSessionName: string | null;
  runtime: string | null;
  usedPercentage: number | null;
  fresh: boolean;
  availability: string;
  sampledAt: string | null;
  tier: ContextTier;
}

export interface FleetSummary {
  total: number;
  byTier: Record<ContextTier, number>;
  byRuntime: Record<string, number>;
  bySoftwareTeam: Array<{ softwareTeamId: string; softwareTeamName: string; count: number }>;
}

export interface FleetData {
  seats: FleetSeat[];
  summary: FleetSummary;
}

export function deriveContextTier(percent: number | null | undefined, availability?: string): ContextTier {
  if (availability !== "known" || typeof percent !== "number") return "unknown";
  if (percent >= 80) return "critical";
  if (percent >= 60) return "warning";
  return "low";
}

interface PsSoftwareTeam {
  softwareTeamId: string;
  name: string;
  softwareTeamName?: string;
}

async function fetchFleet(): Promise<FleetData> {
  const psRes = await fetch("/api/ps");
  if (!psRes.ok) throw new Error(`HTTP ${psRes.status} from /api/ps`);
  const softwareTeams = (await psRes.json()) as PsSoftwareTeam[];

  const seats: FleetSeat[] = [];
  for (const softwareTeam of softwareTeams) {
    const softwareTeamName = softwareTeam.softwareTeamName ?? softwareTeam.name;
    const nodesRes = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeam.softwareTeamId)}/nodes`);
    if (!nodesRes.ok) continue;
    const nodes = (await nodesRes.json()) as NodeInventoryEntry[];
    for (const n of nodes) {
      const ctx = n.contextUsage;
      const usedPercentage = ctx?.usedPercentage ?? null;
      const availability = ctx?.availability ?? "unknown";
      const fresh = ctx?.fresh ?? false;
      seats.push({
        softwareTeamId: softwareTeam.softwareTeamId,
        softwareTeamName,
        logicalId: n.logicalId,
        canonicalSessionName: n.canonicalSessionName,
        runtime: n.runtime,
        usedPercentage,
        fresh,
        availability,
        sampledAt: ctx?.sampledAt ?? null,
        tier: deriveContextTier(usedPercentage, availability),
      });
    }
  }

  const byTier: Record<ContextTier, number> = { critical: 0, warning: 0, low: 0, unknown: 0 };
  const byRuntime: Record<string, number> = {};
  const bySoftwareTeamCount = new Map<string, { softwareTeamName: string; count: number }>();
  for (const s of seats) {
    byTier[s.tier]++;
    const rt = s.runtime ?? "unknown";
    byRuntime[rt] = (byRuntime[rt] ?? 0) + 1;
    const existing = bySoftwareTeamCount.get(s.softwareTeamId);
    if (existing) existing.count++;
    else bySoftwareTeamCount.set(s.softwareTeamId, { softwareTeamName: s.softwareTeamName, count: 1 });
  }
  const bySoftwareTeam = Array.from(bySoftwareTeamCount.entries()).map(([softwareTeamId, v]) => ({ softwareTeamId, softwareTeamName: v.softwareTeamName, count: v.count }));

  return {
    seats,
    summary: { total: seats.length, byTier, byRuntime, bySoftwareTeam },
  };
}

export function useContextFleet() {
  return useQuery({
    queryKey: ["context-fleet"],
    queryFn: fetchFleet,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}
