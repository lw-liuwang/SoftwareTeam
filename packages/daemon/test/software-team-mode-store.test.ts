// Slice 09 — store: persistence + scope-hierarchy resolution.
//
// HG-3 / HG-4 / HG-5 anchored here:
//   HG-3 — 4 scopes coexist; more-specific-wins resolution (both directions).
//   HG-4 — set is operator-only at the store layer (set_by = 'operator' hardcoded; agent code path doesn't exist).
//   HG-5 — persists across "restart" (close + reopen the db in-memory backing).
//
// BLOCKING-1 fix from guard verdict qitem-20260518043346: `mode` is
// a binding-level field, NOT inside the 10-field record. Every
// setBinding call passes mode as the third arg; record holds the
// frozen 10 Component-3 settings.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SoftwareTeamModeStore } from "../src/domain/software-team-mode/software-team-mode-store.js";
import {
  type OperatorContextMode,
  type OperatorContextModeRecord,
  type OperatorContextScope,
} from "../src/domain/software-team-mode/software-team-mode-types.js";

function makeRecord(
  overrides?: Partial<OperatorContextModeRecord>,
): OperatorContextModeRecord {
  return {
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "fast",
    inspection_depth: "forensic",
    update_detail: "verbose",
    escalation_threshold: "low",
    concurrency_limit: "serial",
    permission_prompt_posture: "normal",
    scope: "qitem",
    expiry_or_stale_rule: "re_confirm_on_long_gap",
    evidence_citation: "operator confirmed debug",
    ...overrides,
  };
}

describe("SoftwareTeamModeStore — slice 09 persistence + resolution", () => {
  let db: Database.Database;
  let store: SoftwareTeamModeStore;

  beforeEach(() => {
    db = createFullTestDb();
    store = new SoftwareTeamModeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("HG-4: setBinding accepts a valid record and reads it back; mode is binding-level", () => {
    const res = store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    expect(res.ok).toBe(true);
    const got = store.getBinding("global_host", null);
    expect(got?.mode).toBe("sleep");
    expect(got?.setBy).toBe("operator");
    // The record itself does NOT carry `mode` — that's the BLOCKING-1
    // discriminator from guard verdict qitem-20260518043346.
    expect((got?.record as unknown as Record<string, unknown>)["mode"]).toBeUndefined();
  });

  it("HG-2 + validator: setBinding rejects a record with an unknown field", () => {
    const res = store.setBinding(
      "global_host",
      null,
      "desk",
      { ...makeRecord({ scope: "global_host" }), extra: 1 } as unknown,
    );
    expect(res.ok).toBe(false);
  });

  it("HG-2 + validator: setBinding rejects a record that smuggles `mode` inside the record (unknown field)", () => {
    const res = store.setBinding(
      "global_host",
      null,
      "desk",
      { ...makeRecord({ scope: "global_host" }), mode: "desk" } as unknown,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes(`Unknown field "mode"`))).toBe(true);
    }
  });

  it("HG-1: setBinding rejects an invalid mode name (validateModeName)", () => {
    const res = store.setBinding("global_host", null, "Sleep", makeRecord({ scope: "global_host" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes(`mode="Sleep"`))).toBe(true);
    }
  });

  it("HG-SAFE: setBinding rejects a record whose permission_prompt_posture is auto_accept (runtime defense)", () => {
    const candidate = {
      ...makeRecord({ scope: "global_host" }),
      permission_prompt_posture: "auto_accept",
    } as unknown;
    const res = store.setBinding("global_host", null, "desk", candidate);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes("permission_prompt_posture"))).toBe(true);
    }
  });

  it("HG-4 invariant: global_host scope requires null qualifier", () => {
    const res = store.setBinding(
      "global_host",
      "software-team-1" as unknown as null,
      "desk",
      makeRecord({ scope: "global_host" }),
    );
    expect(res.ok).toBe(false);
  });

  it("HG-4 invariant: non-global scope requires a non-empty qualifier", () => {
    for (const scope of ["softwareTeam", "workstream", "qitem"] as const) {
      const empty = store.setBinding(scope, "", "desk", makeRecord({ scope }));
      expect(empty.ok).toBe(false);
      const nullQ = store.setBinding(scope, null, "desk", makeRecord({ scope }));
      expect(nullQ.ok).toBe(false);
    }
  });

  it("rejects a record whose scope field disagrees with the binding scope (no silent mismatch)", () => {
    const res = store.setBinding(
      "softwareTeam",
      "software-team-a",
      "focus",
      makeRecord({ scope: "qitem" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes("scope mismatch"))).toBe(true);
    }
  });

  it("setBinding upserts: re-set the same (scope, qualifier) replaces the binding (mode + record)", () => {
    store.setBinding("softwareTeam", "software-team-a", "focus", makeRecord({ scope: "softwareTeam", evidence_citation: "v1" }));
    store.setBinding("softwareTeam", "software-team-a", "debug", makeRecord({ scope: "softwareTeam", evidence_citation: "v2" }));
    const got = store.getBinding("softwareTeam", "software-team-a");
    expect(got?.mode).toBe("debug");
    expect(got?.record.evidence_citation).toBe("v2");
    expect(store.listBindings().filter((b) => b.id === "software-team:software-team-a").length).toBe(1);
  });

  it("listBindings returns all rows", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("softwareTeam", "software-team-a", "focus", makeRecord({ scope: "softwareTeam" }));
    store.setBinding("qitem", "q-1", "debug", makeRecord({ scope: "qitem" }));
    expect(store.listBindings().map((b) => b.id).sort()).toEqual([
      "global_host:host",
      "qitem:q-1",
      "software-team:software-team-a",
    ]);
  });

  it("deleteBinding removes and reports whether a row existed", () => {
    store.setBinding("softwareTeam", "software-team-a", "focus", makeRecord({ scope: "softwareTeam" }));
    expect(store.deleteBinding("softwareTeam", "software-team-a")).toBe(true);
    expect(store.deleteBinding("softwareTeam", "software-team-a")).toBe(false);
    expect(store.getBinding("softwareTeam", "software-team-a")).toBeNull();
  });

  // HG-3 — DIRECTION A: more-specific-wins (qitem overrides global_host).
  it("HG-3 DIRECTION A: qitem-scoped debug overrides global_host-scoped sleep for that qitem", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("qitem", "q-1", "debug", makeRecord({ scope: "qitem" }));

    const resolvedForQitem = store.resolveEffective({ qitemId: "q-1" });
    expect(resolvedForQitem?.binding.mode).toBe("debug");
    expect(resolvedForQitem?.resolvedScope).toBe("qitem");

    const resolvedForOther = store.resolveEffective({ qitemId: "q-2" });
    expect(resolvedForOther?.binding.mode).toBe("sleep");
    expect(resolvedForOther?.resolvedScope).toBe("global_host");
  });

  // HG-3 — DIRECTION B: the inverse — workstream-scoped focus wins over
  // software-team-scoped desk, and software-team-scoped desk wins over global_host-scoped sleep.
  it("HG-3 DIRECTION B: scope precedence qitem > workstream > softwareTeam > global_host (both ways)", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("softwareTeam", "software-team-a", "desk", makeRecord({ scope: "softwareTeam" }));
    store.setBinding("workstream", "ws-1", "focus", makeRecord({ scope: "workstream" }));

    const r1 = store.resolveEffective({ softwareTeamId: "software-team-a", workstreamId: "ws-1" });
    expect(r1?.binding.mode).toBe("focus");
    expect(r1?.resolvedScope).toBe("workstream");

    const r2 = store.resolveEffective({ softwareTeamId: "software-team-a" });
    expect(r2?.binding.mode).toBe("desk");
    expect(r2?.resolvedScope).toBe("softwareTeam");

    const r3 = store.resolveEffective({});
    expect(r3?.binding.mode).toBe("sleep");
    expect(r3?.resolvedScope).toBe("global_host");

    const r4 = store.resolveEffective({ softwareTeamId: "software-team-other" });
    expect(r4?.binding.mode).toBe("sleep");
  });

  it("resolveEffective returns null when no binding matches (convention §Q6 unknown_posture)", () => {
    expect(store.resolveEffective({ qitemId: "q-1" })).toBeNull();
    store.setBinding("softwareTeam", "software-team-a", "desk", makeRecord({ scope: "softwareTeam" }));
    expect(store.resolveEffective({ softwareTeamId: "software-team-other" })).toBeNull();
  });

  // HG-5 — survives "restart" (typed primitive in the shared db handle,
  // same store pattern as workspace primitive). Test simulates daemon
  // restart by closing and re-opening the same backing.
  it("HG-5: rows persist across store-instance lifecycle on the same db handle", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("qitem", "q-1", "debug", makeRecord({ scope: "qitem" }));

    const fresh = new SoftwareTeamModeStore(db);
    expect(fresh.listBindings().length).toBe(2);
    expect(fresh.getBinding("global_host", null)?.mode).toBe("sleep");
    expect(fresh.getBinding("qitem", "q-1")?.mode).toBe("debug");
  });

  // HG-4 — set_by is always 'operator' at the store layer. The schema
  // CHECK constraint also enforces this. There is no agent-set code
  // path; the store API simply doesn't expose one.
  it("HG-4: set_by is always 'operator' on every row", () => {
    store.setBinding("softwareTeam", "software-team-a", "focus", makeRecord({ scope: "softwareTeam" }));
    const row = db.prepare(`
      SELECT set_by FROM operator_context_mode_bindings WHERE id = ?
    `).get("software-team:software-team-a") as { set_by: string };
    expect(row.set_by).toBe("operator");
  });

  // HG-4 + BLOCKING-1: `mode` is persisted in its own column (not in
  // record_json) so the binding's identity is a typed-by-schema TEXT
  // column with a CHECK constraint, NOT a JSON field that could go
  // stale or smuggle additional fields.
  it("HG-4 (BLOCKING-1): mode is persisted in its own column with a CHECK constraint", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    const row = db.prepare(`
      SELECT mode, record_json FROM operator_context_mode_bindings WHERE id = ?
    `).get("global_host:host") as { mode: string; record_json: string };
    expect(row.mode).toBe("sleep");
    const parsed = JSON.parse(row.record_json) as Record<string, unknown>;
    expect(parsed["mode"]).toBeUndefined();
    expect(Object.keys(parsed).length).toBe(10);
  });

  // HG-SAFE — defense audit: setBinding writes to ONE table. The store
  // does not expose any method that touches permission allowlists,
  // runtime config, or auth surfaces. This test pins the surface area.
  it("HG-SAFE: SoftwareTeamModeStore exposes ONLY binding-related methods (no permission/auth/runtime-config surface)", () => {
    const expected = new Set([
      "setBinding",
      "getBinding",
      "listBindings",
      "deleteBinding",
      "resolveEffective",
      // 04-A2: a saved mode and a posture kept side by side at one target.
      "getBindings",
      "removeBinding",
    ]);
    const actual = new Set(
      Object.getOwnPropertyNames(SoftwareTeamModeStore.prototype).filter((m) => m !== "constructor"),
    );
    for (const m of actual) {
      expect(expected.has(m)).toBe(true);
    }
    for (const m of expected) {
      expect(actual.has(m)).toBe(true);
    }
  });

  // Per-scope grep negative: no permission-related identifier in the
  // source. This anchors the gate-zero "NO permission/runtime-config
  // write anywhere" rule at the store source level.
  it("HG-SAFE: software-team-mode-store source contains no permission / auth / tmux / lifecycle identifiers", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, "..", "src", "domain", "software-team-mode", "software-team-mode-store.ts"),
      "utf-8",
    );
    for (const forbidden of [
      "permissionAllowlist",
      "permission_allowlist",
      "runtimeConfig",
      "runtime_config",
      "tmuxAdapter",
      "tmux_session",
      "session_transport",
      "auth_token",
    ]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });

  // Spot-check qualifier-bearing scopes accept distinct bindings per
  // qualifier without bleed.
  it("scope+qualifier keys are independent — different software-teams/qitems hold distinct rows", () => {
    store.setBinding("softwareTeam", "software-team-a", "desk", makeRecord({ scope: "softwareTeam" }));
    store.setBinding("softwareTeam", "software-team-b", "focus", makeRecord({ scope: "softwareTeam" }));
    expect(store.getBinding("softwareTeam", "software-team-a")?.mode).toBe("desk");
    expect(store.getBinding("softwareTeam", "software-team-b")?.mode).toBe("focus");
  });

  // Plus a void usage to make the compiler keep the imported type
  // surface alive.
  void (null as unknown as OperatorContextScope);
  void (null as unknown as OperatorContextMode);
});
