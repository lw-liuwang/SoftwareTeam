// `SoftwareTeam launch` addresses a softwareTeam by its id or by its name, on every route, locally and on a selected host.
// An exact id wins (archived softwareTeams included, and over another softwareTeam *named* like that id); then one active softwareTeam of that
// name. A name matching several active softwareTeams stops before any request. A missing handle, or a softwareTeam lookup that fails
// or can't be read, keeps the earlier behaviour: the handle goes to the daemon as an id.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchCommand } from "../src/commands/launch.js";
import { lookupRemoteSoftwareTeamId, resolveRemoteSoftwareTeamId } from "../src/remote-host-ops.js";
import { downCommand } from "../src/commands/down.js";

const ALPHA = "01ALPHA000000000000000000A";
const ARCHIVED = "01ARCHIVED0000000000000000";
const DUP1 = "01DUP10000000000000000000A";
const DUP2 = "01DUP20000000000000000000B";
const TARGET = "01TARGET000000000000000000";
const NAMED_LIKE_TARGET = "01NAMEDLIKETARGET000000000";
/** The same synthetic softwareTeams, in the local summary's shape and the remote ps shape. */
const SOFTWARE_TEAMS = [
  { id: ALPHA, name: "alpha", archivedAt: null },
  { id: ARCHIVED, name: "old", archivedAt: "2026-10-01T00:00:00Z" },
  { id: DUP1, name: "dup", archivedAt: null },
  { id: DUP2, name: "dup", archivedAt: null },
  { id: TARGET, name: "target", archivedAt: null },
  { id: NAMED_LIKE_TARGET, name: TARGET, archivedAt: null },
];

type Answer = { status: number; data: unknown };
type Lookup = "softwareTeams" | "fail" | "malformed" | "throws";

/** A daemon stub: answers the softwareTeam lookup per `lookup`, records every launch POST, and acknowledges it. */
function daemon(lookup: Lookup, shape: "summary" | "ps") {
  const posts: Array<{ path: string; body: unknown }> = [];
  const gets: string[] = [];
  const client = {
    get: vi.fn(async (path: string): Promise<Answer> => {
      gets.push(path);
      if (path.startsWith("/api/software-teams/summary") || path.startsWith("/api/ps")) {
        if (lookup === "throws") throw new Error("connect ECONNREFUSED");
        if (lookup === "fail") return { status: 503, data: { error: "busy" } };
        if (lookup === "malformed") return { status: 200, data: { softwareTeams: "not a list" } };
        return { status: 200, data: shape === "summary" ? SOFTWARE_TEAMS : SOFTWARE_TEAMS.map(({ id, ...r }) => ({ softwareTeamId: id, ...r })) };
      }
      // Plan-support reads (launch-plan-guard): a current daemon.
      if (path === "/healthz") return { status: 200, data: { status: "ok", semver: "0.7.0" } };
      return { status: 200, data: { version: "0.7.0" } };
    }),
    post: vi.fn(async (path: string, body: unknown): Promise<Answer> => {
      posts.push({ path, body });
      if (path.endsWith("/launch-subset")) {
        const plan = (body as { plan?: boolean }).plan;
        return { status: 201, data: plan
          ? { ok: true, planOnly: true, nonTargetEffects: { mode: "unchanged", affected: [] } }
          : { ok: true, launched: [{ nodeId: "n1", logicalId: "worker", status: "fresh" }], held: [], alreadyRunning: [] } };
      }
      return { status: 201, data: { ok: true, nodeId: "n1", logicalId: "worker", sessionName: "worker@software-team" } };
    }),
  };
  return { client, posts, gets };
}

function deps(client: unknown) {
  return {
    lifecycleDeps: {
      spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
      readFile: vi.fn(() => JSON.stringify({ pid: 1, port: 3000, db: "t.sqlite", startedAt: new Date().toISOString() })),
      writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => true), mkdirp: vi.fn(), openForAppend: vi.fn(() => 1), isProcessAlive: vi.fn(() => true),
    },
    clientFactory: () => client,
    hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "h1", transport: "http", url: "http://h1.invalid:7434" }] } }),
  } as never;
}

let out: string[];
let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.stubEnv("SOFTWARETEAM_HOST_SELECTED", "local");
  vi.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

const retryFile = (() => {
  const dir = mkdtempSync(join(tmpdir(), "launch-by-name-"));
  const file = join(dir, "member.yaml");
  writeFileSync(file, "member:\n  id: worker\n  runtime: claude-code\n");
  return { file, root: dir };
})();

/** Every launch route, as argv after the softwareTeam handle, with the launch path it must POST to. */
const ROUTES = [
  { route: "single", args: ["worker"], path: (id: string) => `/api/software-teams/${id}/nodes/worker/launch` },
  { route: "subset", args: ["--seats", "worker"], path: (id: string) => `/api/software-teams/${id}/nodes/launch-subset` },
  { route: "subset plan", args: ["--plan", "--seats", "worker"], path: (id: string) => `/api/software-teams/${id}/nodes/launch-subset` },
  { route: "single-seat plan", args: ["worker", "--plan"], path: (id: string) => `/api/software-teams/${id}/nodes/launch-subset` },
  { route: "first-start retry", args: ["worker", "--retry-startup-from", retryFile.file, "--software-team-root", retryFile.root], path: (id: string) => `/api/software-teams/${id}/nodes/worker/launch` },
] as const;

/** Handles and the softwareTeam each one must reach (`null`: the raw handle goes to the daemon, as before). */
const HANDLES: Array<{ name: string; handle: string; reaches: string | null }> = [
  { name: "exact id", handle: ALPHA, reaches: ALPHA },
  { name: "unique active name", handle: "alpha", reaches: ALPHA },
  { name: "archived softwareTeam's id", handle: ARCHIVED, reaches: ARCHIVED },
  { name: "archived softwareTeam's name", handle: "old", reaches: null },
  { name: "an id that is also another softwareTeam's name", handle: TARGET, reaches: TARGET },
  { name: "missing", handle: "nope", reaches: null },
];

async function launch(d: ReturnType<typeof daemon>, argv: string[]) {
  await launchCommand(deps(d.client)).parseAsync(["node", "softwareTeam", ...argv]);
}

for (const where of ["local", "explicit --host", "selected host"] as const) {
  describe(`SoftwareTeam launch by SoftwareTeam name or id (${where})`, () => {
    const shape = where === "local" ? "summary" : "ps";
    const hostArgs = where === "explicit --host" ? ["--host", "h1"] : [];
    beforeEach(() => { if (where === "selected host") vi.stubEnv("SOFTWARETEAM_HOST_SELECTED", "h1"); });

    for (const r of ROUTES) {
      for (const h of HANDLES) {
        it(`${r.route}: ${h.name}`, async () => {
          const d = daemon("softwareTeams", shape);
          await launch(d, [h.handle, ...r.args, ...hostArgs]);
          expect(d.posts.map((p) => p.path)).toEqual([r.path(encodeURIComponent(h.reaches ?? h.handle))]);
          expect(d.gets.filter((g) => g.startsWith(shape === "summary" ? "/api/software-teams/summary" : "/api/ps"))).toHaveLength(1);
          expect(process.exitCode ?? 0).toBe(0);
        });
      }

      it(`${r.route}: an ambiguous name stops before any request and lists the candidates`, async () => {
        const d = daemon("softwareTeams", shape);
        await launch(d, ["dup", ...r.args, ...hostArgs]);
        expect(d.posts).toEqual([]);
        expect(process.exitCode).toBe(1);
        expect(err.join("\n")).toContain("'dup' matches 2 softwareTeams");
        expect(err.join("\n")).toContain(`${DUP1}  |  ${DUP2}`);
        expect(err.join("\n")).toContain("Nothing was launched.");
      });

      for (const lookup of ["fail", "malformed", "throws"] as const) {
        it(`${r.route}: a lookup that ${lookup === "fail" ? "fails" : lookup === "malformed" ? "can't be read" : "can't connect"} keeps the raw handle`, async () => {
          const d = daemon(lookup, shape);
          await launch(d, ["alpha", ...r.args, ...hostArgs]);
          expect(d.posts.map((p) => p.path)).toEqual([r.path("alpha")]);
        });
      }
    }

    it("--json reports an ambiguous name as data, with the candidates", async () => {
      const d = daemon("softwareTeams", shape);
      await launch(d, ["dup", "worker", "--json", ...hostArgs]);
      expect(JSON.parse(out.join("\n"))).toMatchObject({ ok: false, code: "software_team_ambiguous", error: { candidates: [DUP1, DUP2] } });
    });
  });
}

describe("SoftwareTeam launch by name: what a person sees locally", () => {
  it("names the SoftwareTeam and its id after a launch by name, and the id alone after a launch by id", async () => {
    await launch(daemon("softwareTeams", "summary"), ["alpha", "worker"]);
    expect(out).toContain(`Launched node worker in SoftwareTeam alpha (${ALPHA}) (worker@software-team)`);
    out.length = 0;
    await launch(daemon("softwareTeams", "summary"), [ALPHA, "worker"]);
    expect(out).toContain(`Launched node worker in softwareTeam ${ALPHA} (worker@software-team)`);
  });

  it("does not look the SoftwareTeam up for a request it refuses on its own input", async () => {
    const d = daemon("softwareTeams", "summary");
    await launch(d, ["alpha"]);
    expect(d.gets).toEqual([]);
    expect(d.posts).toEqual([]);
  });
});

/** A softwareTeam list with one malformed row (null, a primitive, a row without an id), before or after the real rows. */
function listWithBadRow(bad: unknown, where: "before" | "after", shape: "summary" | "ps"): unknown[] {
  const rows = shape === "summary" ? SOFTWARE_TEAMS : SOFTWARE_TEAMS.map(({ id, ...r }) => ({ softwareTeamId: id, ...r }));
  return where === "before" ? [bad, ...rows] : [...rows, bad];
}
function daemonWithRows(rows: unknown[]) {
  const d = daemon("softwareTeams", "summary");
  const get = d.client.get;
  d.client.get = vi.fn(async (path: string) =>
    path.startsWith("/api/software-teams/summary") || path.startsWith("/api/ps") ? (d.gets.push(path), { status: 200, data: rows }) : get(path));
  return d;
}
const BAD_ROWS: Array<[string, unknown]> = [["null", null], ["a primitive", 7], ["a row without an id", { name: "zzz" }]];

describe("a malformed row in the SoftwareTeam list never refuses a valid id, and doesn't hide a match", () => {
  for (const [badName, bad] of BAD_ROWS) {
    for (const where of ["before", "after"] as const) {
      for (const r of ROUTES) {
        it(`local ${r.route}, ${badName} ${where}: by id launches that id`, async () => {
          const d = daemonWithRows(listWithBadRow(bad, where, "summary"));
          await launch(d, [ALPHA, ...r.args]);
          expect(d.posts.map((p) => p.path)).toEqual([r.path(ALPHA)]);
        });
        it(`--host ${r.route}, ${badName} ${where}: by id and by name reach the softwareTeam`, async () => {
          for (const handle of [ALPHA, "alpha"]) {
            const d = daemonWithRows(listWithBadRow(bad, where, "ps"));
            await launch(d, [handle, ...r.args, "--host", "h1"]);
            expect(d.posts.map((p) => p.path)).toEqual([r.path(ALPHA)]);
          }
        });
      }
      it(`local, ${badName} ${where}: by name resolves over the readable rows, or keeps the raw name`, async () => {
        const d = daemonWithRows(listWithBadRow(bad, where, "summary"));
        await launch(d, ["alpha", "worker"]);
        // The shared local resolver throws on a null row; the launch then keeps the raw handle, as before this change.
        expect(d.posts.map((p) => p.path)).toEqual([`/api/software-teams/${bad === null ? "alpha" : ALPHA}/nodes/worker/launch`]);
      });
      it(`SoftwareTeam down --host, ${badName} ${where}: by id and by name tear down that softwareTeam`, async () => {
        for (const handle of [ALPHA, "alpha"]) {
          const d = daemonWithRows(listWithBadRow(bad, where, "ps"));
          await downCommand(deps(d.client)).parseAsync(["node", "softwareTeam", handle, "--host", "h1", "--json"]);
          expect(d.posts).toEqual([{ path: "/api/down", body: expect.objectContaining({ softwareTeamId: ALPHA }) }]);
        }
      });
    }
  }
});

describe("a host's row without an id still counts toward a name, but is never a target", () => {
  const ghost = { name: "alpha", archivedAt: null }; // an active row named like alpha, with no softwareTeamId
  for (const host of ["explicit", "selected"] as const) {
    const hostArgs = host === "explicit" ? ["--host", "h1"] : [];
    beforeEach(() => { if (host === "selected") vi.stubEnv("SOFTWARETEAM_HOST_SELECTED", "h1"); });
    for (const where of ["before", "after"] as const) {
      it(`SoftwareTeam down --host (${host}), ${where}: the name stays ambiguous and nothing is sent`, async () => {
        const d = daemonWithRows(listWithBadRow(ghost, where, "ps"));
        await downCommand(deps(d.client)).parseAsync(["node", "softwareTeam", "alpha", ...hostArgs, "--json"]);
        expect(d.posts).toEqual([]);
        expect(process.exitCode).toBe(1);
        expect(JSON.parse(out.join("\n"))).toEqual({ ok: false,
          error: 'ambiguous SoftwareTeam name "alpha" on host h1: 2 active softwareTeams share that name. Use the SoftwareTeam id instead.' });
      });
      it(`SoftwareTeam launch (${host}), ${where}: the name stays ambiguous and nothing is sent`, async () => {
        const d = daemonWithRows(listWithBadRow(ghost, where, "ps"));
        await launch(d, ["alpha", "worker", ...hostArgs]);
        expect(d.posts).toEqual([]);
        expect(err.join("\n")).toContain("'alpha' matches 2 softwareTeams on host h1.");
      });
      it(`(${host}), ${where}: the exact id still selects the valid softwareTeam`, async () => {
        const down = daemonWithRows(listWithBadRow(ghost, where, "ps"));
        await downCommand(deps(down.client)).parseAsync(["node", "softwareTeam", ALPHA, ...hostArgs, "--json"]);
        expect(down.posts).toEqual([{ path: "/api/down", body: expect.objectContaining({ softwareTeamId: ALPHA }) }]);
        const up = daemonWithRows(listWithBadRow(ghost, where, "ps"));
        await launch(up, [ALPHA, "worker", ...hostArgs]);
        expect(up.posts.map((p) => p.path)).toEqual([`/api/software-teams/${ALPHA}/nodes/worker/launch`]);
      });
    }
    it(`SoftwareTeam down --host (${host}): a name only an id-less row carries is not found, and nothing is sent`, async () => {
      const d = daemonWithRows(listWithBadRow({ name: "ghost", archivedAt: null }, "after", "ps"));
      await downCommand(deps(d.client)).parseAsync(["node", "softwareTeam", "ghost", ...hostArgs, "--json"]);
      expect(d.posts).toEqual([]);
      expect(JSON.parse(out.join("\n"))).toEqual({ ok: false, error: 'softwareTeam "ghost" not found on host h1' });
    });
  }
});

describe("remote SoftwareTeam lookup keeps SoftwareTeam down --host's results", () => {
  const remote = (lookup: Lookup) => deps(daemon(lookup, "ps").client) as never;
  it("distinguishes each outcome", async () => {
    expect(await lookupRemoteSoftwareTeamId("h1", "alpha", remote("softwareTeams"))).toEqual({ kind: "resolved", softwareTeamId: ALPHA, byName: true });
    expect(await lookupRemoteSoftwareTeamId("h1", ALPHA, remote("softwareTeams"))).toEqual({ kind: "resolved", softwareTeamId: ALPHA, byName: false });
    expect(await lookupRemoteSoftwareTeamId("h1", "dup", remote("softwareTeams"))).toEqual({ kind: "ambiguous", count: 2, ids: [DUP1, DUP2] });
    expect(await lookupRemoteSoftwareTeamId("h1", "nope", remote("softwareTeams"))).toEqual({ kind: "not_found" });
    expect(await lookupRemoteSoftwareTeamId("h1", "alpha", remote("fail"))).toMatchObject({ kind: "unavailable" });
    expect(await lookupRemoteSoftwareTeamId("h1", "alpha", remote("malformed"))).toMatchObject({ kind: "unavailable" });
  });

  it("resolveRemoteSoftwareTeamId returns the same messages as before", async () => {
    expect(await resolveRemoteSoftwareTeamId("h1", "alpha", remote("softwareTeams"))).toEqual({ ok: true, softwareTeamId: ALPHA });
    expect(await resolveRemoteSoftwareTeamId("h1", "dup", remote("softwareTeams"))).toEqual({ ok: false,
      error: 'ambiguous SoftwareTeam name "dup" on host h1: 2 active softwareTeams share that name. Use the SoftwareTeam id instead.' });
    expect(await resolveRemoteSoftwareTeamId("h1", "nope", remote("softwareTeams"))).toEqual({ ok: false, error: 'softwareTeam "nope" not found on host h1' });
    expect(await resolveRemoteSoftwareTeamId("h1", "alpha", remote("fail"))).toEqual({ ok: false, error: "cannot resolve SoftwareTeam on host h1: HTTP 503" });
  });
});
