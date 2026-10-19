import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeTopologyEventStatus, subscribeTopologyEvents } from "../lib/topology-events.js";

/**
 * Global event listener. Subscribes to the shared /api/events hub and
 * invalidates relevant queries when state-changing events arrive.
 * Mounted once in AppShell.
 */
export function useGlobalEvents(): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const pendingInvalidations = new Set<string>();

    const unsubscribeStatus = subscribeTopologyEventStatus(status => {
      setConnected(status.connected);
      if (status.connected) for (const key of ["review", "slices", "mission"]) void queryClient.invalidateQueries({ queryKey: [key] });
    });
    const unsubscribe = subscribeTopologyEvents((parsed) => {
      const { type, softwareTeamId } = parsed;
      if (!type) return;

      if (type.startsWith("proof.")) for (const key of ["review", "slices", "mission"]) void queryClient.invalidateQueries({ queryKey: [key] });

      // Collect affected query keys
      if (type.startsWith("node.startup_") && softwareTeamId) {
        pendingInvalidations.add(`software-team:${softwareTeamId}:nodes`);
      }
      if (type === "software-team.created" || type === "software-team.deleted" || type === "software-team.stopped" ||
          type === "softwareTeam.imported" ||
          type === "bootstrap.completed" || type === "bootstrap.partial") {
        pendingInvalidations.add("softwareTeams:summary");
        pendingInvalidations.add("ps");
      }
      if (type === "restore.completed") {
        // slice-04: ps + default-summary are AGGREGATE signals — queue them
        // REGARDLESS of softwareTeamId (matching the prior ActivityFeed aggregate
        // behavior). Only the software-team-specific nodes key stays conditional on softwareTeamId.
        pendingInvalidations.add("softwareTeams:summary");
        pendingInvalidations.add("ps");
        if (softwareTeamId) pendingInvalidations.add(`software-team:${softwareTeamId}:nodes`);
      }
      // slice-04: useGlobalEvents (this one AppShell-mounted 150ms Set/timer) is
      // now the SOLE coalesced owner of the ps + default-summary invalidations
      // that ActivityFeed used to fire per-event. SoftwareTeam-scoped graph/nodes/sessions
      // + discovery invalidations stay in ActivityFeed (distinct-key semantics).
      if (type === "node.claimed" && softwareTeamId) {
        pendingInvalidations.add("softwareTeams:summary");
        pendingInvalidations.add("ps");
      }
      if (type === "session.detached" || type === "node.removed" ||
          type === "pod.deleted" || type === "softwareTeam.expanded") {
        pendingInvalidations.add("softwareTeams:summary");
        pendingInvalidations.add("ps");
      }
      // OPR.0.3.3.19 (AC-7): archive/unarchive move a softwareTeam between the default
      // view and the per-host Archive section. Refetch BOTH the default summary
      // AND the archived-only summary (a separate query key) plus ps, so a CLI
      // or other-browser archive/unarchive updates a mounted UI reactively
      // instead of going stale until manual reload.
      if (type === "software-team.archived" || type === "softwareTeam.unarchived") {
        pendingInvalidations.add("softwareTeams:summary");
        pendingInvalidations.add("softwareTeams:summary:archived");
        pendingInvalidations.add("ps");
        if (softwareTeamId) pendingInvalidations.add(`software-team:${softwareTeamId}:nodes`);
      }

      // Schedule flush
      if (debounceRef.current) return; // Already scheduled
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;

        // Flush all pending invalidations
        for (const key of pendingInvalidations) {
          if (["review", "slices", "mission"].includes(key)) {
            void queryClient.invalidateQueries({ queryKey: [key] });
          } else if (key === "softwareTeams:summary") {
            queryClient.invalidateQueries({ queryKey: ["softwareTeams", "summary"] });
          } else if (key === "softwareTeams:summary:archived") {
            // OPR.0.3.3.19: the Archive section's archived-only query (see
            // useArchivedSoftwareTeams, queryKey ["softwareTeams","summary","archived"]).
            // Invalidated explicitly so it refetches even though the broader
            // ["softwareTeams","summary"] prefix invalidation would also cover it.
            queryClient.invalidateQueries({ queryKey: ["softwareTeams", "summary", "archived"] });
          } else if (key === "ps") {
            queryClient.invalidateQueries({ queryKey: ["ps"] });
          } else if (key.startsWith("software-team:")) {
            const parts = key.split(":");
            queryClient.invalidateQueries({ queryKey: ["softwareTeam", parts[1], parts[2]] });
          }
        }
        pendingInvalidations.clear();
      }, 150);
    });

    return () => {
      unsubscribe();
      unsubscribeStatus();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [queryClient]);
  return { connected };
}
