import { resolve } from "node:path";
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowDeps } from "../src/commands/workflow.js";
import { createProgram } from "../src/index.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({
      state: "running",
      healthy: true,
      pid: 1234,
      port: 7434,
    })),
    getDaemonUrl: vi.fn(() => "http://localhost:7434"),
  };
});

interface StubResponse {
  status: number;
  data: unknown;
}

function makeDeps(opts?: {
  routes?: Record<string, StubResponse>;
}): {
  deps: WorkflowDeps;
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const routes = opts?.routes ?? {};
  return {
    calls,
    deps: {
      lifecycleDeps: {} as WorkflowDeps["lifecycleDeps"],
      clientFactory: () =>
        ({
          get: vi.fn(async (path: string) => {
            calls.push({ method: "GET", path });
            return routes[`GET ${path}`] ?? { status: 200, data: {} };
          }),
          getText: vi.fn(async (path: string) => {
            calls.push({ method: "GET", path });
            return { status: 200, data: "" };
          }),
          post: vi.fn(async (path: string, body: unknown) => {
            calls.push({ method: "POST", path, body });
            return routes[`POST ${path}`] ?? { status: 200, data: {} };
          }),
          delete: vi.fn(async (path: string) => {
            calls.push({ method: "DELETE", path });
            return { status: 204, data: null };
          }),
          postText: vi.fn(async (path: string) => {
            calls.push({ method: "POST", path });
            return { status: 200, data: "" };
          }),
          postExpectText: vi.fn(async (path: string) => {
            calls.push({ method: "POST", path });
            return { status: 200, data: "" };
          }),
        }) as unknown as ReturnType<WorkflowDeps["clientFactory"]>,
    },
  };
}

describe("SoftwareTeam workflow CLI (PL-004 Phase D)", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    process.exitCode = undefined;
  });

  it("workflow command registers the lifecycle inspection and control verbs", () => {
    const { deps } = makeDeps();
    const program = createProgram({ workflowDeps: deps });
    const cmd = program.commands.find((c) => c.name() === "workflow");
    expect(cmd).toBeDefined();
    const subs = cmd!.commands.map((c) => c.name()).sort();
    expect(subs).toContain("validate");
    expect(subs).toContain("instantiate");
    expect(subs).toContain("project");
    expect(subs).toContain("list");
    expect(subs).toContain("show");
    expect(subs).toContain("trace");
    expect(subs).toContain("continue");
    expect(subs).toContain("compile");
    expect(subs).toContain("instantiate-lifecycle");
    expect(subs).toContain("abort");
  });

  it("validate POSTs /api/workflow/validate with specPath", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/validate": { status: 200, data: { ok: true } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "softwareTeam", "workflow", "validate", "/abs/path.yaml", "--json"]);
    const call = calls.find((c) => c.path === "/api/workflow/validate");
    expect((call!.body as { specPath: string }).specPath).toBe("/abs/path.yaml");
  });

  it("compile POSTs the mission path and optional opaque operation key", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/compile": { status: 200, data: { eligible: false, unknowns: ["missing"] } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "softwareTeam", "workflow", "compile", "/workspace/missions/release", "--operation-key", "release-op", "--json"]);
    expect(calls.find((call) => call.path === "/api/workflow/compile")?.body).toEqual({
      missionPath: "/workspace/missions/release",
      operationKey: "release-op",
    });
  });

  it("instantiate-lifecycle POSTs the complete keyed lifecycle request", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/instantiate-lifecycle": { status: 201, data: { instance: { instanceId: "wf-1" }, entryQitemId: "q-1", replayed: false } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "softwareTeam", "workflow", "instantiate-lifecycle", "/workspace/missions/release",
      "--operation-key", "release-op", "--root-objective", "ship", "--created-by", "orch@software-team",
      "--entry-owner", "builder@software-team", "--software-team", "softwareTeam", "--json",
    ]);
    expect(calls.find((call) => call.path === "/api/workflow/instantiate-lifecycle")?.body).toEqual({
      missionPath: "/workspace/missions/release",
      operationKey: "release-op",
      rootObjective: "ship",
      createdBySession: "orch@software-team",
      entryOwnerSession: "builder@software-team",
      targetSoftwareTeam: "softwareTeam",
    });
  });

  it.each(["compile", "instantiate-lifecycle"])("%s resolves paths in the caller before transport", async (verb) => {
    const { deps, calls } = makeDeps();
    for (const path of ["missions/release", resolve("missions/release")]) {
      const program = createProgram({ workflowDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "softwareTeam", "workflow", verb, path, "--operation-key", "release-op", "--json",
        ...(verb === "instantiate-lifecycle" ? ["--root-objective", "ship", "--created-by", "orch@software-team"] : [])]);
    }
    const requests = calls.filter((call) => call.path === `/api/workflow/${verb}`);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toEqual(requests[1]?.body);
    expect(requests[0]?.body).toMatchObject({ missionPath: resolve("missions/release") });
  });

  it.each(["validate", "instantiate", "run"])("%s resolves caller-relative file paths before transport", async (verb) => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "softwareTeam", "workflow", verb, "./workflows/selected.workflow.md", "--json",
      ...(verb === "validate" ? [] : ["--root-objective", "ship", "--created-by", "orch@software-team"])]);
    const route = verb === "validate" ? "/api/workflow/validate" : "/api/workflow/instantiate";
    expect(calls.find(call => call.path === route)?.body).toMatchObject({ specPath: resolve("workflows/selected.workflow.md") });
  });

  it.each(["instantiate", "run"])("%s preserves bare discovered names while resolving an existing extensionless caller file", async (verb) => {
    const { deps, calls } = makeDeps();
    const file = `.workflow-path-${randomUUID()}`;
    writeFileSync(file, "owned fixture");
    try {
      for (const source of ["conveyor", "cached.workflow.md", file]) {
        const program = createProgram({ workflowDeps: deps });
        program.exitOverride();
        await program.parseAsync(["node", "softwareTeam", "workflow", verb, source, "--json", "--root-objective", "ship", "--created-by", "orch@software-team"]);
      }
      const requests = calls.filter(call => call.path === "/api/workflow/instantiate");
      expect(requests[0]?.body).toMatchObject({ specPath: "conveyor" });
      expect(requests[1]?.body).toMatchObject({ specPath: "cached.workflow.md" });
      expect(requests[2]?.body).toMatchObject({ specPath: resolve(file) });
    } finally {
      unlinkSync(file);
    }
  });

  it.each(["instantiate", "run"])("%s preserves a discovered name when a same-name directory exists", async (verb) => {
    const { deps, calls } = makeDeps();
    mkdirSync("conveyor");
    try {
      const program = createProgram({ workflowDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "softwareTeam", "workflow", verb, "conveyor", "--json", "--root-objective", "ship", "--created-by", "orch@software-team"]);
      expect(calls.find(call => call.path === "/api/workflow/instantiate")?.body).toMatchObject({ specPath: "conveyor" });
    } finally {
      rmdirSync("conveyor");
    }
  });

  it("instantiate POSTs /api/workflow/instantiate with required fields", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/instantiate": { status: 201, data: { instance: {}, entryQitemId: "q-1" } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "softwareTeam", "workflow", "instantiate", "/abs/spec.yaml",
      "--root-objective", "test obj",
      "--created-by", "ops@software-team",
      "--entry-owner", "alice@software-team",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/workflow/instantiate");
    const body = call!.body as Record<string, string>;
    expect(body.specPath).toBe("/abs/spec.yaml");
    expect(body.rootObjective).toBe("test obj");
    expect(body.createdBySession).toBe("ops@software-team");
    expect(body.entryOwnerSession).toBe("alice@software-team");
  });

  it("project POSTs /api/workflow/project with all fields incl exit", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/project": { status: 200, data: { nextQitemId: "q-2" } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "softwareTeam", "workflow", "project",
      "--instance", "inst-1",
      "--current-packet", "q-1",
      "--exit", "handoff",
      "--actor-session", "producer@software-team",
      "--result-note", "produced",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/workflow/project");
    const body = call!.body as Record<string, string>;
    expect(body.instanceId).toBe("inst-1");
    expect(body.currentPacketId).toBe("q-1");
    expect(body.exit).toBe("handoff");
    expect(body.actorSession).toBe("producer@software-team");
    expect(body.resultNote).toBe("produced");
  });

  it("instantiate summary names the instance and entry packet the daemon returned", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/workflow/instantiate": {
          status: 201,
          data: {
            instance: { instanceId: "wf-1", status: "active", boundSoftwareTeam: "softwareTeam" },
            entryQitemId: "q-1",
            entryOwnerSession: "dev-a@software-team",
            advisories: [],
          },
        },
      },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "softwareTeam", "workflow", "instantiate", "/abs/spec.yaml",
      "--root-objective", "test obj",
      "--created-by", "ops@software-team",
    ]);
    const out = logs.join("\n");
    expect(out).toMatch(/what:\s+Instantiated workflow from \/abs\/spec\.yaml \(instance wf-1\)/);
    expect(out).toMatch(/state:\s+active; bound to SoftwareTeam softwareTeam; entry packet q-1 owned by dev-a@software-team/);
    expect(out).toMatch(/next:\s+Inspect: SoftwareTeam workflow show wf-1 \| Open packet: SoftwareTeam queue show q-1/);
  });

  it("project summary names the packet the daemon projected and its owner", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/workflow/project": {
          status: 200,
          data: {
            instance: { instanceId: "inst-1", status: "active" },
            closurePriorPacketId: "q-1",
            closureReason: "handoff",
            nextQitemId: "q-2",
            nextOwnerSession: "dev-b@software-team",
            nextStepId: "two",
          },
        },
      },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "softwareTeam", "workflow", "project",
      "--instance", "inst-1",
      "--current-packet", "q-1",
      "--exit", "handoff",
      "--actor-session", "dev-a@software-team",
    ]);
    const out = logs.join("\n");
    expect(out).toMatch(/what:\s+Closed q-1 \(handoff\) and projected q-2 to dev-b@software-team/);
    expect(out).toMatch(/state:\s+instance inst-1 = active/);
    expect(out).toMatch(/next:\s+Inspect: SoftwareTeam queue show q-2/);
  });

  it("list GETs /api/workflow/list optionally with status filter", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/workflow/list?status=active": { status: 200, data: [] } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "softwareTeam", "workflow", "list", "--status", "active", "--json"]);
    expect(calls.find((c) => c.path === "/api/workflow/list?status=active")).toBeDefined();
  });

  it("show GETs /api/workflow/:instanceId", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/workflow/inst-1": { status: 200, data: { instanceId: "inst-1" } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "softwareTeam", "workflow", "show", "inst-1", "--json"]);
    expect(calls.find((c) => c.path === "/api/workflow/inst-1")).toBeDefined();
  });

  it("trace GETs /api/workflow/:instanceId/trace", async () => {
    const { deps, calls } = makeDeps({
      routes: { "GET /api/workflow/inst-1/trace": { status: 200, data: { instance: {}, trail: [] } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "softwareTeam", "workflow", "trace", "inst-1", "--json"]);
    expect(calls.find((c) => c.path === "/api/workflow/inst-1/trace")).toBeDefined();
  });

  it("continue POSTs /api/workflow/:instanceId/continue", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/workflow/inst-1/continue": { status: 200, data: { instance: {}, trail: [] } } },
    });
    const program = createProgram({ workflowDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "softwareTeam", "workflow", "continue", "inst-1", "--json"]);
    expect(calls.find((c) => c.path === "/api/workflow/inst-1/continue")).toBeDefined();
  });

  it("route, resume, and abort preserve exact packet/occurrence control selectors", async () => {
    const { deps, calls } = makeDeps();
    const routeProgram = createProgram({ workflowDeps: deps });
    routeProgram.exitOverride();
    await routeProgram.parseAsync([
      "node", "softwareTeam", "workflow", "route", "wf-1", "--packet", "q-left", "--to", "left2@software-team",
      "--actor-session", "orch@software-team", "--reason", "seat retired", "--json",
    ]);
    const resumeProgram = createProgram({ workflowDeps: deps });
    resumeProgram.exitOverride();
    await resumeProgram.parseAsync([
      "node", "softwareTeam", "workflow", "resume", "wf-1", "--occurrence", "q-failed",
      "--actor-session", "orch@software-team", "--decision", "retry exact branch", "--json",
    ]);
    const abortProgram = createProgram({ workflowDeps: deps });
    abortProgram.exitOverride();
    await abortProgram.parseAsync([
      "node", "softwareTeam", "workflow", "abort", "wf-1", "--reason", "operator stopped",
      "--actor-session", "orch@software-team", "--json",
    ]);
    expect(calls.find((call) => call.path === "/api/workflow/wf-1/route")?.body).toMatchObject({ packetId: "q-left" });
    expect(calls.find((call) => call.path === "/api/workflow/wf-1/resume")?.body).toMatchObject({ occurrenceId: "q-failed" });
    expect(calls.find((call) => call.path === "/api/workflow/wf-1/abort")?.body).toEqual({ reason: "operator stopped", actorSession: "orch@software-team" });
  });
});
