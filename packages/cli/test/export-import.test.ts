import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createProgram } from "../src/index.js";
import http from "node:http";
import { Command } from "commander";
import { exportCommand, type ExportDeps } from "../src/commands/export.js";
import { importCommand, type ImportDeps } from "../src/commands/import.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
    ...overrides,
  };
}

function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    console.warn = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
    }
    resolve(logs);
  });
}

function runningState(port: number): DaemonState {
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-24T00:00:00Z" };
}

function runningLifecycleDeps(port: number): LifecycleDeps {
  return mockLifecycleDeps({
    exists: vi.fn((p: string) => p === STATE_FILE),
    readFile: vi.fn((p: string) => {
      if (p === STATE_FILE) return JSON.stringify(runningState(port));
      return null;
    }),
    fetch: vi.fn(async () => ({ ok: true })),
  });
}

function stoppedLifecycleDeps(): LifecycleDeps {
  return mockLifecycleDeps({
    exists: vi.fn(() => false),
    fetch: vi.fn(async () => { throw new Error("refused"); }),
  });
}

function unhealthyLifecycleDeps(): LifecycleDeps {
  return mockLifecycleDeps({
    exists: vi.fn((p: string) => p === STATE_FILE),
    readFile: vi.fn((p: string) => {
      if (p === STATE_FILE) return JSON.stringify(runningState(7434));
      return null;
    }),
    isProcessAlive: vi.fn(() => true),
    fetch: vi.fn(async () => { throw new Error("refused"); }),
  });
}

// Track captured headers for import assertions
let capturedImportHeaders: Record<string, string | string[] | undefined> = {};
let capturedImportPath = "";

// Mock daemon for export/import
function createMockDaemon() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");

    // GET /api/software-teams/:softwareTeamId/spec -> YAML
    if (req.method === "GET" && url.pathname.match(/^\/api\/software-teams\/[^/]+\/spec$/)) {
      const softwareTeamId = url.pathname.split("/")[3]!;
      if (softwareTeamId === "missing") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "SoftwareTeam not found" }));
        return;
      }
      if (softwareTeamId === "broken") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("internal server error");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/yaml" });
      res.end("schema_version: 1\nname: test-software-team\nnodes: []\n");
      return;
    }

    // POST /api/software-teams/import/validate
    if (req.method === "POST" && url.pathname === "/api/software-teams/import/validate") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (body.includes("INVALID")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: false, errors: ["bad yaml"] }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: true, errors: [] }));
        }
      });
      return;
    }

    // POST /api/software-teams/import/preflight
    if (req.method === "POST" && url.pathname === "/api/software-teams/import/preflight") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: false, warnings: ["cmux unavailable"], errors: ["SoftwareTeam name exists"] }));
      return;
    }

    // POST /api/software-teams/import
    if (req.method === "POST" && url.pathname === "/api/software-teams/import") {
      capturedImportHeaders = {
        "x-software-team-root": req.headers["x-software-team-root"],
        "x-cwd-override": req.headers["x-cwd-override"],
      };
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (body.includes("CONFLICT")) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, code: "preflight_failed", message: "conflict" }));
        } else {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ softwareTeamId: "software-team-new", specName: "imported-software-team", specVersion: "0.1.0", nodes: [{ logicalId: "orchestrator", status: "launched" }, { logicalId: "worker", status: "launched" }], attachCommand: "tmux attach -t orch-lead@imported-software-team", warnings: ["Startup submission unverified in worker@imported-software-team"] }));
        }
      });
      return;
    }

    // POST /api/software-teams/import/materialize
    if (req.method === "POST" && url.pathname === "/api/software-teams/import/materialize") {
      capturedImportPath = url.pathname;
      capturedImportHeaders = {
        "x-software-team-root": req.headers["x-software-team-root"],
        "x-target-software-team-id": req.headers["x-target-software-team-id"],
        "x-cwd-override": req.headers["x-cwd-override"],
      };
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        softwareTeamId: req.headers["x-target-software-team-id"] ?? "software-team-new",
        specName: "imported-software-team",
        specVersion: "0.2",
        nodes: [{ logicalId: "research.scout", status: "materialized" }],
      }));
      return;
    }

    // POST /api/software-teams/import/workspace
    if (req.method === "POST" && url.pathname === "/api/software-teams/import/workspace") {
      capturedImportPath = url.pathname;
      capturedImportHeaders = { "x-target-software-team-id": req.headers["x-target-software-team-id"] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        softwareTeamId: req.headers["x-target-software-team-id"],
        changed: true,
        workspace: { workspaceRoot: "/workspace", repos: [] },
      }));
      return;
    }

    // healthz
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
    listen: () => new Promise<number>((r) => {
      server.listen(0, () => {
        const addr = server.address();
        r(typeof addr === "object" && addr ? addr.port : 0);
      });
    }),
  };
}

describe("SoftwareTeam export + import", () => {
  let srv: ReturnType<typeof createMockDaemon>;
  let port: number;

  beforeAll(async () => {
    srv = createMockDaemon();
    port = await srv.listen();
  });
  afterAll(async () => { await srv.close(); });

  function exportDeps(overrides?: Partial<ExportDeps>): ExportDeps {
    return {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      writeFile: vi.fn(),
      ...overrides,
    };
  }

  function importDeps(fileContent: string, overrides?: Partial<ImportDeps>): ImportDeps {
    return {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      readFile: vi.fn(() => fileContent),
      ...overrides,
    };
  }

  // Test 1: export writes YAML to -o path
  it("export: writes YAML to specified path", async () => {
    const writeFile = vi.fn();
    const deps = exportDeps({ writeFile });
    const program = new Command();
    program.addCommand(exportCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "export", "software-team-1", "-o", "out.yaml"]));
    expect(writeFile).toHaveBeenCalledWith("out.yaml", "schema_version: 1\nname: test-software-team\nnodes: []\n");
    expect(logs.join("\n")).toContain("out.yaml");
  });

  // Test 2: export default path software-team.yaml
  it("export: default output path is software-team.yaml", async () => {
    const writeFile = vi.fn();
    const deps = exportDeps({ writeFile });
    const program = new Command();
    program.addCommand(exportCommand(deps));
    await captureLogs(() => program.parseAsync(["node", "softwareTeam", "export", "software-team-1"]));
    expect(writeFile).toHaveBeenCalledWith("software-team.yaml", expect.any(String));
  });

  // Test 3: export softwareTeam not found (404)
  it("export: SoftwareTeam not found -> error", async () => {
    const deps = exportDeps();
    const program = new Command();
    program.addCommand(exportCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "export", "missing"]));
    expect(logs.join("\n")).toMatch(/not found/i);
  });

  // Test 4: import validate prints result
  it("import validate: prints valid result", async () => {
    const deps = importDeps("schema_version: 1\nname: test\n");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml"]));
    expect(logs.join("\n")).toMatch(/valid/i);
  });

  // Test 5: import invalid YAML (400)
  it("import: invalid YAML -> errors", async () => {
    const deps = importDeps("INVALID");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml"]));
    expect(logs.join("\n")).toMatch(/bad yaml|invalid/i);
  });

  // Test 6: import --instantiate prints per-node status
  it("#729: import --instantiate: prints nodes", async () => {
    const deps = importDeps("schema_version: 1\nname: test\n");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml", "--instantiate"]));
    const output = logs.join("\n");
    expect(output).toContain("imported-software-team");
    expect(output).toContain("orchestrator");
    expect(output).toContain("worker");
    // Must include per-node status, not just names
    expect(output).toMatch(/orchestrator: launched/);
    expect(output).toMatch(/worker: launched/);
    expect(output).toContain("Warning: Startup submission unverified in worker@imported-software-team");
  });

  // Test 7: import --preflight prints warnings + errors
  it("import --preflight: prints warnings and errors", async () => {
    const deps = importDeps("schema_version: 1\nname: test\n");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml", "--preflight"]));
    const output = logs.join("\n");
    expect(output).toContain("cmux unavailable");
    expect(output).toContain("SoftwareTeam name exists");
  });

  it("import --materialize-only prints materialized nodes", async () => {
    const deps = importDeps(`version: "0.2"\nname: test\npods: []\n`);
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml", "--materialize-only", "--software-team-root", "/tmp"]));
    const output = logs.join("\n");
    expect(output).toContain("imported-software-team");
    expect(output).toMatch(/research\.scout: materialized/);
  });

  it("import --materialize-only with --target-software-team forwards target header", async () => {
    const deps = importDeps(`version: "0.2"\nname: test\npods: []\n`);
    const program = new Command();
    program.addCommand(importCommand(deps));
    await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml", "--materialize-only", "--target-software-team", "software-team-123", "--software-team-root", "/tmp"]));
    expect(capturedImportHeaders["x-target-software-team-id"]).toBe("software-team-123");
  });

  it("import --materialize-only with --cwd forwards absolute cwd override", async () => {
    capturedImportHeaders = {};
    const deps = importDeps(`version: "0.2"\nname: test\npods: []\n`);
    const program = new Command();
    program.addCommand(importCommand(deps));
    await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml", "--materialize-only", "--cwd", "relative/project", "--software-team-root", "/tmp"]));
    expect(capturedImportHeaders["x-cwd-override"]).toMatch(/^\//);
    expect(String(capturedImportHeaders["x-cwd-override"])).toContain("relative/project");
  });

  it("import --workspace-only targets the workspace-only route", async () => {
    capturedImportHeaders = {};
    capturedImportPath = "";
    const deps = importDeps(`version: "0.2"\nname: test\nworkspace:\n  workspace_root: /workspace\n  repos: []\npods: []\n`);
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync([
      "node", "softwareTeam", "import", "software-team.yaml", "--workspace-only", "--target-software-team", "software-team-123",
    ]));
    expect(capturedImportPath).toBe("/api/software-teams/import/workspace");
    expect(capturedImportHeaders["x-target-software-team-id"]).toBe("software-team-123");
    expect(logs.join("\n")).toContain("Workspace applied to SoftwareTeam software-team-123");
  });

  it("import --workspace-only requires --target-software-team before HTTP", async () => {
    capturedImportPath = "";
    const deps = importDeps(`version: "0.2"\nname: test\nworkspace:\n  workspace_root: /workspace\n  repos: []\npods: []\n`);
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync([
      "node", "softwareTeam", "import", "software-team.yaml", "--workspace-only",
    ]));
    expect(logs.join("\n")).toMatch(/--target-software-team/);
    expect(capturedImportPath).toBe("");
  });

  // Test 8: import --instantiate with preflight fail (409)
  it("import --instantiate: preflight conflict (409)", async () => {
    const deps = importDeps("CONFLICT");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml", "--instantiate"]));
    expect(logs.join("\n")).toMatch(/conflict|failed/i);
  });

  // Test 9: export daemon stopped -> no HTTP
  it("export: daemon stopped -> no HTTP", async () => {
    const clientFactory = vi.fn();
    const deps: ExportDeps = {
      lifecycleDeps: stoppedLifecycleDeps(),
      clientFactory: clientFactory as unknown as ExportDeps["clientFactory"],
      writeFile: vi.fn(),
    };
    const program = new Command();
    program.addCommand(exportCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "export", "software-team-1"]));
    expect(logs.join("\n")).toMatch(/not running/i);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // Test 10: import uses stored port from daemon.json
  it("import: uses stored port from daemon.json", async () => {
    const usedUrls: string[] = [];
    const deps: ImportDeps = {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => { usedUrls.push(baseUrl); return new DaemonClient(baseUrl); },
      readFile: vi.fn(() => "schema_version: 1\nname: test\n"),
    };
    const program = new Command();
    program.addCommand(importCommand(deps));
    await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml"]));
    expect(usedUrls[0]).toBe(`http://127.0.0.1:${port}`);
  });

  // Test 11: createProgram: both export AND import mounted
  it("createProgram mounts both export and import commands", async () => {
    const stoppedLC = stoppedLifecycleDeps();

    const exportD: ExportDeps = { lifecycleDeps: stoppedLC, clientFactory: vi.fn() as never, writeFile: vi.fn() };
    const importD: ImportDeps = { lifecycleDeps: stoppedLC, clientFactory: vi.fn() as never, readFile: vi.fn(() => "yaml") };

    // export mounted
    const p1 = createProgram({ exportDeps: exportD });
    const logs1 = await captureLogs(() => p1.parseAsync(["node", "softwareTeam", "export", "x"]));
    expect(logs1.join("\n")).toMatch(/not running/i);

    // import mounted
    const p2 = createProgram({ importDeps: importD });
    const logs2 = await captureLogs(() => p2.parseAsync(["node", "softwareTeam", "import", "x.yaml"]));
    // Will hit "cannot read file" or "not running" — either proves it's mounted
    expect(logs2.join("\n").length).toBeGreaterThan(0);
  });

  // Test 12: export unhealthy daemon -> error, no HTTP
  it("export: unhealthy daemon -> error, no HTTP", async () => {
    const clientFactory = vi.fn();
    const deps: ExportDeps = {
      lifecycleDeps: unhealthyLifecycleDeps(),
      clientFactory: clientFactory as unknown as ExportDeps["clientFactory"],
      writeFile: vi.fn(),
    };
    const program = new Command();
    program.addCommand(exportCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "export", "software-team-1"]));
    expect(logs.join("\n")).toMatch(/did not respond|busy or stopped|unhealthy/i) // B8 supersession: epistemic guard language;
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // Test 13: import daemon stopped -> no HTTP
  it("import: daemon stopped -> no HTTP", async () => {
    const clientFactory = vi.fn();
    const deps: ImportDeps = {
      lifecycleDeps: stoppedLifecycleDeps(),
      clientFactory: clientFactory as unknown as ImportDeps["clientFactory"],
      readFile: vi.fn(() => "yaml"),
    };
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml"]));
    expect(logs.join("\n")).toMatch(/not running/i);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // Test 14: import missing file -> clear error, no HTTP
  it("import: missing file -> error, no HTTP", async () => {
    const clientFactory = vi.fn();
    const deps: ImportDeps = {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: clientFactory as unknown as ImportDeps["clientFactory"],
      readFile: vi.fn(() => { throw new Error("ENOENT"); }),
    };
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "missing.yaml"]));
    expect(logs.join("\n")).toMatch(/cannot read/i);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // Test 15: export 500 -> generic error
  it("export: 500 -> generic error", async () => {
    const deps = exportDeps();
    const program = new Command();
    program.addCommand(exportCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "export", "broken"]));
    expect(logs.join("\n")).toMatch(/failed|error/i);
  });

  // T5: import --instantiate pod-aware + --software-team-root -> sends X-Software-Team-Root header
  it("import --instantiate pod-aware with --software-team-root sends X-Software-Team-Root header", async () => {
    capturedImportHeaders = {};
    const deps = importDeps("schema_version: 1\nname: test\npods:\n  - name: pod-a\n");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml", "--instantiate", "--software-team-root", "/my/project"]));
    const output = logs.join("\n");
    expect(output).toContain("imported-software-team");
    // Verify X-Software-Team-Root header was sent
    expect(capturedImportHeaders["x-software-team-root"]).toMatch(/\/my\/project/);
  });

  it("import --instantiate with --cwd forwards absolute cwd override", async () => {
    capturedImportHeaders = {};
    const deps = importDeps("schema_version: 1\nname: test\npods:\n  - name: pod-a\n");
    const program = new Command();
    program.addCommand(importCommand(deps));
    await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml", "--instantiate", "--cwd", "relative/project", "--software-team-root", "/my/project"]));
    expect(capturedImportHeaders["x-cwd-override"]).toMatch(/^\//);
    expect(String(capturedImportHeaders["x-cwd-override"])).toContain("relative/project");
  });

  // NS-T14: import --instantiate handoff includes attach command
  it("import --instantiate success shows attach command", async () => {
    const deps: ImportDeps = {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      readFile: () => 'version: "0.2"\nname: test\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: impl\n        agent_ref: "local:agents/impl"\n        profile: default\n        runtime: claude-code\n        cwd: .\n    edges: []\nedges: []',
    };
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml", "--instantiate"]));
    const output = logs.join("\n");
    expect(output).toContain("Attach:");
    expect(output).toContain("tmux attach -t orch-lead@imported-software-team");
  });

  it("import --instantiate uses a long-running daemon timeout budget", async () => {
    let timeoutMs: number | undefined;
    const postText = vi.fn(async (
      _path: string,
      _text: string,
      _contentType?: string,
      _extraHeaders?: Record<string, string>,
      options?: { timeoutMs?: number },
    ) => {
      timeoutMs = options?.timeoutMs;
      return {
        status: 201,
        data: {
          softwareTeamId: "software-team-new",
          specName: "imported-software-team",
          specVersion: "0.1.0",
          nodes: [{ logicalId: "orchestrator", status: "launched" }],
          attachCommand: "tmux attach -t orch-lead@imported-software-team",
        },
      };
    });

    const deps: ImportDeps = {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: () => ({ postText } as unknown as DaemonClient),
      readFile: vi.fn(() => 'version: "0.2"\nname: test\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: impl\n        agent_ref: "local:agents/impl"\n        profile: default\n        runtime: claude-code\n        cwd: .\n    edges: []\nedges: []'),
    };

    const program = new Command();
    program.addCommand(importCommand(deps));

    await captureLogs(() => program.parseAsync(["node", "softwareTeam", "import", "software-team.yaml", "--instantiate"]));

    expect(timeoutMs).toBe(120_000);
  });
});
