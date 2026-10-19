import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { readCrashCartDiscovery } from "../src/domain/crash-cart-discovery.js";

// Crash-cart C2 read-model — reproduce the daemon's discovery facts from the (copied) DB with the
// daemon DOWN. Seeded from the CANONICAL ALL_MIGRATIONS (schema parity, not a hand-copied subset).
// Two facts are honest-null by construction (no persisted substrate exists daemon-down): the header
// stop-reason / prior-uptime (there is NO shutdown record anywhere) — surfaced null, never fabricated.

let db: BetterSqlite3.Database;
beforeEach(() => {
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
});
afterEach(() => db.close());

function seedSoftwareTeam(softwareTeamId: string, name: string) {
  db.prepare("INSERT INTO software_teams (id, name) VALUES (?, ?)").run(softwareTeamId, name);
}
function seedNode(nodeId: string, softwareTeamId: string, logicalId: string) {
  db.prepare("INSERT INTO nodes (id, software_team_id, logical_id) VALUES (?, ?, ?)").run(nodeId, softwareTeamId, logicalId);
}
function seedSession(over: {
  id: string;
  nodeId: string;
  name: string;
  status?: string;
  lastSeenAt?: string;
  createdAt?: string;
  probe?: string | null;
  resumeToken?: string | null;
}) {
  db.prepare(
    `INSERT INTO sessions (id, node_id, session_name, status, last_seen_at, created_at, resume_last_probe_status, resume_token)
     VALUES (@id, @nodeId, @name, @status, @lastSeenAt, @createdAt, @probe, @resumeToken)`,
  ).run({
    status: "unknown",
    lastSeenAt: null,
    // Pin created_at to a fixed OLD value so the default datetime('now') never pollutes the
    // header's last-activity union with wall-clock (deterministic tests).
    createdAt: "2000-01-01T00:00:00Z",
    probe: null,
    resumeToken: null,
    ...over,
  });
}

describe("readCrashCartDiscovery — FOUND ON THIS HOST", () => {
  it("reports per-software-team seat count, running count, resumable count, and last-active", () => {
    seedSoftwareTeam("r1", "alpha");
    seedNode("n1", "r1", "worker");
    seedNode("n2", "r1", "guard");
    // n1: latest session running + resumable (probe=resumable); n2: stopped, not resumable.
    seedSession({ id: "01A", nodeId: "n1", name: "worker@alpha", status: "running", lastSeenAt: "2026-08-06T07:00:00Z", probe: "resumable", resumeToken: "tok" });
    seedSession({ id: "01B", nodeId: "n2", name: "guard@alpha", status: "stopped", lastSeenAt: "2026-08-06T06:00:00Z", probe: "not_resumable" });

    const { foundOnHost } = readCrashCartDiscovery(db);
    expect(foundOnHost).toHaveLength(1);
    const softwareTeam = foundOnHost[0];
    expect(softwareTeam.softwareTeamId).toBe("r1");
    expect(softwareTeam.softwareTeamName).toBe("alpha");
    expect(softwareTeam.seatCount).toBe(2);
    expect(softwareTeam.runningCount).toBe(1);
    expect(softwareTeam.resumableCount).toBe(1);
    expect(softwareTeam.lastActiveAt).toBe("2026-08-06T07:00:00Z");
  });

  it("uses only the LATEST session per node (max ULID id) for status/resumable", () => {
    seedSoftwareTeam("r1", "alpha");
    seedNode("n1", "r1", "worker");
    // older running+resumable, newer stopped+not — latest wins ⇒ not running, not resumable.
    seedSession({ id: "01A", nodeId: "n1", name: "w@a", status: "running", probe: "resumable", resumeToken: "t" });
    seedSession({ id: "01Z", nodeId: "n1", name: "w@a", status: "stopped", probe: "not_resumable" });
    const { foundOnHost } = readCrashCartDiscovery(db);
    expect(foundOnHost[0].runningCount).toBe(0);
    expect(foundOnHost[0].resumableCount).toBe(0);
  });

  it("excludes archived softwareTeams", () => {
    seedSoftwareTeam("r1", "alpha");
    seedSoftwareTeam("r2", "beta");
    db.prepare("UPDATE software_teams SET archived_at = ? WHERE id = 'r2'").run("2026-08-06T00:00:00Z");
    const { foundOnHost } = readCrashCartDiscovery(db);
    expect(foundOnHost.map((r) => r.softwareTeamId)).toEqual(["r1"]);
  });
});

describe("readCrashCartDiscovery — WHERE WORK STOPPED (in-progress queue, display-only)", () => {
  it("lists only in-progress queue items with owner + claimed_at, newest first", () => {
    const ins = db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, claimed_at)
       VALUES (@id, @c, @u, @src, @dst, @state, @body, @claimed)`,
    );
    ins.run({ id: "q1", c: "t0", u: "2026-08-06T05:00:00Z", src: "orch@r", dst: "worker@alpha", state: "in-progress", body: "build X", claimed: "2026-08-06T05:00:00Z" });
    ins.run({ id: "q2", c: "t0", u: "2026-08-06T06:00:00Z", src: "orch@r", dst: "guard@alpha", state: "in-progress", body: "review Y", claimed: "2026-08-06T06:00:00Z" });
    ins.run({ id: "q3", c: "t0", u: "t9", src: "orch@r", dst: "worker@alpha", state: "done", body: "old", claimed: null });
    ins.run({ id: "q4", c: "t0", u: "t9", src: "orch@r", dst: "worker@alpha", state: "pending", body: "future", claimed: null });

    const { whereWorkStopped } = readCrashCartDiscovery(db);
    expect(whereWorkStopped.map((w) => w.qitemId)).toEqual(["q2", "q1"]); // newest ts_updated first, in-progress only
    expect(whereWorkStopped[0]).toMatchObject({ destinationSession: "guard@alpha", state: "in-progress", claimedAt: "2026-08-06T06:00:00Z" });
  });
});

describe("readCrashCartDiscovery — HEADER (derived; honest-null for the unrecoverable)", () => {
  it("derives last-activity from the newest write-timestamp and exposes boot times; stop-reason + prior-uptime are honest-null", () => {
    db.prepare(
      "INSERT INTO self_host_identity (singleton, host_id, minted_at, reconciled_at) VALUES (1, ?, ?, ?)",
    ).run("host-A", "2026-08-01T00:00:00Z", "2026-08-06T04:00:00Z");
    seedSoftwareTeam("r1", "alpha");
    seedNode("n1", "r1", "worker");
    seedSession({ id: "01A", nodeId: "n1", name: "w@a", status: "running", lastSeenAt: "2026-08-06T07:30:00Z" });

    const { header } = readCrashCartDiscovery(db);
    expect(header.lastActivityAt).toBe("2026-08-06T07:30:00Z"); // newest across write-timestamps
    expect(header.lastBootAt).toBe("2026-08-06T04:00:00Z");
    expect(header.firstBootAt).toBe("2026-08-01T00:00:00Z");
    expect(header.hostId).toBe("host-A");
    // Load-bearing gap (flagged): no persisted shutdown record exists → never fabricated.
    expect(header.stopReason).toBeNull();
    expect(header.priorUptimeMs).toBeNull();
  });

  it("is honest-null across the header when the DB is empty (no fabrication)", () => {
    const { header, foundOnHost, whereWorkStopped } = readCrashCartDiscovery(db);
    expect(header).toEqual({
      lastActivityAt: null,
      lastBootAt: null,
      firstBootAt: null,
      hostId: null,
      stopReason: null,
      priorUptimeMs: null,
    });
    expect(foundOnHost).toEqual([]);
    expect(whereWorkStopped).toEqual([]);
  });
});
