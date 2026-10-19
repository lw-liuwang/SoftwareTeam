// OPR.0.4.6.FAC1 — the role-resolution CONTEXT builder: the impure
// half that materializes the pure policy's fact array from the shipped
// software-team-scoped inventory projection + the SYNCHRONOUS work-enrichment.
//
// SYNC-ONLY BY CONSTRUCTION (arch Q1 = guard B4): this composes
// `getNodeInventory` (synchronous SQL projection — lifecycle already
// folds session status, restore outcome, and the identity-verdict
// down-rank) with `attachTerminalActivityAndWork` WITHOUT a
// SeatActivityService (so `terminalActive` stays undefined and only the
// sync pending-work map is computed). The ASYNC `attachAgentActivity`
// tmux-probe path is STRUCTURALLY absent — it cannot enter the
// synchronous close+create transaction (planner2's headline finding).
//
// LAZY BY CONSTRUCTION (guard B1): building a context performs ZERO
// reads — the snapshot materializes only when `candidatesForSoftwareTeam()` is
// invoked, which happens exclusively on the tier-3 resolution path
// (AFTER the frontier + absorption guards). Absorbed waiting-replays
// and terminal frontier rejections therefore perform zero
// role-resolution inventory reads; the commit-4 read-spy pins it.
//
// FRESH NAME→ID PER RESOLUTION (arch Q4): the bound softwareTeam persists as a
// NAME; each snapshot re-resolves name→id. A vanished softwareTeam returns
// null and the caller fails loud (`bound_software_team_not_found` class) — WF-5
// catches the failed instance.

import type Database from "better-sqlite3";
import {
  attachTerminalActivityAndWork,
  deriveCanonicalFromEntry,
  getNodeInventory,
} from "./node-inventory.js";
import { selectRoleSeat, type RoleSeatCandidateFacts } from "./workflow-role-resolver.js";

export interface RoleResolutionContext {
  /** The instance's bound softwareTeam NAME (never null — an unbound instance
   *  builds no context at all; tier 3 simply does not exist for it). */
  boundSoftwareTeam: string;
  /**
   * Materialize the candidate-facts snapshot for the bound softwareTeam, NOW.
   * null = the bound softwareTeam no longer resolves by name (vanished mid-run).
   * Reads happen only when this is called (the guard-B1 laziness pin).
   */
  candidatesForSoftwareTeam: () => RoleSeatCandidateFacts[] | null;
}

/**
 * Build the (lazy) resolution context for a bound instance.
 * Returns undefined for unbound instances so call sites can thread
 * `instance.boundSoftwareTeam` straight through:
 *   `roleResolutionContext(db, instance.boundSoftwareTeam)`
 */
export function roleResolutionContext(
  db: Database.Database,
  boundSoftwareTeam: string | null | undefined,
): RoleResolutionContext | undefined {
  if (!boundSoftwareTeam) return undefined;
  return {
    boundSoftwareTeam,
    candidatesForSoftwareTeam: () => {
      const softwareTeam = db
        .prepare(`SELECT id FROM software_teams WHERE name = ? ORDER BY created_at LIMIT 1`)
        .get(boundSoftwareTeam) as { id: string } | undefined;
      if (!softwareTeam) return null;
      const entries = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam.id), { db });
      return entries.map((e) => ({
        logicalId: e.logicalId,
        role: e.role,
        nodeKind: e.nodeKind,
        lifecycleState: e.lifecycleState,
        runtime: e.runtime,
        pendingWorkCount: e.pendingWorkCount ?? 0,
        coordinate: deriveCanonicalFromEntry(e),
        rawSessionName: e.canonicalSessionName,
      }));
    },
  };
}

/**
 * Resolve `role` on the bound softwareTeam, returning null for an evidenced no-match
 * or an unbound/vanished softwareTeam. Evidence-read failures propagate: they cannot
 * establish that no eligible agent exists and must not select a human.
 * Each exception item uses a fresh snapshot at its detection moment.
 */
export function tryResolveRoleByCapability(
  ctx: RoleResolutionContext | undefined,
  role: string,
  harness?: string,
): string | null {
  if (!ctx) return null;
  const candidates = ctx.candidatesForSoftwareTeam();
  if (!candidates) return null;
  return selectRoleSeat({ role, harness, candidates }).seat;
}

/**
 * The STRUCTURAL role-coverage probe (arch Q2 / guard B1): does ANY
 * seat on the bound softwareTeam declare `role`, at ANY lifecycle state?
 * Existence, not liveness — instantiate hard-fails only on ZERO
 * structural coverage (a typo'd/undeclared role), never on a
 * not-yet-running seat (factory softwareTeams warm up; liveness is that step's
 * own projection-time concern).
 */
export function softwareTeamDeclaresRole(
  db: Database.Database,
  boundSoftwareTeam: string,
  role: string,
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM nodes n
         JOIN software_teams r ON r.id = n.software_team_id
        WHERE r.name = ? AND n.role = ?`,
    )
    .get(boundSoftwareTeam, role) as { c: number };
  return row.c > 0;
}

/**
 * OPR.0.4.6.FAC3 (FR-5): the structural MEMBER-EXISTS probe — does any
 * member of `softwareTeamName` derive the canonical coordinate `sessionRef`?
 *
 * Existence at ANY lifecycle state and ANY node kind (`softwareTeamDeclaresRole`'s
 * sibling discipline): a declared-but-not-yet-launched seat, or a
 * terminal member explicitly named as a preferred_target, is a
 * legitimate destination — liveness/kind is projection's business, not
 * this probe's. The compare is the DERIVED canonical coordinate
 * `{pod}-{member}@{softwareTeam}` via the same derivation tier-3 candidates use
 * (the FAC-1 Q5 one-string rule — a raw occupant-era session name never
 * participates). Sync SQL only; an unknown softwareTeam name returns false (the
 * caller's registered-softwareTeam skip runs first, so that case never reaches
 * an advisory here). MAY THROW on a partial-schema DB (the inventory
 * projection reads tables like `snapshots`) — the FR-5 sweep treats a
 * throw as cannot-vouch and skips (advisory-never-throw; VM-caught run-1).
 */
export function softwareTeamMemberExists(
  db: Database.Database,
  softwareTeamName: string,
  sessionRef: string,
): boolean {
  const softwareTeam = db
    .prepare(`SELECT id FROM software_teams WHERE name = ? ORDER BY created_at LIMIT 1`)
    .get(softwareTeamName) as { id: string } | undefined;
  if (!softwareTeam) return false;
  return getNodeInventory(db, softwareTeam.id).some(
    (e) => deriveCanonicalFromEntry(e) === sessionRef,
  );
}
