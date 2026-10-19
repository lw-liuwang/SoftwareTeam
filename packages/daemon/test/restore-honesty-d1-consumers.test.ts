// OPR.0.5.7.1 — D1 CONSUMER ALIGNMENT (R2 HOLD repair; territory ruling on
// qitem-20260829091346-bfdaaca8). Execution resolves the active occupant from
// SnapshotData.activeSessionIdByNode; these tests pin the SAME occupant truth
// onto the three reporting consumers that still select historical rows
// independently: restore-plan preview (max-ULID reduce), snapshot usability
// (any-historical-token), and lifecycle recoverability (first-row find).
//
// Ruled broken-relation vocabulary: intendedAction "awaiting-decision",
// freshRequired false (--fresh cannot override A1 ambiguity), a reason naming
// the relation failure, token truth derived from NO resolved occupant — never
// from a historical row.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { findLatestUsableSnapshot } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../src/domain/restore-plan-preview.js";
import { deriveNodeLifecycleState } from "../src/domain/node-inventory.js";
import type { Snapshot, SnapshotData, Session } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

// ULIDs where lexical order is the trap: OLD sorts before NEW, so the retired
// "latest = max id" selection picks NEW.
const ULID_OLD = "01ARZ3NDEKTSV4RRFFQ69G5AAA";
const ULID_NEW = "01ARZ3NDEKTSV4RRFFQ69G5ZZZ";
const ULID_GONE = "01ARZ3NDEKTSV4RRFFQ69G5XXX";

type FixtureRow = { id: string; status: string; token: string | null; type?: string | null };

function sessionRow(nodeId: string, r: FixtureRow): Session {
  return {
    id: r.id,
    nodeId,
    sessionName: "r77-seat",
    status: r.status,
    resumeType: r.type === undefined ? "claude_name" : r.type,
    resumeToken: r.token,
    restorePolicy: "resume_if_possible",
    lastSeenAt: null,
    createdAt: "2026-08-29 00:00:00",
    origin: "launched",
    startupStatus: "ready",
    startupCompletedAt: null,
  } as Session;
}

type RelationMode =
  | { mode: "field-absent" }
  | { mode: "explicit-null" }
  | { mode: "missing-node-key" }
  | { mode: "explicit-id"; id: string }
  | { mode: "dangling-id"; id: string };

function snapshotData(softwareTeamId: string, nodeId: string, rows: FixtureRow[], relation: RelationMode, softwareTeam: { softwareTeam: unknown; nodes: unknown[]; edges: unknown[] }): SnapshotData {
  const data: SnapshotData = {
    softwareTeam: softwareTeam.softwareTeam as SnapshotData["softwareTeam"],
    nodes: softwareTeam.nodes as SnapshotData["nodes"],
    edges: softwareTeam.edges as SnapshotData["edges"],
    sessions: rows.map((r) => sessionRow(nodeId, r)),
    checkpoints: {},
  };
  switch (relation.mode) {
    case "field-absent":
      break;
    case "explicit-null":
      data.activeSessionIdByNode = { [nodeId]: null };
      break;
    case "missing-node-key":
      data.activeSessionIdByNode = { "some-other-node": null };
      break;
    case "explicit-id":
    case "dangling-id":
      data.activeSessionIdByNode = { [nodeId]: relation.id };
      break;
  }
  return data;
}

describe("OPR.0.5.7.1 — D1 consumer alignment (preview / usability / lifecycle)", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotCapture: SnapshotCapture;
  let snapshotRepo: SnapshotRepository;

  beforeEach(() => {
    db = createFullTestDb();
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, softwareTeamRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => {
    db.close();
  });

  function seedSoftwareTeam() {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("r77");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "seat", { role: "worker", runtime: "claude-code" });
    const softwareTeamW = softwareTeamRepo.getSoftwareTeam(softwareTeam.id)!;
    return { softwareTeamId: softwareTeam.id, nodeId: node.id, softwareTeamW };
  }

  function makeSnapshot(softwareTeamId: string, data: SnapshotData): Snapshot {
    return { id: "snap-test-1", softwareTeamId, kind: "manual", status: "ok", data, createdAt: "2026-08-29 00:00:00" };
  }

  function previewNode(softwareTeamW: ReturnType<SoftwareTeamRepository["getSoftwareTeam"]> & object, snapshot: Snapshot | null, freshLogicalIds?: string[]) {
    const rows = collectPreviewSessionRows(db, softwareTeamW as never, snapshot);
    const plan = buildRestorePlanPreview(softwareTeamW as never, snapshot, rows, freshLogicalIds);
    const node = plan.nodes.find((n) => n.logicalId === "seat");
    expect(node).toBeDefined();
    return node!;
  }

  // ------------------------------------------------------------ preview ---

  it("R-A: the explicit relation selects the older ACTIVE row over a newer superseded tokenless row — action AND token state (incident order: newer row first)", () => {
    const { softwareTeamId, nodeId, softwareTeamW } = seedSoftwareTeam();
    const data = snapshotData(softwareTeamId, nodeId, [
      { id: ULID_NEW, status: "superseded", token: null },      // newer, first in array
      { id: ULID_OLD, status: "running", token: "tok-active" }, // the occupant
    ], { mode: "explicit-id", id: ULID_OLD }, softwareTeamW as never);
    const node = previewNode(softwareTeamW, makeSnapshot(softwareTeamId, data));
    // base: max-ULID reduce picks the newer tokenless row → awaiting-decision + missing
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified"); // the OCCUPANT's token truth, never the historical row's
    expect(node.freshRequired).toBe(false);
  });

  it.each([
    ["explicit-null", { mode: "explicit-null" } as RelationMode],
    ["missing-node-key", { mode: "missing-node-key" } as RelationMode],
    ["dangling-id", { mode: "dangling-id", id: ULID_GONE } as RelationMode],
  ])("R-B (%s): a broken authoritative relation renders awaiting-decision, freshRequired=false, reason names the relation — and --fresh cannot override it", (_label, relation) => {
    const { softwareTeamId, nodeId, softwareTeamW } = seedSoftwareTeam();
    const data = snapshotData(softwareTeamId, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-live" },
    ], relation, softwareTeamW as never);
    for (const fresh of [undefined, ["seat"]]) {
      const node = previewNode(softwareTeamW, makeSnapshot(softwareTeamId, data), fresh);
      // base: without --fresh the reduce resumes the historical row; with
      // --fresh it short-circuits to fresh-primed. Both are the defect.
      expect(node.intendedAction).toBe("awaiting-decision");
      expect(node.freshRequired).toBe(false);
      expect(node.reason ?? "").toMatch(/relation|occupant/i);
      // token truth derives from NO resolved occupant — never the historical row
      expect(node.tokenState).toBe("missing");
    }
  });

  // ---------------------------------------------------------- lifecycle ---

  it("R-C: lifecycle recoverability follows the explicitly related ACTIVE row even when it is not first in the session array", () => {
    const { softwareTeamId, nodeId, softwareTeamW } = seedSoftwareTeam();
    const data = snapshotData(softwareTeamId, nodeId, [
      { id: ULID_NEW, status: "superseded", token: null }, // first row, no token
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "explicit-id", id: ULID_OLD }, softwareTeamW as never);
    const state = deriveNodeLifecycleState({
      sessionStatus: "exited",
      restoreOutcome: "n-a",
      nodeId,
      usableSnapshot: makeSnapshot(softwareTeamId, data),
    });
    // base: first-row .find sees no token → detached
    expect(state).toBe("recoverable");
  });

  // ---------------------------------------------------------- usability ---

  it("R-D: present-null with a historical token is NOT usable and NOT recoverable", () => {
    const { softwareTeamId, nodeId, softwareTeamW } = seedSoftwareTeam();
    const data = snapshotData(softwareTeamId, nodeId, [
      { id: ULID_OLD, status: "exited", token: "tok-historical" },
    ], { mode: "explicit-null" }, softwareTeamW as never);
    db.prepare("INSERT INTO snapshots (id, software_team_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
      .run("snap-null-1", softwareTeamId, "manual", "ok", JSON.stringify(data));
    // base: any-historical-token predicate reads this snapshot as usable
    expect(findLatestUsableSnapshot(db, softwareTeamId)).toBeNull();
    const state = deriveNodeLifecycleState({
      sessionStatus: "exited",
      restoreOutcome: "n-a",
      nodeId,
      usableSnapshot: makeSnapshot(softwareTeamId, data),
    });
    expect(state).not.toBe("recoverable");
  });

  // --------------------------------------------- live no-snapshot parity ---

  it("R-E1: live preview (no snapshot) selects the exactly-one-RUNNING row as the occupant, not the newest row", () => {
    const { softwareTeamW, nodeId } = seedSoftwareTeam();
    const s1 = sessionRegistry.registerSession(nodeId, "r77-seat");
    sessionRegistry.updateStatus(s1.id, "running");
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-active' WHERE id = ?").run(s1.id);
    const s2 = sessionRegistry.registerSession(nodeId, "r77-seat-v2"); // newer ULID, status unknown, no token
    expect(s2.id > s1.id).toBe(true);
    const node = previewNode(softwareTeamW, null);
    // base: the live SELECT carries no status; the reduce picks the newer
    // tokenless row → fresh-primed/missing
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified");
  });

  it("R-E2: live preview with SEVERAL running rows is explicit-null ambiguity — awaiting-decision, freshRequired=false (capture parity)", () => {
    const { softwareTeamW, nodeId } = seedSoftwareTeam();
    const s1 = sessionRegistry.registerSession(nodeId, "r77-seat");
    const s2 = sessionRegistry.registerSession(nodeId, "r77-seat-v2");
    sessionRegistry.updateStatus(s1.id, "running");
    sessionRegistry.updateStatus(s2.id, "running");
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-a' WHERE id = ?").run(s1.id);
    const node = previewNode(softwareTeamW, null);
    expect(node.intendedAction).toBe("awaiting-decision");
    expect(node.freshRequired).toBe(false);
    expect(node.tokenState).toBe("missing");
  });

  it("R-E2b: live preview with ZERO running rows is explicit-null ambiguity — a historical token is never borrowed, and --fresh cannot override", () => {
    const { softwareTeamW, nodeId } = seedSoftwareTeam();
    const s1 = sessionRegistry.registerSession(nodeId, "r77-seat");
    const s2 = sessionRegistry.registerSession(nodeId, "r77-seat-v2");
    // none running; the older historical row carries a token so the assertion
    // below proves token truth is NOT borrowed from a non-occupant row.
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-historical' WHERE id = ?").run(s1.id);
    for (const fresh of [undefined, ["seat"]]) {
      const node = previewNode(softwareTeamW, null, fresh);
      expect(node.intendedAction).toBe("awaiting-decision");
      expect(node.freshRequired).toBe(false);
      expect(node.tokenState).toBe("missing");
      expect(node.reason ?? "").toMatch(/relation|occupant/i);
    }
  });

  it("R-E3 parity floor: preview over the CAPTURED snapshot and preview over the same live state agree per node", () => {
    const { softwareTeamId, softwareTeamW, nodeId } = seedSoftwareTeam();
    const s1 = sessionRegistry.registerSession(nodeId, "r77-seat");
    sessionRegistry.updateStatus(s1.id, "running");
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-active' WHERE id = ?").run(s1.id);
    const snap = snapshotCapture.captureSnapshot(softwareTeamId, "manual");
    const live = previewNode(softwareTeamW, null);
    const fromSnapshot = previewNode(softwareTeamW, snapshotRepo.getSnapshot(snap.id)!);
    expect(live.intendedAction).toBe(fromSnapshot.intendedAction);
    expect(live.tokenState).toBe(fromSnapshot.tokenState);
    expect(live.freshRequired).toBe(fromSnapshot.freshRequired);
  });

  // -------------------------------------------------------- legacy floor ---

  it("R-F1 floor: whole-field-absent legacy snapshot with a SINGLE row previews from that row (legacy inference intact)", () => {
    const { softwareTeamId, nodeId, softwareTeamW } = seedSoftwareTeam();
    const data = snapshotData(softwareTeamId, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "field-absent" }, softwareTeamW as never);
    const node = previewNode(softwareTeamW, makeSnapshot(softwareTeamId, data));
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified");
  });

  it("R-F2 alignment: whole-field-absent legacy snapshot with several rows previews from the UNIQUELY-RUNNING row, never the newest ULID", () => {
    // Honest RED note: at base this leg fails — the preview reduce is the very
    // divergence under repair. It is titled alignment, not floor.
    const { softwareTeamId, nodeId, softwareTeamW } = seedSoftwareTeam();
    const data = snapshotData(softwareTeamId, nodeId, [
      { id: ULID_NEW, status: "superseded", token: null },
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "field-absent" }, softwareTeamW as never);
    const node = previewNode(softwareTeamW, makeSnapshot(softwareTeamId, data));
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified");
  });
});
