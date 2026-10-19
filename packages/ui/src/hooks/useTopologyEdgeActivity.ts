// PL-019 item 6: subscribe to the shared topology event hub and track recent
// inter-seat traffic so the topology graph can emphasize edges that
// just fired (one-shot ~1.2s pulse) and edges that have seen traffic
// in the last ~30s (1.5x weight + brighter, decays back to neutral).
//
// Visual contract:
//   - use short pulse emphasis instead of constant blinking
//   - one-shot ~1.2s per event; direction matters (source -> dest)
//   - edges with traffic in last ~30s stay 1.5x weight + brighter
//   - distinct event-type cues optional; v0 unifies all four event
//     types under the same "traffic" treatment to keep this restrained
//
// We track edge state by `${sourceSession}::${destinationSession}` and
// expose a stable lookup function the SoftwareTeamGraph edge-mapping memo can
// call. Resolution to actual graph-edge-ids happens at render time
// because the graph nodes know their canonicalSessionName.

import { useEffect, useRef, useState } from "react";
import { subscribeTopologyEvents } from "../lib/topology-events.js";

const RECENT_TRAFFIC_WINDOW_MS = 30_000;
const JUST_FIRED_WINDOW_MS = 1_200;
const PRUNE_INTERVAL_MS = 1_000;

export interface EdgeActivityEntry {
  // Most-recent firing timestamp (ms since epoch) for this directed pair.
  lastFiredAt: number;
  // The four PL-019-tracked event types we currently emphasize. v0 treats
  // them uniformly; future iterations may differentiate cues per-type.
  lastEventType: string;
}

export interface EdgeActivityLookup {
  /** Returns the activity entry for a directed (source -> dest) pair, or null. */
  get(sourceSession: string, destSession: string): EdgeActivityEntry | null;
  /** True when the pair fired within the just-fired window (one-shot pulse). */
  justFired(sourceSession: string, destSession: string, nowMs?: number): boolean;
  /** True when the pair fired within the recent-traffic window (sustained emphasis). */
  recentTraffic(sourceSession: string, destSession: string, nowMs?: number): boolean;
  /** Internal: snapshot used by the React render path for stable equality. */
  version: number;
}

interface ParsedEvent {
  type?: string;
  // Each tracked event type uses a different field name for source/dest
  // sessions; we normalize on parse.
  source?: string;
  dest?: string;
}

function normalizeEvent(raw: unknown): ParsedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : undefined;
  if (!type) return null;
  // queue.created             -> sourceSession + destinationSession
  // queue.handed_off          -> fromSession + toSession
  // qitem.fallback_routed     -> originalDestination + rerouteDestination
  //                             (treats reroute as the destination so the
  //                             edge that lights up shows the new owner)
  // mission_control.action_executed -> actorSession + (qitem dest if known)
  //                             v0 only animates source->dest pairs we
  //                             can construct from a single event payload;
  //                             action_executed lacks a dest, so we skip it
  //                             until a future iteration carries the qitem
  //                             dest forward into the event itself.
  if (type === "queue.created") {
    const source = typeof e.sourceSession === "string" ? e.sourceSession : undefined;
    const dest = typeof e.destinationSession === "string" ? e.destinationSession : undefined;
    if (!source || !dest) return null;
    return { type, source, dest };
  }
  if (type === "queue.handed_off") {
    const source = typeof e.fromSession === "string" ? e.fromSession : undefined;
    const dest = typeof e.toSession === "string" ? e.toSession : undefined;
    if (!source || !dest) return null;
    return { type, source, dest };
  }
  if (type === "qitem.fallback_routed") {
    const source = typeof e.originalDestination === "string" ? e.originalDestination : undefined;
    const dest = typeof e.rerouteDestination === "string" ? e.rerouteDestination : undefined;
    if (!source || !dest) return null;
    return { type, source, dest };
  }
  return null;
}

function makeKey(sourceSession: string, destSession: string): string {
  return `${sourceSession}\u0000${destSession}`;
}

export function useTopologyEdgeActivity(): EdgeActivityLookup {
  // Map keyed by directed pair. We keep the map in a ref so the EventSource
  // handler can mutate without retriggering subscription teardown; render
  // pulls a `version` counter that increments on prune/firing.
  const mapRef = useRef<Map<string, EdgeActivityEntry>>(new Map());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const unsubscribe = subscribeTopologyEvents((parsed) => {
      if (cancelled) return;
      const normalized = normalizeEvent(parsed);
      if (!normalized || !normalized.source || !normalized.dest) return;
      const key = makeKey(normalized.source, normalized.dest);
      mapRef.current.set(key, {
        lastFiredAt: Date.now(),
        lastEventType: normalized.type ?? "unknown",
      });
      setVersion((v) => v + 1);
    });

    // Periodic prune. Even if no new events arrive, an edge that just dropped
    // out of the recent-traffic window should re-render to lose its emphasis.
    const pruneTimer = setInterval(() => {
      if (cancelled) return;
      const cutoff = Date.now() - RECENT_TRAFFIC_WINDOW_MS;
      let mutated = false;
      for (const [key, entry] of mapRef.current.entries()) {
        if (entry.lastFiredAt < cutoff) {
          mapRef.current.delete(key);
          mutated = true;
        }
      }
      if (mutated) setVersion((v) => v + 1);
    }, PRUNE_INTERVAL_MS);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(pruneTimer);
    };
  }, []);

  // Return a stable interface bound to the latest version. Callers should
  // include `version` in their useMemo dependency lists so they refresh
  // when activity changes; this avoids exposing the raw mutable map.
  return {
    version,
    get(sourceSession: string, destSession: string): EdgeActivityEntry | null {
      return mapRef.current.get(makeKey(sourceSession, destSession)) ?? null;
    },
    justFired(sourceSession: string, destSession: string, nowMs?: number): boolean {
      const entry = mapRef.current.get(makeKey(sourceSession, destSession));
      if (!entry) return false;
      const now = nowMs ?? Date.now();
      return now - entry.lastFiredAt < JUST_FIRED_WINDOW_MS;
    },
    recentTraffic(sourceSession: string, destSession: string, nowMs?: number): boolean {
      const entry = mapRef.current.get(makeKey(sourceSession, destSession));
      if (!entry) return false;
      const now = nowMs ?? Date.now();
      return now - entry.lastFiredAt < RECENT_TRAFFIC_WINDOW_MS;
    },
  };
}

// Test-only helpers exported as named so vitest can drive the lookup
// without spinning up an EventSource. Mirrors how Phase A tests treat
// MissionControlReadLayer constructors.
export const __test_internals = {
  RECENT_TRAFFIC_WINDOW_MS,
  JUST_FIRED_WINDOW_MS,
  normalizeEvent,
  makeKey,
};
