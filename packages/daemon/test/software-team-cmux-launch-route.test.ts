// Slice 24 Checkpoint C — POST /api/software-teams/:softwareTeamId/cmux/launch route tests.
//
// Tests the route's coordination logic (softwareTeam lookup → cmux availability
// gate → NodeInventory session-name mapping → ordered-by-pod-then-member
// → chunked into MAX_PER_WORKSPACE → workspace-name conflict resolution
// → buildWorkspace per chunk) using mocked deps to keep tests fast +
// hermetic. Full cmux daemon end-to-end is QA/operator window per
// permission posture.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { softwareTeamCmuxRoutes } from "../src/routes/software-team-cmux.js";
import { CmuxLayoutService } from "../src/domain/cmux-layout-service.js";
import type { CmuxAdapter, CmuxResult, CmuxWorkspace } from "../src/adapters/cmux.js";
import type { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import type Database from "better-sqlite3";

interface FakeSoftwareTeamOpts {
  id: string;
  name: string;
  nodes: Array<{
    logicalId: string;
    podId: string | null;
    canonicalSessionName: string | null;
    sessionStatus?: string | null;
    storedSessionStatus?: string | null;
    attachmentType?: string | null;
  }>;
}

function makeSoftwareTeamRepoStub(softwareTeams: Record<string, FakeSoftwareTeamOpts>): SoftwareTeamRepository {
  return {
    getSoftwareTeam: (softwareTeamId: string) => {
      const softwareTeam = softwareTeams[softwareTeamId];
      if (!softwareTeam) return null;
      return {
        softwareTeam: { id: softwareTeam.id, name: softwareTeam.name } as never,
        nodes: softwareTeam.nodes.map((n) => ({
          id: n.logicalId,
          softwareTeamId: softwareTeam.id,
          logicalId: n.logicalId,
          podId: n.podId,
          binding: null,
        })) as never,
        edges: [],
      };
    },
  } as unknown as SoftwareTeamRepository;
}

function makeNodeInventoryStub(softwareTeams: Record<string, FakeSoftwareTeamOpts>) {
  return (softwareTeamId: string) => {
    const softwareTeam = softwareTeams[softwareTeamId];
    if (!softwareTeam) return [];
    // Mirror getNodeInventory: emits one entry per node (including
    // detached/exited ones — sessionStatus distinguishes). Default
    // sessionStatus = "running" + attachmentType = "tmux" so existing
    // happy-path tests stay green.
    return softwareTeam.nodes.map((n) => ({
      logicalId: n.logicalId,
      canonicalSessionName: n.canonicalSessionName,
      sessionStatus: n.sessionStatus ?? (n.canonicalSessionName ? "running" : null),
      storedSessionStatus: n.storedSessionStatus ?? n.sessionStatus ?? (n.canonicalSessionName ? "running" : null),
      attachmentType: n.attachmentType ?? "tmux",
      podId: n.podId,
    })) as never;
  };
}

function makeMockAdapter(opts: {
  available: boolean;
  existingWorkspaces?: string[];
  splitOk?: boolean;
  createOk?: boolean;
  failOn?: "createWorkspace" | "splitSurface" | "sendText" | "listWorkspaces";
  /**
   * If set, makes createWorkspace fail ONLY when given this specific name.
   * Enables "chunk 0 succeeds, chunk 1 fails" tests for partial-response
   * discrimination (slice 24.C carry-forward concern).
   */
  failOnWorkspaceName?: string;
}): CmuxAdapter {
  const existing = opts.existingWorkspaces ?? [];
  const adapter = {
    isAvailable: () => opts.available,
    getStatus: () => ({ available: opts.available, capabilities: {} }),
    connect: async () => {},
    listWorkspaces: async (): Promise<CmuxResult<CmuxWorkspace[]>> => {
      if (opts.failOn === "listWorkspaces") {
        return { ok: false, code: "request_failed", message: "list failed" };
      }
      return { ok: true, data: existing.map((name, i) => ({ id: `workspace:${i + 100}`, name })) };
    },
    createWorkspace: async (name: string): Promise<CmuxResult<string>> => {
      if (opts.failOn === "createWorkspace") {
        return { ok: false, code: "request_failed", message: "duplicate name" };
      }
      if (opts.failOnWorkspaceName === name) {
        return { ok: false, code: "request_failed", message: `cmux refused workspace "${name}"` };
      }
      return { ok: true, data: `workspace:new-${name}` };
    },
    listSurfaces: async (): Promise<CmuxResult<unknown[]>> => ({
      ok: true,
      data: [{ id: "surface:default", title: "", type: "terminal" }],
    }),
    splitSurface: async (): Promise<CmuxResult<string>> => {
      if (opts.failOn === "splitSurface") {
        return { ok: false, code: "request_failed", message: "split failed" };
      }
      return { ok: true, data: `surface:${Math.random().toString(36).slice(2, 8)}` };
    },
    sendText: async (): Promise<CmuxResult<void>> => {
      if (opts.failOn === "sendText") {
        return { ok: false, code: "request_failed", message: "send failed" };
      }
      return { ok: true, data: undefined };
    },
    closeWorkspace: async (): Promise<CmuxResult<void>> => ({ ok: true, data: undefined }),
    listPaneSurfaces: async (): Promise<CmuxResult<unknown[]>> => ({ ok: true, data: [] }),
  };
  return adapter as unknown as CmuxAdapter;
}

function makeTmuxAdapterStub(liveSessions?: Set<string>): import("../src/adapters/tmux.js").TmuxAdapter {
  const live = liveSessions ?? new Set<string>();
  return {
    hasSession: async (name: string) => live.has(name),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
    getPaneCommand: async () => null,
    capturePaneContent: async () => null,
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
  } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
}

function buildApp(opts: {
  softwareTeams: Record<string, FakeSoftwareTeamOpts>;
  adapter: CmuxAdapter;
  liveSessions?: Set<string>;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
}): Hono {
  const app = new Hono();
  const softwareTeamRepo = makeSoftwareTeamRepoStub(opts.softwareTeams);
  const nodeInventoryFn = makeNodeInventoryStub(opts.softwareTeams);
  // No-op sleep so tests don't actually wait
  const layoutService = new CmuxLayoutService(opts.adapter, { sleep: async () => {} });
  // OPR.0.3.4.8: default live sessions = sessions whose effective sessionStatus
  // is "running" (mirrors makeNodeInventoryStub's default: canonicalSessionName
  // present + no explicit non-running sessionStatus = "running").
  const defaultLive = new Set<string>();
  for (const softwareTeam of Object.values(opts.softwareTeams)) {
    for (const node of softwareTeam.nodes ?? []) {
      if (!node.canonicalSessionName) continue;
      const effectiveStatus = node.sessionStatus ?? "running";
      if (effectiveStatus === "running") {
        defaultLive.add(node.canonicalSessionName);
      }
    }
  }
  const tmuxAdapter = makeTmuxAdapterStub(opts.liveSessions ?? defaultLive);

  app.use("*", async (c, next) => {
    c.set("softwareTeamRepo" as never, softwareTeamRepo);
    c.set("cmuxAdapter" as never, opts.adapter);
    c.set("cmuxLayoutService" as never, layoutService);
    c.set("nodeInventoryFn" as never, nodeInventoryFn);
    c.set("tmuxAdapter" as never, tmuxAdapter);
    c.set("readinessTimeoutMs" as never, opts.readinessTimeoutMs);
    c.set("readinessPollMs" as never, opts.readinessPollMs);
    c.set("db" as never, {} as Database.Database);
    await next();
  });
  app.route("/api/software-teams/:softwareTeamId/cmux", softwareTeamCmuxRoutes);
  return app;
}

describe("POST /api/software-teams/:softwareTeamId/cmux/launch", () => {
  it("returns 404 when SoftwareTeam not found", async () => {
    const app = buildApp({
      softwareTeams: {},
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/software-teams/missing/cmux/launch", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("software_team_not_found");
  });

  it("returns 503 when cmux adapter is unavailable", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "my-software-team",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@my-software-team" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: false }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("cmux_unavailable");
    expect(body.message.toLowerCase()).toMatch(/cmux/);
  });

  it("returns 412 when SoftwareTeam has no running tmux sessions", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "my-software-team",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: null }, // not running
            { logicalId: "b", podId: "p1", canonicalSessionName: null },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      readinessTimeoutMs: 100,
      readinessPollMs: 10,
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("software_team_not_running");
  });

  it("happy path: 3 running agents → 1 workspace named after softwareTeam", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "my-software-team",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@my-software-team" },
            { logicalId: "b", podId: "p1", canonicalSessionName: "b@my-software-team" },
            { logicalId: "c", podId: "p2", canonicalSessionName: "c@my-software-team" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: Array<{ name: string; agents: string[]; blanks: number }> };
    expect(body.ok).toBe(true);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]!.name).toBe("my-software-team");
    expect(body.workspaces[0]!.agents).toEqual(["a@my-software-team", "b@my-software-team", "c@my-software-team"]);
    expect(body.workspaces[0]!.blanks).toBe(1);
  });

  it("13 agents → 2 workspaces (12 + 1)", async () => {
    const nodes = Array.from({ length: 13 }, (_, i) => ({
      logicalId: `a${i + 1}`,
      podId: "p1",
      canonicalSessionName: `a${i + 1}@big-software-team`,
    }));
    const app = buildApp({
      softwareTeams: { "software-team-1": { id: "software-team-1", name: "big-software-team", nodes } },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ name: string; agents: string[] }> };
    expect(body.workspaces).toHaveLength(2);
    expect(body.workspaces[0]!.name).toBe("big-software-team");
    expect(body.workspaces[0]!.agents).toHaveLength(12);
    expect(body.workspaces[1]!.name).toBe("big-software-team-2");
    expect(body.workspaces[1]!.agents).toHaveLength(1);
  });

  it("auto-appends -2 suffix when workspace with SoftwareTeam name already exists in cmux", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "existing-software-team",
          nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: "a@existing-software-team" }],
        },
      },
      adapter: makeMockAdapter({
        available: true,
        existingWorkspaces: ["existing-software-team"], // name collision
      }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ name: string }> };
    expect(body.workspaces[0]!.name).toBe("existing-software-team-2");
  });

  it("auto-appends sequential suffix when multiple workspaces collide", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "collide",
          nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: "a@collide" }],
        },
      },
      adapter: makeMockAdapter({
        available: true,
        existingWorkspaces: ["collide", "collide-2", "collide-3"],
      }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ name: string }> };
    expect(body.workspaces[0]!.name).toBe("collide-4");
  });

  it("returns 500 with partial-workspace info when a buildWorkspace step fails mid-flight", async () => {
    const nodes = Array.from({ length: 13 }, (_, i) => ({
      logicalId: `a${i + 1}`,
      podId: "p1",
      canonicalSessionName: `a${i + 1}@partial-software-team`,
    }));
    const app = buildApp({
      softwareTeams: { "software-team-1": { id: "software-team-1", name: "partial-software-team", nodes } },
      adapter: makeMockAdapter({
        available: true,
        failOn: "splitSurface", // splitSurface fails on the FIRST workspace (12 agents need splits)
      }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("build_workspace_failed");
    expect(body.message.toLowerCase()).toMatch(/split failed/);
  });

  // velocity-guard 24.C BLOCKING-CONCERN repair regressions:
  // canonicalSessionName presence is INSUFFICIENT — the session may be
  // detached/exited but still have a name recorded in node-inventory.
  // Route must filter on sessionStatus === "running" too.

  it("412 software_team_not_running when nodes have canonicalSessionName but sessionStatus is 'exited' (BLOCKING-FIX)", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "stale-software-team",
          nodes: [
            {
              logicalId: "a",
              podId: "p1",
              canonicalSessionName: "a@stale-software-team",
              sessionStatus: "exited", // stale: session NAME recorded but session has exited
            },
            {
              logicalId: "b",
              podId: "p1",
              canonicalSessionName: "b@stale-software-team",
              sessionStatus: "detached", // detached: same story
            },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("software_team_not_running");
  });

  it("mixed stale+running: only running sessions are attached (BLOCKING-FIX discriminator)", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "mixed-software-team",
          nodes: [
            {
              logicalId: "a",
              podId: "p1",
              canonicalSessionName: "a@mixed-software-team",
              sessionStatus: "running",
            },
            {
              logicalId: "b",
              podId: "p1",
              canonicalSessionName: "b@mixed-software-team",
              sessionStatus: "exited", // stale
            },
            {
              logicalId: "c",
              podId: "p2",
              canonicalSessionName: "c@mixed-software-team",
              sessionStatus: "running",
            },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ agents: string[] }> };
    expect(body.workspaces).toHaveLength(1);
    // Only the two RUNNING sessions are attached; the exited one (b)
    // is filtered out. Without the sessionStatus filter, this would
    // include "b@mixed-softwareTeam" and the assertion would fail.
    expect(body.workspaces[0]!.agents).toEqual(["a@mixed-software-team", "c@mixed-software-team"]);
  });

  // velocity-guard 24.C-repair ADVISORY-OK carry-forward:
  // partial-workspace claim wasn't discriminated by prior tests
  // (failOn:"splitSurface" fails on the FIRST workspace, so partial[]
  // is always empty in those cases). This test proves the partial[]
  // payload accumulates successfully-built workspaces before the failure.

  it("500 partial-workspace info DISCRIMINATING: chunk 0 succeeds + chunk 1 fails → partial contains chunk-0 info", async () => {
    // 13 agents → 2 chunks: "fanout" (12 agents) + "fanout-2" (1 agent).
    // failOnWorkspaceName="fanout-2" lets the FIRST createWorkspace
    // succeed (with all its splits + sends), then fails the SECOND
    // createWorkspace at chunk 1. The response should include the
    // built workspace from chunk 0 under `partial[]`.
    const nodes = Array.from({ length: 13 }, (_, i) => ({
      logicalId: `a${i + 1}`,
      podId: "p1",
      canonicalSessionName: `a${i + 1}@fanout`,
    }));
    const app = buildApp({
      softwareTeams: { "software-team-1": { id: "software-team-1", name: "fanout", nodes } },
      adapter: makeMockAdapter({
        available: true,
        failOnWorkspaceName: "fanout-2",
      }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: string;
      message: string;
      partial: Array<{ name: string; agents: string[]; blanks: number }>;
    };
    expect(body.error).toBe("build_workspace_failed");
    // CRITICAL ASSERTION: partial contains the successfully-built
    // first workspace ("fanout" with 12 agents). Under a broken impl
    // that doesn't accumulate partial, this would be undefined or [].
    expect(body.partial).toHaveLength(1);
    expect(body.partial[0]!.name).toBe("fanout");
    expect(body.partial[0]!.agents).toHaveLength(12);
    expect(body.partial[0]!.blanks).toBe(0);
    // The failure message references the second workspace.
    expect(body.message.toLowerCase()).toMatch(/fanout-2/);
  });

  it("412 software_team_not_running when attachmentType is non-tmux even if sessionStatus is running (defensive)", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "non-tmux-software-team",
          nodes: [
            {
              logicalId: "a",
              podId: "p1",
              canonicalSessionName: "a@non-tmux",
              sessionStatus: "running",
              attachmentType: "ssh", // non-tmux: can't 'tmux attach -t'
            },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
  });

  // OPR.0.3.4.8 — cmux launch readiness: tmux-liveness discriminator + honest partial.

  it("OPR.0.3.4.8: live detached session (hasSession true) is INCLUDED as a pane", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "live-detached-software-team",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@live-detached-software-team", sessionStatus: "detached" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      liveSessions: new Set(["a@live-detached-software-team"]),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ agents: string[] }>; missing?: Array<{ logicalId: string }> };
    expect(body.workspaces[0]!.agents).toEqual(["a@live-detached-software-team"]);
    expect(body.missing).toBeUndefined();
  });

  it("OPR.0.3.4.8: mixed live + stale -> response includes missing with reasons", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "partial-software-team",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@partial-software-team", sessionStatus: "running" },
            { logicalId: "b", podId: "p1", canonicalSessionName: "b@partial-software-team", sessionStatus: "exited" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      liveSessions: new Set(["a@partial-software-team"]),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: Array<{ agents: string[] }>; missing: Array<{ logicalId: string; reason: string }> };
    expect(body.ok).toBe(true);
    expect(body.workspaces[0]!.agents).toEqual(["a@partial-software-team"]);
    expect(body.missing).toBeDefined();
    expect(body.missing).toHaveLength(1);
    expect(body.missing[0]!.logicalId).toBe("b");
    expect(body.missing[0]!.reason).toBe("session-missing");
  });

  it("OPR.0.3.4.8: stale dead session (hasSession false) is NOT attached, listed as missing", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "dead-software-team",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@dead-software-team", sessionStatus: "exited" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      liveSessions: new Set(),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: string; missing: Array<{ logicalId: string; reason: string }> };
    expect(body.error).toBe("software_team_not_running");
    expect(body.missing).toBeDefined();
    expect(body.missing.some((m) => m.logicalId === "a")).toBe(true);
  });

  it("OPR.0.3.4.8: fully-ready SoftwareTeam opens all seats with no missing", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "full-software-team",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@full-software-team" },
            { logicalId: "b", podId: "p1", canonicalSessionName: "b@full-software-team" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: Array<{ agents: string[] }>; missing?: unknown };
    expect(body.ok).toBe(true);
    expect(body.workspaces[0]!.agents).toEqual(["a@full-software-team", "b@full-software-team"]);
    expect(body.missing).toBeUndefined();
  });

  it("OPR.0.3.4.8: no code branches on sessionStatus === attention_required", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "attn-software-team",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@attn-software-team", sessionStatus: "running" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      liveSessions: new Set(["a@attn-software-team"]),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ agents: string[] }> };
    expect(body.workspaces[0]!.agents).toContain("a@attn-software-team");
  });

  it("OPR.0.3.4.8: candidate hasSession false,false,true before timeout -> included", async () => {
    let callCount = 0;
    const dynamicTmux = {
      ...makeTmuxAdapterStub(new Set()),
      hasSession: async (name: string) => {
        callCount++;
        return callCount >= 3;
      },
    } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
    const app = new Hono();
    const softwareTeams = {
      "software-team-1": {
        id: "software-team-1",
        name: "late-live-software-team",
        nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: "a@late-live-software-team", sessionStatus: "running" as string | undefined }],
      },
    };
    const softwareTeamRepo = makeSoftwareTeamRepoStub(softwareTeams);
    const nodeInventoryFn = makeNodeInventoryStub(softwareTeams);
    const layoutService = new CmuxLayoutService(makeMockAdapter({ available: true }), { sleep: async () => {} });
    app.use("*", async (c, next) => {
      c.set("softwareTeamRepo" as never, softwareTeamRepo);
      c.set("cmuxAdapter" as never, makeMockAdapter({ available: true }));
      c.set("cmuxLayoutService" as never, layoutService);
      c.set("nodeInventoryFn" as never, nodeInventoryFn);
      c.set("tmuxAdapter" as never, dynamicTmux);
      c.set("readinessTimeoutMs" as never, 500);
      c.set("readinessPollMs" as never, 10);
      c.set("db" as never, {} as Database.Database);
      await next();
    });
    app.route("/api/software-teams/:softwareTeamId/cmux", softwareTeamCmuxRoutes);

    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: Array<{ agents: string[] }>; missing?: unknown };
    expect(body.ok).toBe(true);
    expect(body.workspaces[0]!.agents).toContain("a@late-live-software-team");
    expect(body.missing).toBeUndefined();
  });

  it("OPR.0.3.4.8: no-session at first snapshot -> discovers canonical/live before timeout -> included (multiple null re-reads)", async () => {
    let inventoryCallCount = 0;
    const dynamicInventoryFn = () => {
      inventoryCallCount++;
      if (inventoryCallCount <= 3) {
        return [{ logicalId: "a", canonicalSessionName: null, sessionStatus: null, attachmentType: "tmux", podId: "p1" }] as never;
      }
      return [{ logicalId: "a", canonicalSessionName: "a@late-start-software-team", sessionStatus: "running", attachmentType: "tmux", podId: "p1" }] as never;
    };
    const app = new Hono();
    const softwareTeams = {
      "software-team-1": {
        id: "software-team-1",
        name: "late-start-software-team",
        nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: null as string | null }],
      },
    };
    const softwareTeamRepo = makeSoftwareTeamRepoStub(softwareTeams);
    const layoutService = new CmuxLayoutService(makeMockAdapter({ available: true }), { sleep: async () => {} });
    const tmux = makeTmuxAdapterStub(new Set(["a@late-start-software-team"]));
    app.use("*", async (c, next) => {
      c.set("softwareTeamRepo" as never, softwareTeamRepo);
      c.set("cmuxAdapter" as never, makeMockAdapter({ available: true }));
      c.set("cmuxLayoutService" as never, layoutService);
      c.set("nodeInventoryFn" as never, dynamicInventoryFn);
      c.set("tmuxAdapter" as never, tmux);
      c.set("readinessTimeoutMs" as never, 500);
      c.set("readinessPollMs" as never, 10);
      c.set("db" as never, {} as Database.Database);
      await next();
    });
    app.route("/api/software-teams/:softwareTeamId/cmux", softwareTeamCmuxRoutes);

    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: Array<{ agents: string[] }>; missing?: unknown };
    expect(body.ok).toBe(true);
    expect(body.workspaces[0]!.agents).toContain("a@late-start-software-team");
    expect(body.missing).toBeUndefined();
  });

  it("keeps the bounded wait when a projected-detached session reappears", async () => {
    let callCount = 0;
    const dynamicTmux = {
      ...makeTmuxAdapterStub(new Set()),
      hasSession: async () => ++callCount >= 3,
    } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
    const app = new Hono();
    const softwareTeams = {
      "software-team-1": {
        id: "software-team-1",
        name: "returning-software-team",
        nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: "a@returning-software-team", sessionStatus: "detached" as string | undefined, storedSessionStatus: "running" }],
      },
    };
    const softwareTeamRepo = makeSoftwareTeamRepoStub(softwareTeams);
    const layoutService = new CmuxLayoutService(makeMockAdapter({ available: true }), { sleep: async () => {} });
    app.use("*", async (c, next) => {
      c.set("softwareTeamRepo" as never, softwareTeamRepo);
      c.set("cmuxAdapter" as never, makeMockAdapter({ available: true }));
      c.set("cmuxLayoutService" as never, layoutService);
      c.set("nodeInventoryFn" as never, makeNodeInventoryStub(softwareTeams));
      c.set("tmuxAdapter" as never, dynamicTmux);
      c.set("readinessTimeoutMs" as never, 500);
      c.set("readinessPollMs" as never, 10);
      c.set("db" as never, {} as Database.Database);
      await next();
    });
    app.route("/api/software-teams/:softwareTeamId/cmux", softwareTeamCmuxRoutes);

    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ agents: string[] }> };
    expect(body.workspaces[0]!.agents).toContain("a@returning-software-team");
  });

  it("stops early when both projected and stored status are detached", async () => {
    let callCount = 0;
    const dynamicTmux = {
      ...makeTmuxAdapterStub(new Set()),
      hasSession: async () => { callCount++; return false; },
    } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
    const app = new Hono();
    const softwareTeams = {
      "software-team-1": {
        id: "software-team-1",
        name: "stored-detached-software-team",
        nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: "a@stored-detached-software-team", sessionStatus: "detached" as string | undefined, storedSessionStatus: "detached" }],
      },
    };
    const softwareTeamRepo = makeSoftwareTeamRepoStub(softwareTeams);
    const layoutService = new CmuxLayoutService(makeMockAdapter({ available: true }), { sleep: async () => {} });
    app.use("*", async (c, next) => {
      c.set("softwareTeamRepo" as never, softwareTeamRepo);
      c.set("cmuxAdapter" as never, makeMockAdapter({ available: true }));
      c.set("cmuxLayoutService" as never, layoutService);
      c.set("nodeInventoryFn" as never, makeNodeInventoryStub(softwareTeams));
      c.set("tmuxAdapter" as never, dynamicTmux);
      c.set("readinessTimeoutMs" as never, 500);
      c.set("readinessPollMs" as never, 10);
      c.set("db" as never, {} as Database.Database);
      await next();
    });
    app.route("/api/software-teams/:softwareTeamId/cmux", softwareTeamCmuxRoutes);

    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
    expect(callCount).toBe(2);
  });

  it("OPR.0.3.4.8: stale/exited session remains session-missing (never attached even after polling)", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "stale-poll-software-team",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@stale-poll-software-team", sessionStatus: "exited" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      liveSessions: new Set(),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { missing: Array<{ logicalId: string; reason: string }> };
    expect(body.missing[0]!.reason).toBe("session-missing");
  });

  it("softwareTeam.nodes order (DB ORDER BY created_at = pod-then-member) is preserved in agents array", async () => {
    const app = buildApp({
      softwareTeams: {
        "software-team-1": {
          id: "software-team-1",
          name: "ordered",
          nodes: [
            // Order: pod1.lead, pod1.peer, pod2.impl, pod2.qa (created_at order = spec order)
            { logicalId: "pod1.lead", podId: "p1", canonicalSessionName: "pod1.lead@ordered" },
            { logicalId: "pod1.peer", podId: "p1", canonicalSessionName: "pod1.peer@ordered" },
            { logicalId: "pod2.impl", podId: "p2", canonicalSessionName: "pod2.impl@ordered" },
            { logicalId: "pod2.qa", podId: "p2", canonicalSessionName: "pod2.qa@ordered" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/software-teams/software-team-1/cmux/launch", { method: "POST" });
    const body = (await res.json()) as { workspaces: Array<{ agents: string[] }> };
    expect(body.workspaces[0]!.agents).toEqual([
      "pod1.lead@ordered",
      "pod1.peer@ordered",
      "pod2.impl@ordered",
      "pod2.qa@ordered",
    ]);
  });
});
