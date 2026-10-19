// Slice 15 — SeatActivityService unit tests (TDD).
//
// The service is the daemon's owner of the `terminal-active` primitive.
// It polls tmux's per-pane silence flag at a configurable cadence and
// keeps the latest observation in memory keyed by canonical session
// name. Downstream consumers (ps-projection, node-inventory, UI hooks
// via the event stream) read through the service. The service does NOT
// touch queue/assignment state — that's the non-inference contract.

import { describe, it, expect, vi } from "vitest";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Slice 15 — tmux adapter mock keyed by canonical session name.
// Map value: Unix epoch seconds of last activity (number), or null to
// simulate "no signal" (target missing or blank tmux output, e.g.
// tmux 3.6a behavior observed by velocity-qa).
function makeTmuxAdapter(
  lastActivityBySession: Record<string, number | null>,
): TmuxAdapter {
  return {
    readPaneLastActivity: vi.fn(async (paneId: string) => {
      return Object.prototype.hasOwnProperty.call(lastActivityBySession, paneId)
        ? lastActivityBySession[paneId]!
        : null;
    }),
  } as unknown as TmuxAdapter;
}

const FIXED_NOW = new Date("2026-05-16T10:00:00.000Z");
const FIXED_NOW_EPOCH = FIXED_NOW.getTime() / 1000;

describe("SeatActivityService", () => {
  it("pollSeat records ACTIVE observation when window_activity is within the silence window", async () => {
    // Activity 1s ago, window 3s → active
    const tmux = makeTmuxAdapter({ "claude@software-team": FIXED_NOW_EPOCH - 1 });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    const observed = await svc.pollSeat("claude@software-team");

    expect(observed).not.toBeNull();
    expect(observed!.paneId).toBe("claude@software-team");
    expect(observed!.isActiveWithinWindow).toBe(true);
    expect(observed!.silenceWindowSeconds).toBe(3);
    expect(observed!.lastObservedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("pollSeat records IDLE observation when window_activity is older than the silence window", async () => {
    // Activity 10s ago, window 5s → idle (10s ≥ 5s)
    const tmux = makeTmuxAdapter({ "claude@software-team": FIXED_NOW_EPOCH - 10 });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 5, now: () => FIXED_NOW });

    const observed = await svc.pollSeat("claude@software-team");

    expect(observed!.isActiveWithinWindow).toBe(false);
    expect(observed!.silenceWindowSeconds).toBe(5);
  });

  it("HG-7 DISCRIMINATOR — same activity timestamp, different window: window=3 → idle; window=20 → active", async () => {
    // Last activity 10s ago. With a 3s window: idle. With a 20s window: active.
    const tmux = makeTmuxAdapter({ "claude@software-team": FIXED_NOW_EPOCH - 10 });
    const tight = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });
    const loose = new SeatActivityService({ tmux, defaultWindowSeconds: 20, now: () => FIXED_NOW });

    const tightObs = await tight.pollSeat("claude@software-team");
    const looseObs = await loose.pollSeat("claude@software-team");

    expect(tightObs!.isActiveWithinWindow).toBe(false); // 10s > 3s
    expect(looseObs!.isActiveWithinWindow).toBe(true);  // 10s < 20s
  });

  it("pollSeat returns null when tmux read returns null (no observation; consumer treats as 'unknown')", async () => {
    const tmux = makeTmuxAdapter({ "claude@software-team": null });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    expect(await svc.pollSeat("claude@software-team")).toBeNull();
  });

  it("getSeatActivity returns the latest stored observation for a seat", async () => {
    const tmux = makeTmuxAdapter({ "claude@software-team": FIXED_NOW_EPOCH });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    expect(svc.getSeatActivity("claude@software-team")).toBeNull();
    await svc.pollSeat("claude@software-team");

    const stored = svc.getSeatActivity("claude@software-team");
    expect(stored).not.toBeNull();
    expect(stored!.isActiveWithinWindow).toBe(true);
  });

  it("getSeatActivity is keyed per-seat; observations don't leak across seats", async () => {
    // a is idle (60s old), b is active (current)
    const tmux = makeTmuxAdapter({
      "a@software-team": FIXED_NOW_EPOCH - 60,
      "b@software-team": FIXED_NOW_EPOCH,
    });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    await svc.pollSeat("a@software-team");
    await svc.pollSeat("b@software-team");

    expect(svc.getSeatActivity("a@software-team")!.isActiveWithinWindow).toBe(false);
    expect(svc.getSeatActivity("b@software-team")!.isActiveWithinWindow).toBe(true);
  });

  it("pollSeat with a per-seat override honors the override; default is the fallback", async () => {
    // Activity 5s ago. Default window 3s → idle. Override 10s → active.
    const tmux = makeTmuxAdapter({ "claude@software-team": FIXED_NOW_EPOCH - 5 });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    const observed = await svc.pollSeat("claude@software-team", { silenceWindowSeconds: 10 });
    expect(observed!.silenceWindowSeconds).toBe(10);
    expect(observed!.isActiveWithinWindow).toBe(true); // 5s < 10s

    const observed2 = await svc.pollSeat("claude@software-team"); // no override → default 3s
    expect(observed2!.silenceWindowSeconds).toBe(3);
    expect(observed2!.isActiveWithinWindow).toBe(false); // 5s > 3s
  });

  it("absorbs tmux errors so polling failures never crash the daemon loop", async () => {
    const tmux = {
      readPaneLastActivity: vi.fn(async () => {
        throw new Error("tmux gone");
      }),
    } as unknown as TmuxAdapter;
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    await expect(svc.pollSeat("claude@software-team")).resolves.toBeNull();
  });

  // Slice 15 non-inference contract (HG-4 partial): the service has no
  // input port for queue/assignment state. Even at the type level, the
  // constructor must NOT accept a queue repo / projection. If a future
  // contributor reaches for queue data here, this constructor-shape
  // test fails compile, surfacing the regression.
  it("HG-4 partial — constructor surface depends only on tmux + cadence (no queue/assignment input)", () => {
    const tmux = makeTmuxAdapter({});
    // The constructor only accepts `tmux` + `defaultWindowSeconds` (+ optional bus).
    // If we tried to pass any queue/assignment-shaped dep the compile fails.
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });
    expect(svc).toBeDefined();
  });

  // ── ARCH RULING 3a947fb1 (pulse PARKED-WITH-BATON owner idle-age): pollSeat
  // ── already reads the RAW window_activity epoch to derive active/idle, then
  // ── discards it. FR-7 additive — surface it as `lastActivityAt` (ISO) on the
  // ── record. RAW fact, never clamped (C2); ONE field, no ageSeconds sibling
  // ── (C3 — age is a renderer-side VIEW = f(fact, reader-clock)).
  describe("lastActivityAt — raw window_activity fact (arch 3a947fb1)", () => {
    it("stamps the RAW activity epoch as ISO — distinct from lastObservedAt (observation time)", async () => {
      // Activity 10s before the observation clock.
      const tmux = makeTmuxAdapter({ "claude@software-team": FIXED_NOW_EPOCH - 10 });
      const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

      const observed = await svc.pollSeat("claude@software-team");

      // The fact is the tmux activity TIME, not when we observed it.
      expect(observed!.lastActivityAt).toBe(new Date((FIXED_NOW_EPOCH - 10) * 1000).toISOString());
      expect(observed!.lastObservedAt).toBe(FIXED_NOW.toISOString());
      expect(observed!.lastActivityAt).not.toBe(observed!.lastObservedAt);
    });

    it("C2 raw fact, NO clamping — skew putting activity AHEAD of the observation clock is preserved, not floored", async () => {
      // Clock skew: tmux reports activity 5s in the (near) future vs our clock.
      const tmux = makeTmuxAdapter({ "claude@software-team": FIXED_NOW_EPOCH + 5 });
      const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

      const observed = await svc.pollSeat("claude@software-team");

      // Surfaced verbatim — AHEAD of lastObservedAt. The projection never
      // clamps/floors; renderers clamp for display only.
      expect(observed!.lastActivityAt).toBe(new Date((FIXED_NOW_EPOCH + 5) * 1000).toISOString());
      expect(Date.parse(observed!.lastActivityAt)).toBeGreaterThan(Date.parse(observed!.lastObservedAt));
    });

    it("C1 absent-when-no-signal — a null tmux read yields NO record (the fact is absent, never fabricated)", async () => {
      const tmux = makeTmuxAdapter({ "claude@software-team": null });
      const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

      expect(await svc.pollSeat("claude@software-team")).toBeNull();
      expect(svc.getSeatActivity("claude@software-team")).toBeNull(); // no record ⟹ no lastActivityAt
    });
  });

  describe("pollAllRunningTmuxSeats", () => {
    // Uses the same DB schema the daemon uses — pick up the test-app
    // helper that provisions an in-memory daemon DB with all migrations.
    async function makeDb() {
      const { createFullTestDb } = await import("./helpers/test-app.js");
      return createFullTestDb();
    }

    it("SINGLE-FLIGHT: a whole sweep started while another is in flight adds NO overlapping reads (mirrors seat-structural-activity-service MUST-FIX 2)", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO software_teams (id, name) VALUES ('r1', 'software-team-a')").run();
        db.prepare("INSERT INTO nodes (id, software_team_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        db.prepare("INSERT INTO nodes (id, software_team_id, logical_id) VALUES ('n2', 'r1', 'qa')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)").run("s1", "n1", "dev@software-team", "running", ts);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)").run("s2", "n2", "qa@software-team", "running", ts);

        // Gate the per-seat read so the FIRST sweep stays in flight while we fire a second.
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        let reads = 0;
        const tmux = {
          readPaneLastActivity: vi.fn(async () => { reads += 1; await gate; return FIXED_NOW_EPOCH - 1; }),
        } as unknown as TmuxAdapter;
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

        const sweep1 = svc.pollAllRunningTmuxSeats(db);       // starts; issues both reads, both hold on the gate
        await new Promise((r) => setTimeout(r, 0));           // flush so sweep1's reads are issued
        expect(reads).toBe(2);                                // sweep1 is in flight, holding two reads

        const sweep2 = svc.pollAllRunningTmuxSeats(db);       // must be single-flight while sweep1 holds
        await new Promise((r) => setTimeout(r, 0));           // give sweep2 a tick to do whatever it will
        expect(reads).toBe(2);                                // WITHOUT the guard sweep2 would add 2 more reads (overlap)

        release();
        await Promise.all([sweep1, sweep2]);
        expect(reads).toBe(2);

        // guard resets in finally: a fresh sweep after settle runs normally
        await svc.pollAllRunningTmuxSeats(db);
        expect(reads).toBe(4);
      } finally {
        db.close();
      }
    });

    it("polls every running tmux-bound seat once; stores observations keyed by canonical session name", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO software_teams (id, name) VALUES ('r1', 'software-team-a')").run();
        db.prepare("INSERT INTO nodes (id, software_team_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        db.prepare("INSERT INTO nodes (id, software_team_id, logical_id) VALUES ('n2', 'r1', 'qa')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@software-team", "running", ts);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s2", "n2", "qa@software-team", "running", ts);

        const tmux = makeTmuxAdapter({
          "dev@software-team": FIXED_NOW_EPOCH,         // active (now)
          "qa@software-team": FIXED_NOW_EPOCH - 60,     // idle (60s old, window 3s)
        });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

        await svc.pollAllRunningTmuxSeats(db);

        expect(svc.getSeatActivity("dev@software-team")!.isActiveWithinWindow).toBe(true);
        expect(svc.getSeatActivity("qa@software-team")!.isActiveWithinWindow).toBe(false);
        expect(tmux.readPaneLastActivity).toHaveBeenCalledTimes(2);
      } finally {
        db.close();
      }
    });

    it("skips detached / stopped seats — only `running` status is polled", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO software_teams (id, name) VALUES ('r1', 'software-team-a')").run();
        db.prepare("INSERT INTO nodes (id, software_team_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        db.prepare("INSERT INTO nodes (id, software_team_id, logical_id) VALUES ('n2', 'r1', 'qa')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@software-team", "running", ts);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s2", "n2", "qa@software-team", "detached", ts);

        const tmux = makeTmuxAdapter({
          "dev@software-team": FIXED_NOW_EPOCH,
          "qa@software-team": FIXED_NOW_EPOCH,
        });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });
        await svc.pollAllRunningTmuxSeats(db);

        expect(svc.getSeatActivity("dev@software-team")).not.toBeNull();
        expect(svc.getSeatActivity("qa@software-team")).toBeNull(); // detached → skipped
        expect(tmux.readPaneLastActivity).toHaveBeenCalledTimes(1);
      } finally {
        db.close();
      }
    });

    it("drops cached observations for seats no longer in the running set (memory hygiene)", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO software_teams (id, name) VALUES ('r1', 'software-team-a')").run();
        db.prepare("INSERT INTO nodes (id, software_team_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@software-team", "running", ts);

        const tmux = makeTmuxAdapter({ "dev@software-team": FIXED_NOW_EPOCH });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });
        await svc.pollAllRunningTmuxSeats(db);
        expect(svc.getSeatActivity("dev@software-team")).not.toBeNull();

        // Stop the seat; expect the observation to drop on next sweep.
        db.prepare("UPDATE sessions SET status = 'detached' WHERE id = 's1'").run();
        await svc.pollAllRunningTmuxSeats(db);
        expect(svc.getSeatActivity("dev@software-team")).toBeNull();
      } finally {
        db.close();
      }
    });
  });
});
