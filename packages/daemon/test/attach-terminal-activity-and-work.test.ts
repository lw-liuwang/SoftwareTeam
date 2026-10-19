// Slice 15 — `attachTerminalActivityAndWork` non-inference test pack.
//
// HG-3 (both directions) + HG-4 (non-inference contract) at the
// per-node enrichment level. The ps-projection counts are derived from
// these fields, but the UI + `SoftwareTeam ps --json` also need per-node
// visibility — this test pack pins that surface.
//
// Discriminator pattern (per banked feedback_specific_review_recommendations_get_acted_on):
//   - DIRECTION A: active + no work → terminalActive=true, hasAssignedWork=false
//   - DIRECTION B: silent + queued work → terminalActive=false, hasAssignedWork=true
//   BOTH must pass — that's what proves the two primitives are computed
//   independently. Either alone is symmetry-breakable.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import {
  attachTerminalActivityAndWork,
  getNodeInventory,
  readAssignedWorkBySession,
} from "../src/domain/node-inventory.js";
import {
  countAssignedWorkForSession,
  countPendingWorkForSession,
} from "../src/domain/ps-projection.js";

function seedSoftwareTeam(db: Database.Database, name: string): string {
  const id = `software-team-${name}`;
  db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(id, name);
  return id;
}
function seedNode(db: Database.Database, softwareTeamId: string, logicalId: string): string {
  const id = `node-${softwareTeamId}-${logicalId}`;
  db.prepare("INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)").run(id, softwareTeamId, logicalId);
  return id;
}
function seedSession(db: Database.Database, nodeId: string, sessionName: string, status = "running"): void {
  const id = `sess-${nodeId}-${Date.now()}-${Math.random()}`;
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, nodeId, sessionName, status, new Date().toISOString().replace("T", " ").slice(0, 19));
}
function seedQitem(
  db: Database.Database,
  destinationSession: string,
  state: string,
  body = "test-body",
): string {
  const id = `q-${Date.now()}-${Math.random()}`;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  db.prepare(`
    INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
    VALUES (?, ?, ?, ?, ?, ?, 'routine', 'routine', ?)
  `).run(id, ts, ts, "op@test", destinationSession, state, body);
  return id;
}

function seedPendingQitem(db: Database.Database, destinationSession: string, body = "test-body"): void {
  seedQitem(db, destinationSession, "pending", body);
}

function makeSeatActivityFor(activeBySession: Record<string, boolean | null>) {
  return {
    getSeatActivity: (paneId: string) => {
      if (!(paneId in activeBySession)) return null;
      const isActive = activeBySession[paneId]!;
      if (isActive === null) return null;
      return {
        paneId,
        isActiveWithinWindow: isActive,
        silenceWindowSeconds: 3,
        lastObservedAt: "2026-05-16T00:00:00.000Z",
        lastActivityAt: "2026-05-15T23:59:40.000Z",
      };
    },
  };
}

describe("attachTerminalActivityAndWork — slice 15 per-node enrichment", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  it("HG-3 DIRECTION A — node producing output with NOTHING queued: terminalActive=true, hasAssignedWork=false", () => {
    const softwareTeam = seedSoftwareTeam(db, "active-only");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");

    const baseEntries = getNodeInventory(db, softwareTeam);
    const seatActivity = makeSeatActivityFor({ "dev@software-team": true });
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });

    expect(entry!.terminalActive).toBe(true);
    expect(entry!.hasAssignedWork).toBe(false);
    expect(entry!.pendingWorkCount).toBe(0);
  });

  it("HG-3 DIRECTION B — node SILENT with queued work: terminalActive=false, hasAssignedWork=true", () => {
    const softwareTeam = seedSoftwareTeam(db, "work-only");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");
    seedPendingQitem(db, "dev@software-team");

    const baseEntries = getNodeInventory(db, softwareTeam);
    const seatActivity = makeSeatActivityFor({ "dev@software-team": false });
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });

    expect(entry!.terminalActive).toBe(false);
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("HG-4 non-inference — flipping ONLY activity does not move hasAssignedWork; flipping ONLY queue does not move terminalActive", () => {
    const softwareTeam = seedSoftwareTeam(db, "non-inf");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");
    const baseEntries = getNodeInventory(db, softwareTeam);

    // (a) silent + no work
    let seatActivity = makeSeatActivityFor({ "dev@software-team": false });
    let [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });
    expect(entry!.terminalActive).toBe(false);
    expect(entry!.hasAssignedWork).toBe(false);

    // (b) flip ONLY queue (add pending qitem); activity input unchanged.
    //     terminalActive MUST hold steady, hasAssignedWork MUST flip true.
    seedPendingQitem(db, "dev@software-team");
    [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db, seatActivity: seatActivity as never });
    expect(entry!.terminalActive).toBe(false); // unchanged ⟹ no queue→active inference
    expect(entry!.hasAssignedWork).toBe(true);

    // (c) flip ONLY activity (active observation); queue input unchanged.
    //     hasAssignedWork MUST hold steady, terminalActive MUST flip true.
    seatActivity = makeSeatActivityFor({ "dev@software-team": true });
    [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db, seatActivity: seatActivity as never });
    expect(entry!.terminalActive).toBe(true);
    expect(entry!.hasAssignedWork).toBe(true); // unchanged ⟹ no active→hasWork inference
  });

  it("no SeatActivity observation → terminalActive=null (distinct from false)", () => {
    const softwareTeam = seedSoftwareTeam(db, "no-obs");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");

    const baseEntries = getNodeInventory(db, softwareTeam);
    const seatActivity = { getSeatActivity: () => null };
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });

    // null ≠ false: consumers must treat "no signal" distinctly from
    // "definitely idle" so a non-tmux seat doesn't read as idle.
    expect(entry!.terminalActive).toBeNull();
    expect(entry!.hasAssignedWork).toBe(false);
  });

  it("no seatActivity service wired → terminalActive=undefined (the field is absent, not a value claim)", () => {
    const softwareTeam = seedSoftwareTeam(db, "no-svc");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");

    const baseEntries = getNodeInventory(db, softwareTeam);
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db });

    expect(entry!.terminalActive).toBeUndefined();
    expect(entry!.hasAssignedWork).toBe(false); // queue check still runs
  });

  // ── ARCH RULING 3a947fb1: the per-seat projection surfaces the RAW
  // ── lastActivityAt fact alongside terminalActive — projected verbatim, null
  // ── when no observation (honest absence, parallel to terminalActive), and
  // ── with NO ageSeconds sibling (C3 — age is derived renderer-side).
  it("projects lastActivityAt VERBATIM from the observation (raw fact, distinct from lastObservedAt) — and no ageSeconds sibling (C3)", () => {
    const softwareTeam = seedSoftwareTeam(db, "act-ts");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");

    const seatActivity = {
      getSeatActivity: (paneId: string) =>
        paneId === "dev@software-team"
          ? {
              paneId,
              isActiveWithinWindow: true,
              silenceWindowSeconds: 3,
              lastObservedAt: "2026-05-16T10:00:00.000Z",
              lastActivityAt: "2026-05-16T09:59:12.000Z", // distinct raw fact
            }
          : null,
    };
    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db, seatActivity: seatActivity as never });

    expect(entry!.lastActivityAt).toBe("2026-05-16T09:59:12.000Z");
    // C3 — one field only; no ageSeconds sibling on the projected surface.
    expect((entry as Record<string, unknown>).ageSeconds).toBeUndefined();
  });

  it("no observation → lastActivityAt=null (honest absence, parallel to terminalActive=null)", () => {
    const softwareTeam = seedSoftwareTeam(db, "act-noobs");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");

    const seatActivity = { getSeatActivity: () => null };
    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db, seatActivity: seatActivity as never });

    expect(entry!.terminalActive).toBeNull();
    expect(entry!.lastActivityAt).toBeNull();
  });

  it("no seatActivity service wired → lastActivityAt=undefined (field absent, not a value claim)", () => {
    const softwareTeam = seedSoftwareTeam(db, "act-nosvc");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db });
    expect(entry!.lastActivityAt).toBeUndefined();
  });

  it("multiple pending qitems for one seat ⟹ hasAssignedWork=true, pendingWorkCount = N", () => {
    const softwareTeam = seedSoftwareTeam(db, "multi");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");
    seedPendingQitem(db, "dev@software-team");
    seedPendingQitem(db, "dev@software-team");
    seedPendingQitem(db, "dev@software-team");

    const baseEntries = getNodeInventory(db, softwareTeam);
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(3);
  });

  // QA baseline-deep-dogfood BLOCKING-A2 (qitem-20260518063900-85745917):
  // adopted/live-session softwareTeams do not surface assigned queue work because
  // hasAssignedWork only matches destination_session against
  // canonicalSessionName. For ADOPTED seats canonicalSessionName is the
  // raw tmux session name (e.g., `my-existing-claude`); operators
  // address adopted seats via the canonical `{pod}-{member}@{softwareTeam}` form
  // through `SoftwareTeam queue create --destination <pod>-<member>@<softwareTeam>`.
  // The match therefore fails for adopted, succeeds for managed (where
  // canonicalSessionName is already the canonical form).
  //
  // Fix: resolve pending work by BOTH forms — entry.canonicalSessionName
  // (covers managed + adopted users who queue by raw tmux name) AND the
  // derived `{pod}-{member}@{softwareTeam}` form (covers adopted users who queue
  // by canonical id). Discriminators below pin both directions.

  it("BLOCKING-A2: adopted-style entry (canonicalSessionName=raw tmux name) — queue dest=canonical form matches → hasAssignedWork=true", () => {
    const softwareTeam = seedSoftwareTeam(db, "my-software-team");
    const n = seedNode(db, softwareTeam, "default.dev");
    // Adopted node: session name is the raw tmux session, NOT the
    // canonical {pod}-{member}@{softwareTeam} form.
    seedSession(db, n, "raw-tmux-name", "running");
    // Operator queues by the canonical form (`SoftwareTeam queue create
    // --destination default-dev@my-softwareTeam`).
    seedPendingQitem(db, "default-dev@my-software-team");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db });
    expect(entry!.canonicalSessionName).toBe("raw-tmux-name");
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("BLOCKING-A2: adopted-style entry — queue dest=raw tmux name still matches (back-compat path)", () => {
    const softwareTeam = seedSoftwareTeam(db, "my-software-team");
    const n = seedNode(db, softwareTeam, "default.dev");
    seedSession(db, n, "raw-tmux-name", "running");
    seedPendingQitem(db, "raw-tmux-name");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("BLOCKING-A2: managed-style entry (canonicalSessionName IS canonical form) — unchanged behavior", () => {
    const softwareTeam = seedSoftwareTeam(db, "my-software-team");
    const n = seedNode(db, softwareTeam, "default.dev");
    seedSession(db, n, "default-dev@my-software-team", "running");
    seedPendingQitem(db, "default-dev@my-software-team");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("BLOCKING-A2: no double-count when canonicalSessionName already equals derived canonical form", () => {
    const softwareTeam = seedSoftwareTeam(db, "my-software-team");
    const n = seedNode(db, softwareTeam, "default.dev");
    seedSession(db, n, "default-dev@my-software-team", "running");
    // ONE pending qitem at the canonical destination — the entry's
    // canonicalSessionName equals the derived canonical form, so
    // looking up by both must not double-count.
    seedPendingQitem(db, "default-dev@my-software-team");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db });
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("BLOCKING-A2: separate queue dests at raw + canonical forms sum correctly (each item counted once)", () => {
    const softwareTeam = seedSoftwareTeam(db, "my-software-team");
    const n = seedNode(db, softwareTeam, "default.dev");
    seedSession(db, n, "raw-tmux-name", "running");
    seedPendingQitem(db, "raw-tmux-name");
    seedPendingQitem(db, "default-dev@my-software-team");
    seedPendingQitem(db, "default-dev@my-software-team");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    // Total = 1 (raw) + 2 (canonical) = 3
    expect(entry!.pendingWorkCount).toBe(3);
  });

  it("BLOCKING-A2: logical IDs with dots are normalized to dashes for canonical form (matches deriveCanonicalSessionName)", () => {
    const softwareTeam = seedSoftwareTeam(db, "softwareteam-velocity");
    const n = seedNode(db, softwareTeam, "redo.driver-2");
    seedSession(db, n, "raw-name-X", "running");
    // The convention is `{pod}-{member}@{softwareTeam}` so logicalId
    // "redo.driver-2" becomes "redo-driver-2".
    seedPendingQitem(db, "redo-driver-2@softwareteam-velocity");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("non-pending qitems do NOT count toward pendingWorkCount", () => {
    const softwareTeam = seedSoftwareTeam(db, "states");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    // pending: counts
    seedPendingQitem(db, "dev@software-team");
    // done: doesn't count
    db.prepare(`
      INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
      VALUES ('q-done', ?, ?, 'op@test', 'dev@software-team', 'done', 'routine', 'routine', 'body')
    `).run(ts, ts);
    // blocked: doesn't count (only 'pending' is unworked-and-claimable)
    db.prepare(`
      INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
      VALUES ('q-blocked', ?, ?, 'op@test', 'dev@software-team', 'blocked', 'routine', 'routine', 'body')
    `).run(ts, ts);

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db });
    expect(entry!.pendingWorkCount).toBe(1);
    expect(entry!.hasAssignedWork).toBe(true);
  });

  it("slice 17 RED specimen — a claimed in-progress row remains assigned without changing pendingWorkCount", () => {
    const softwareTeam = seedSoftwareTeam(db, "claimed");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");
    const qitemId = seedQitem(db, "dev@software-team", "in-progress");
    db.prepare("UPDATE queue_items SET claimed_at = ? WHERE qitem_id = ?")
      .run("2026-08-28 09:24:44", qitemId);

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.assignedWorkCount).toBe(1);
    expect(entry!.pendingWorkCount).toBe(0);
    expect(entry!.inProgressWorkCount).toBe(1);
    expect(entry!.blockedWorkCount).toBe(0);
  });

  it.each([
    ["pending", true, 1, 1, 0, 0],
    ["in-progress", true, 1, 0, 1, 0],
    ["blocked", true, 1, 0, 0, 1],
    ["done", false, 0, 0, 0, 0],
    ["canceled", false, 0, 0, 0, 0],
    ["handed-off", false, 0, 0, 0, 0],
  ] as const)(
    "slice 17 state matrix — %s projects assigned=%s with exact per-state counts",
    (state, hasAssignedWork, assigned, pending, inProgress, blocked) => {
      const softwareTeam = seedSoftwareTeam(db, `matrix-${state}`);
      const n = seedNode(db, softwareTeam, "dev");
      seedSession(db, n, "dev@software-team", "running");
      seedQitem(db, "dev@software-team", state);

      const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db });
      expect(entry!.hasAssignedWork).toBe(hasAssignedWork);
      expect(entry!.assignedWorkCount).toBe(assigned);
      expect(entry!.pendingWorkCount).toBe(pending);
      expect(entry!.inProgressWorkCount).toBe(inProgress);
      expect(entry!.blockedWorkCount).toBe(blocked);
    },
  );

  it("slice 17 mixed-state breakdown keeps pendingWorkCount pending-only and ignores terminal rows", () => {
    const softwareTeam = seedSoftwareTeam(db, "mixed");
    const n = seedNode(db, softwareTeam, "dev");
    seedSession(db, n, "dev@software-team", "running");
    for (const state of ["pending", "pending", "in-progress", "blocked", "done", "canceled", "handed-off"]) {
      seedQitem(db, "dev@software-team", state);
    }

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, softwareTeam), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.assignedWorkCount).toBe(4);
    expect(entry!.pendingWorkCount).toBe(2);
    expect(entry!.inProgressWorkCount).toBe(1);
    expect(entry!.blockedWorkCount).toBe(1);
    expect(countPendingWorkForSession(db, "dev@software-team")).toBe(2);
  });

  it("slice 17 batch and per-session computation sites return identical state counts", () => {
    for (const state of ["pending", "pending", "in-progress", "blocked", "done"]) {
      seedQitem(db, "dev@software-team", state);
    }

    expect(readAssignedWorkBySession(db).get("dev@software-team")).toEqual(
      countAssignedWorkForSession(db, "dev@software-team"),
    );
  });
});
