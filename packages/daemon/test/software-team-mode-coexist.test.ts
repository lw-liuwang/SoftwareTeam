// Slice 04 (OPR.0.7.0.4) 04-A2 — a saved legacy mode and an operating posture (human-led / delegated) are kept side by
// side at one target: a write replaces only its own category's binding there. Through the real store, migrations,
// routes and posture service, on a private in-memory database.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SoftwareTeamModeStore } from "../src/domain/software-team-mode/software-team-mode-store.js";
import { OperatingPostureService } from "../src/domain/software-team-mode/operating-posture.js";
import { RECOMMENDED_MODE_DEFAULTS } from "../src/domain/software-team-mode/software-team-mode-defaults.js";
import type { OperatorContextMode, OperatorContextScope } from "../src/domain/software-team-mode/software-team-mode-types.js";
import { softwareTeamModeRoutes } from "../src/routes/software-team-mode.js";

type Mode = Exclude<OperatorContextMode, never>;
const record = (mode: Mode, scope: OperatorContextScope) => ({
  ...RECOMMENDED_MODE_DEFAULTS[mode as keyof typeof RECOMMENDED_MODE_DEFAULTS], scope, expiry_or_stale_rule: "none", evidence_citation: `operator chose ${mode}`,
});

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));

function setup(migrations = ALL_MIGRATIONS) {
  const db = createDb(); migrate(db, migrations); cleanup.push(() => db.close());
  let tick = 0;
  // A strictly later clock per write, so "latest set" is unambiguous unless a test pins a tie.
  const modes = new SoftwareTeamModeStore(db, { now: () => new Date(Date.UTC(2026, 9, 14, 18, 0, tick++)) });
  const softwareTeam = new SoftwareTeamRepository(db).createSoftwareTeam("demo");
  const service = new OperatingPostureService(db, modes, () => "/nonexistent-home");
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("softwareTeamModeStore" as never, modes); c.set("operatingPosture" as never, service); await next(); });
  app.route("/api/software-team-mode", softwareTeamModeRoutes({ bearerToken: "isolated-operator" }));
  const auth = { authorization: "Bearer isolated-operator" };
  const put = async (mode: Mode, scope: OperatorContextScope, qualifier: string) => {
    const res = await app.request(`/api/software-team-mode/bindings/${scope}/${encodeURIComponent(qualifier)}`, {
      method: "PUT", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ mode, record: record(mode, scope) }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { binding: { id: string; mode: string; qualifier: string } };
  };
  const del = async (scope: string, qualifier: string, category?: string) =>
    (await app.request(`/api/software-team-mode/bindings/${scope}/${encodeURIComponent(qualifier)}${category ? `?category=${category}` : ""}`, { method: "DELETE", headers: auth })).json() as
      Promise<{ removed: boolean; category?: string; remaining?: { mode: string } | null }>;
  const get = async (path: string) => (await app.request(path)).json() as Promise<Record<string, any>>;
  const rows = () => db.prepare("SELECT id, scope, qualifier, mode FROM operator_context_mode_bindings ORDER BY id").all();
  return { db, modes, softwareTeam, service, app, put, del, get, rows };
}

describe("a saved mode and a posture kept side by side", () => {
  // The softwareTeam's canonical id and its name are two stored qualifiers; posture writes always land on the id.
  for (const form of ["canonical id", "name"] as const) {
    for (const order of ["mode then posture", "posture then mode"] as const) {
      it(`${order}, the mode written by ${form}: both kept and readable, the posture consumer reads the posture`, async () => {
        const t = setup();
        const target = form === "canonical id" ? t.softwareTeam.id : "demo";
        const writeMode = () => t.put("focus", "softwareTeam", target);
        const writePosture = () => t.put("delegated", "softwareTeam", "demo");
        if (order === "mode then posture") { await writeMode(); await writePosture(); } else { await writePosture(); await writeMode(); }

        expect(t.rows()).toEqual(expect.arrayContaining([
          expect.objectContaining({ qualifier: target, mode: "focus" }),
          expect.objectContaining({ qualifier: t.softwareTeam.id, mode: "delegated" }),
        ]));
        expect(t.rows()).toHaveLength(2);
        // The posture consumer and authority, whatever was written last.
        expect(t.service.resolve({ softwareTeamId: t.softwareTeam.id })).toMatchObject({ posture: "delegated", source: "binding", grantsAuthority: false });
        const effective = await t.get(`/api/software-team-mode/effective?softwareTeam=demo`);
        expect(effective.operatingPosture).toMatchObject({ posture: "delegated", grantsAuthority: false });
        expect(effective.categories.mode).toMatchObject({ mode: "focus", qualifier: target });
        expect(effective.categories.posture).toMatchObject({ mode: "delegated", qualifier: t.softwareTeam.id });
        // The legacy primary result keeps its meaning: at equal specificity a raw-name binding is preferred (as on
        // main); at one stored target the latest set is the one shown.
        const primary = form === "name" ? "focus" : order === "mode then posture" ? "delegated" : "focus";
        expect(effective.effective.binding.mode).toBe(primary);
      });
    }
  }

  it("a later write replaces only its own category, keeping the row's id", async () => {
    const t = setup();
    const first = await t.put("focus", "softwareTeam", t.softwareTeam.id);
    await t.put("delegated", "softwareTeam", "demo");
    const again = await t.put("debug", "softwareTeam", t.softwareTeam.id);
    expect(again.binding.id).toBe(first.binding.id);
    expect(t.rows()).toEqual([
      expect.objectContaining({ id: `posture@software-team:${t.softwareTeam.id}`, mode: "delegated" }),
      expect.objectContaining({ id: `software-team:${t.softwareTeam.id}`, mode: "debug" }),
    ]);
    await t.put("human-led", "softwareTeam", "demo");
    expect(t.rows()).toEqual([
      expect.objectContaining({ id: `posture@software-team:${t.softwareTeam.id}`, mode: "human-led" }),
      expect.objectContaining({ id: `software-team:${t.softwareTeam.id}`, mode: "debug" }),
    ]);
  });

  it("a second category's id can't be mistaken for a legacy id, even for qualifiers ending in :mode or :posture", () => {
    const t = setup();
    // Legacy-shaped rows whose qualifiers end like a category.
    t.modes.setBinding("softwareTeam", "x:posture", "focus", record("focus", "softwareTeam"));
    t.modes.setBinding("softwareTeam", "x:mode", "sleep", record("sleep", "softwareTeam"));
    t.modes.setBinding("softwareTeam", "x", "debug", record("debug", "softwareTeam"));
    t.modes.setBinding("softwareTeam", "x", "delegated", record("delegated", "softwareTeam"));
    expect(t.rows()).toEqual([
      expect.objectContaining({ id: "posture@software-team:x", qualifier: "x", mode: "delegated" }),
      expect.objectContaining({ id: "software-team:x", qualifier: "x", mode: "debug" }),
      expect.objectContaining({ id: "software-team:x:mode", qualifier: "x:mode", mode: "sleep" }),
      expect.objectContaining({ id: "software-team:x:posture", qualifier: "x:posture", mode: "focus" }),
    ]);
    for (const q of ["x", "x:mode", "x:posture"]) expect(t.modes.getBinding("softwareTeam", q)?.qualifier).toBe(q);
    // Resolution accepts every one of these ids as valid.
    expect(t.modes.resolveEffective({ softwareTeamId: "x" }, ["human-led", "delegated"])?.binding.id).toBe("posture@software-team:x");
    expect(t.modes.resolveEffective({ softwareTeamId: "x:posture" })?.binding.mode).toBe("focus");
  });

  it("an opaque legacy target (not a softwareTeam) still takes a mode by name, and a posture there is still refused as on main", async () => {
    const t = setup();
    await t.put("focus", "softwareTeam", "no-such-software-team");
    const res = await t.app.request("/api/software-team-mode/bindings/softwareTeam/no-such-software-team", {
      method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer isolated-operator" },
      body: JSON.stringify({ mode: "delegated", record: record("delegated", "softwareTeam") }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "scope_unresolved" });
    expect(t.rows()).toEqual([expect.objectContaining({ id: "software-team:no-such-software-team", mode: "focus" })]);
  });
});

describe("reads and unset where both are kept", () => {
  it("a direct read shows the latest set binding and lists each category; it canonicalises only on a miss, as on main", async () => {
    const t = setup();
    await t.put("focus", "softwareTeam", t.softwareTeam.id);
    await t.put("delegated", "softwareTeam", "demo");
    const byId = await t.get(`/api/software-team-mode/bindings/softwareTeam/${t.softwareTeam.id}`);
    expect(byId.binding.mode).toBe("delegated");
    expect(byId.bindings.map((b: { mode: string }) => b.mode)).toEqual(["delegated", "focus"]);
    // By name: no row is stored under "demo", so the read canonicalises.
    const byName = await t.get("/api/software-team-mode/bindings/softwareTeam/demo");
    expect(byName.bindings.map((b: { mode: string }) => b.mode)).toEqual(["delegated", "focus"]);
  });

  it("unset without a category removes the latest set one and says what's still kept; with one, exactly that one", async () => {
    const t = setup();
    await t.put("focus", "softwareTeam", t.softwareTeam.id);
    await t.put("delegated", "softwareTeam", "demo");
    expect(await t.del("softwareTeam", t.softwareTeam.id)).toMatchObject({ removed: true, category: "posture", remaining: { mode: "focus" } });
    // The kept mode is now what the primary effective read shows.
    expect((await t.get("/api/software-team-mode/effective?softwareTeam=" + t.softwareTeam.id)).effective.binding.mode).toBe("focus");
    await t.put("delegated", "softwareTeam", "demo");
    expect(await t.del("softwareTeam", t.softwareTeam.id, "mode")).toMatchObject({ removed: true, category: "mode", remaining: { mode: "delegated" } });
    expect(await t.del("softwareTeam", t.softwareTeam.id, "mode")).toEqual({ removed: false });
    expect(await t.del("softwareTeam", "demo", "posture")).toMatchObject({ removed: true, category: "posture", remaining: null });
    expect(await t.del("softwareTeam", t.softwareTeam.id)).toEqual({ removed: false });
    const bad = await t.app.request(`/api/software-team-mode/bindings/softwareTeam/${t.softwareTeam.id}?category=other`, { method: "DELETE", headers: { authorization: "Bearer isolated-operator" } });
    expect(bad.status).toBe(400);
  });

  it("a same-millisecond tie is broken the same way for the read and the unset: by id", () => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
    const same = new SoftwareTeamModeStore(db, { now: () => new Date("2026-10-14T18:00:00.000Z") });
    same.setBinding("softwareTeam", "r1", "delegated", record("delegated", "softwareTeam"));
    same.setBinding("softwareTeam", "r1", "focus", record("focus", "softwareTeam"));
    // The posture came first, so it holds "software-team:r1" and the mode is "mode@software-team:r1", which sorts first on the tie.
    expect(same.getBinding("softwareTeam", "r1")?.id).toBe("mode@software-team:r1");
    expect(same.removeBinding("softwareTeam", "r1")?.id).toBe("mode@software-team:r1");
    expect(same.getBinding("softwareTeam", "r1")?.mode).toBe("delegated");
  });
});

describe("migration 109 on surviving rows", () => {
  it("keeps every row, id and record from a database at main's schema, and lets the categories coexist afterwards", () => {
    const db = createDb(); cleanup.push(() => db.close());
    migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== "109_mode_posture_coexist.sql"));
    const old = new SoftwareTeamModeStore(db, { now: () => new Date("2026-10-01T00:00:00.000Z") });
    const softwareTeam = new SoftwareTeamRepository(db).createSoftwareTeam("legacy");
    // Real-shaped rows: modes by id and by name, a posture by id, the host, a mission and a qitem.
    old.setBinding("softwareTeam", softwareTeam.id, "focus", record("focus", "softwareTeam"));
    old.setBinding("softwareTeam", "legacy", "sleep", record("sleep", "softwareTeam"));
    old.setBinding("softwareTeam", "other-software-team-id", "delegated", record("delegated", "softwareTeam"));
    old.setBinding("global_host", null, "desk", record("desk", "global_host"));
    old.setBinding("mission", "alpha/release", "human-led", record("human-led", "mission"));
    old.setBinding("qitem", "q:mode", "debug", record("debug", "qitem"));
    const before = db.prepare("SELECT * FROM operator_context_mode_bindings ORDER BY id").all();
    expect(before).toHaveLength(6);

    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT * FROM operator_context_mode_bindings ORDER BY id").all()).toEqual(before);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'operator_context_mode_bindings'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain("idx_operator_context_mode_bindings_scope_qualifier_category");
    expect(indexes).not.toContain("idx_operator_context_mode_bindings_scope_qualifier");
    // Applying the full list again is a no-op (the runner records applied migrations by name).
    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT * FROM operator_context_mode_bindings ORDER BY id").all()).toEqual(before);

    const store = new SoftwareTeamModeStore(db, { now: () => new Date("2026-10-14T00:00:00.000Z") });
    for (const r of before as Array<{ scope: OperatorContextScope; qualifier: string | null; id: string }>) {
      expect(store.getBinding(r.scope, r.qualifier)?.id).toBe(r.id);
    }
    // The surviving id-form mode now keeps a posture beside it.
    store.setBinding("softwareTeam", softwareTeam.id, "delegated", record("delegated", "softwareTeam"));
    expect(store.getBindings("softwareTeam", softwareTeam.id).map((b) => [b.id, b.mode])).toEqual([[`posture@software-team:${softwareTeam.id}`, "delegated"], [`software-team:${softwareTeam.id}`, "focus"]]);
    // Still one row per category: the unique index refuses a second posture there.
    expect(() => db.prepare("INSERT INTO operator_context_mode_bindings VALUES ('dup', 'softwareTeam', ?, 'human-led', '{}', 'x', 'operator')").run(softwareTeam.id)).toThrow(/UNIQUE/);
  });
});

describe("round 1: the write target a preview reads, and unset by category through its own path", () => {
  it("?for=posture reads where a posture write lands (the canonical id), so a posture written by name shows what it displaces there", async () => {
    const t = setup();
    await t.put("delegated", "softwareTeam", "demo");
    await t.put("focus", "softwareTeam", "demo");
    const posture = await t.get("/api/software-team-mode/bindings/softwareTeam/demo?for=posture");
    expect(posture.writeTarget).toBe(`software-team:${t.softwareTeam.id}`);
    expect(posture.bindings.map((b: { mode: string }) => b.mode)).toEqual(["delegated"]);
    // A saved mode lands as given: the name's own stored target.
    const mode = await t.get("/api/software-team-mode/bindings/softwareTeam/demo?for=mode");
    expect(mode).toMatchObject({ writeTarget: "software-team:demo", bindings: [expect.objectContaining({ mode: "focus", qualifier: "demo" })] });
    expect(await t.get("/api/software-team-mode/bindings/global_host?for=mode")).toEqual({ writeTarget: "global_host:host", bindings: [] });
    // Without ?for, main's read is unchanged: the name's stored binding.
    expect((await t.get("/api/software-team-mode/bindings/softwareTeam/demo")).binding.mode).toBe("focus");
  });

  it("?for=posture on a target a posture write can't resolve answers as that write would: scope_unresolved", async () => {
    const t = setup();
    const res = await t.app.request("/api/software-team-mode/bindings/softwareTeam/no-such-software-team?for=posture");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "scope_unresolved" });
    expect((await t.app.request("/api/software-team-mode/bindings/softwareTeam/demo?for=other")).status).toBe(400);
  });

  it("DELETE …/categories/<category> removes exactly that category, for a qualified scope and for global_host", async () => {
    const t = setup();
    await t.put("focus", "softwareTeam", t.softwareTeam.id);
    await t.put("delegated", "softwareTeam", "demo");
    const del = (path: string) => t.app.request(path, { method: "DELETE", headers: { authorization: "Bearer isolated-operator" } });
    expect(await (await del(`/api/software-team-mode/bindings/softwareTeam/${t.softwareTeam.id}/categories/mode`)).json()).toMatchObject({ removed: true, category: "mode", remaining: { mode: "delegated" } });
    expect(await (await del(`/api/software-team-mode/bindings/softwareTeam/${t.softwareTeam.id}/categories/mode`)).json()).toEqual({ removed: false });
    // By name: nothing of that category is stored under "demo", so it canonicalises, as the plain delete does.
    expect(await (await del("/api/software-team-mode/bindings/softwareTeam/demo/categories/posture")).json()).toMatchObject({ removed: true, category: "posture", remaining: null });
    t.modes.setBinding("global_host", null, "desk", record("desk", "global_host"));
    t.modes.setBinding("global_host", null, "human-led", record("human-led", "global_host"));
    expect(await (await del("/api/software-team-mode/bindings/global_host/categories/posture")).json()).toMatchObject({ removed: true, category: "posture", remaining: { mode: "desk" } });
    expect((await del("/api/software-team-mode/bindings/softwareTeam/categories/mode")).status).toBe(400);
    expect((await del(`/api/software-team-mode/bindings/softwareTeam/${t.softwareTeam.id}/categories/other`)).status).toBe(400);
    expect((await t.app.request(`/api/software-team-mode/bindings/softwareTeam/${t.softwareTeam.id}/categories/mode`, { method: "DELETE" })).status).toBe(401);
  });
});
