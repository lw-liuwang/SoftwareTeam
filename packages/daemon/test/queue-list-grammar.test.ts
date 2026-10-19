import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { QueueRepository } from "../src/domain/queue-repository.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS queue_items (
    qitem_id TEXT PRIMARY KEY,
    ts_created TEXT NOT NULL,
    ts_updated TEXT NOT NULL,
    source_session TEXT NOT NULL,
    destination_session TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'normal',
    tier TEXT,
    tags TEXT,
    blocked_on TEXT,
    handed_off_to TEXT,
    handed_off_from TEXT,
    expires_at TEXT,
    chain_of_record TEXT,
    body TEXT NOT NULL DEFAULT '',
    closure_reason TEXT,
    closure_target TEXT,
    closure_required_at TEXT,
    claimed_at TEXT,
    last_nudge_attempt TEXT,
    last_nudge_result TEXT,
    last_heartbeat TEXT,
    resolution TEXT,
    target_repo TEXT
  )`);
  return db;
}

function seed(db: Database.Database, id: string, opts: {
  source: string;
  destination: string;
  state?: string;
  body?: string;
  tags?: string[];
  tsCreated?: string;
  closureReason?: string;
  closureTarget?: string;
  handedOffFrom?: string;
}) {
  const ts = opts.tsCreated ?? new Date().toISOString();
  db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, tags, chain_of_record, closure_reason, closure_target, handed_off_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, ts, ts, opts.source, opts.destination,
    opts.state ?? "pending",
    opts.body ?? `Body of ${id}. `.repeat(20),
    opts.tags ? JSON.stringify(opts.tags) : null,
    JSON.stringify([`chain-${id}`]),
    opts.closureReason ?? null,
    opts.closureTarget ?? null,
    opts.handedOffFrom ?? null,
  );
}

describe("OPR.0.4.0.32 — queue list grammar revision", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new QueueRepository(db);
  });
  afterEach(() => { db.close(); });

  // -- AC-2: current-SoftwareTeam scope covers source OR destination --
  it("AC-2: SoftwareTeam scope surfaces items where SoftwareTeam is source OR destination", () => {
    seed(db, "q-dest", { source: "seat-a@other-software-team", destination: "seat-b@demo-software-team", state: "pending" });
    seed(db, "q-src", { source: "seat-c@demo-software-team", destination: "seat-d@other-software-team", state: "in-progress" });
    seed(db, "q-unrelated", { source: "seat-e@unrelated", destination: "seat-f@unrelated", state: "pending" });

    const items = repo.list({ softwareTeam: "demo-software-team", activeOnly: true });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-dest");
    expect(ids).toContain("q-src");
    expect(ids).not.toContain("q-unrelated");
  });

  it("AC-2: SoftwareTeam suffix match is end-anchored (no over-match on prefix)", () => {
    seed(db, "q-demo", { source: "a@demo", destination: "b@demo", state: "pending" });
    seed(db, "q-demo-2", { source: "a@demo-2", destination: "b@demo-2", state: "pending" });

    const items = repo.list({ softwareTeam: "demo", activeOnly: true });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-demo");
    expect(ids).not.toContain("q-demo-2");
  });

  // -- AC-2b: active set + handoff discriminator --
  it("AC-2b: default active set = pending/in-progress/blocked only", () => {
    seed(db, "q-pending", { source: "a@software-team", destination: "b@software-team", state: "pending" });
    seed(db, "q-inprog", { source: "a@software-team", destination: "b@software-team", state: "in-progress" });
    seed(db, "q-blocked", { source: "a@software-team", destination: "b@software-team", state: "blocked" });
    seed(db, "q-done", { source: "a@software-team", destination: "b@software-team", state: "done" });
    seed(db, "q-canceled", { source: "a@software-team", destination: "b@software-team", state: "canceled" });
    seed(db, "q-handedoff", { source: "a@software-team", destination: "b@software-team", state: "handed-off" });
    seed(db, "q-failed", { source: "a@software-team", destination: "b@software-team", state: "failed" });
    seed(db, "q-denied", { source: "a@software-team", destination: "b@software-team", state: "denied" });

    const items = repo.list({ softwareTeam: "softwareTeam", activeOnly: true });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-pending");
    expect(ids).toContain("q-inprog");
    expect(ids).toContain("q-blocked");
    expect(ids).not.toContain("q-done");
    expect(ids).not.toContain("q-canceled");
    expect(ids).not.toContain("q-handedoff");
    expect(ids).not.toContain("q-failed");
    expect(ids).not.toContain("q-denied");
  });

  it("AC-2b: handoff discriminator — bare list shows pending child, not handed-off source", () => {
    seed(db, "q-source-handedoff", {
      source: "driver@demo-software-team",
      destination: "guard@demo-software-team",
      state: "handed-off",
      closureReason: "handed_off_to",
      closureTarget: "qa@demo-software-team",
      tsCreated: "2026-06-19T00:00:00.000Z",
    });
    seed(db, "q-child-pending", {
      source: "guard@demo-software-team",
      destination: "qa@demo-software-team",
      state: "pending",
      handedOffFrom: "q-source-handedoff",
      tsCreated: "2026-06-19T00:01:00.000Z",
    });

    const active = repo.list({ softwareTeam: "demo-software-team", activeOnly: true });
    const activeIds = active.map((i) => i.qitemId);
    expect(activeIds).toContain("q-child-pending");
    expect(activeIds).not.toContain("q-source-handedoff");

    const withHistory = repo.list({ softwareTeam: "demo-software-team", activeOnly: false });
    const historyIds = withHistory.map((i) => i.qitemId);
    expect(historyIds).toContain("q-child-pending");
    expect(historyIds).toContain("q-source-handedoff");
  });

  // -- AC-3: compact json excludes body/chain --
  it("AC-3: compact excludes body and chainOfRecord", () => {
    seed(db, "q-1", { source: "a@software-team", destination: "b@software-team", body: "Big body here" });
    const compact = repo.list({ compact: true });
    expect(compact[0]!).not.toHaveProperty("body");
    expect(compact[0]!).not.toHaveProperty("chainOfRecord");
  });

  // -- AC-4: axes compose --
  it("AC-4: softwareTeam + activeOnly=false includes history within softwareTeam", () => {
    seed(db, "q-active", { source: "a@demo-software-team", destination: "b@demo-software-team", state: "pending" });
    seed(db, "q-done", { source: "a@demo-software-team", destination: "b@demo-software-team", state: "done" });
    seed(db, "q-other", { source: "a@other", destination: "b@other", state: "done" });

    const items = repo.list({ softwareTeam: "demo-software-team", activeOnly: false });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-active");
    expect(ids).toContain("q-done");
    expect(ids).not.toContain("q-other");
  });

  it("AC-4: no softwareTeam + activeOnly = cross-software-team active", () => {
    seed(db, "q-a", { source: "a@software-team-1", destination: "b@software-team-1", state: "pending" });
    seed(db, "q-b", { source: "a@software-team-2", destination: "b@software-team-2", state: "in-progress" });
    seed(db, "q-done", { source: "a@software-team-1", destination: "b@software-team-1", state: "done" });

    const items = repo.list({ activeOnly: true });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-a");
    expect(ids).toContain("q-b");
    expect(ids).not.toContain("q-done");
  });

  // -- AC-5: daemon back-compat (no new params = today's full behavior) --
  it("AC-5: no new params = full unscoped list (back-compat)", () => {
    seed(db, "q-1", { source: "a@software-team", destination: "b@software-team", state: "done", body: "Full body" });
    const items = repo.list({});
    expect(items[0]!.body).toBe("Full body");
    expect(items[0]!.chainOfRecord).toBeDefined();
  });

  // -- asSession (--mine) still works --
  it("asSession (--mine) scopes to caller's items", () => {
    seed(db, "q-mine", { source: "me@software-team", destination: "other@software-team", state: "pending" });
    seed(db, "q-not-mine", { source: "x@software-team", destination: "y@software-team", state: "pending" });

    const items = repo.list({ asSession: "me@software-team", activeOnly: true });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-mine");
    expect(ids).not.toContain("q-not-mine");
  });
});
