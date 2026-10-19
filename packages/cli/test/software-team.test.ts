import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { softwareTeamCommand, type SoftwareTeamDeps } from "../src/commands/software-team.js";
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

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

function runningState(port: number): DaemonState {
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-29T00:00:00Z" };
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

// Track received headers for assertion
let capturedHeaders: Record<string, string | undefined> = {};

function createMockDaemon() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // POST /api/software-teams/import/preflight
    if (req.method === "POST" && url.pathname === "/api/software-teams/import/preflight") {
      capturedHeaders = {
        "x-software-team-root": req.headers["x-software-team-root"] as string | undefined,
      };
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (body.includes("AMBIGUOUS")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: false, warnings: [], errors: ["ambiguous node collision: orchestrator defined in multiple pods"] }));
        } else if (body.includes("COLLISION")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: false, warnings: ["node name collision: worker shadows pod-a/worker"], errors: [] }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: true, warnings: ["cmux unavailable"], errors: [] }));
        }
      });
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

describe("SoftwareTeam spec", () => {
  let srv: ReturnType<typeof createMockDaemon>;
  let port: number;

  beforeAll(async () => {
    srv = createMockDaemon();
    port = await srv.listen();
  });
  afterAll(async () => { await srv.close(); });

  function softwareTeamDeps(fileContent: string): SoftwareTeamDeps {
    return {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      readFile: vi.fn(() => fileContent),
    };
  }

  // T3: softwareTeam spec validate invalid softwareTeam -> exit 1, output contains errors
  it("SoftwareTeam spec validate invalid: prints errors, exitCode 1", async () => {
    const deps = softwareTeamDeps("{}");
    const program = new Command();
    program.addCommand(softwareTeamCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "spec", "validate", "software-team.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("name is required");
    expect(output).toContain("version is required");
    expect(exitCode).toBe(1);
  });

  // OPR.0.5.3.3 item 2: alias-pin advisories print (fail-open — spec still valid, exit not 1).
  it("SoftwareTeam spec validate prints alias-pin advisories naming the canonical id, fail-open", async () => {
    const deps = softwareTeamDeps('name: example\nversion: "1"\nnodes: [{ id: worker, runtime: claude-code, model: fable }]\n');
    const program = new Command();
    program.addCommand(softwareTeamCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "spec", "validate", "software-team.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("spec advisory"); // advisory surfaced
    expect(output).toContain("claude-fable-5"); // names the canonical id
    expect(output).toContain("SoftwareTeam spec valid"); // fail-open: still valid
    expect(exitCode).not.toBe(1);
  });

  it.each([
    ['version: "0.2"\nname: local\npods: [{ id: dev, label: Dev, members: [{ id: worker, agent_ref: "local:worker", profile: default, runtime: claude-code, cwd: . }], edges: [] }]\nedges: []\n', true],
    ['version: "1"\nname: legacy\nnodes: []\nedges: []\n', true],
    ["pods: [", false],
  ])("validates local YAML without lifecycle or client calls: %s", async (yaml, valid) => {
    const lifecycleDeps = mockLifecycleDeps();
    const clientFactory = vi.fn(() => { throw new Error("validation must not connect to a daemon"); });
    const program = new Command().addCommand(softwareTeamCommand({
      lifecycleDeps, clientFactory, readFile: () => yaml,
    }));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "spec", "validate", "software-team.yaml", "--json"]));
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ valid, errors: expect.any(Array) });
    expect(exitCode ?? 0).toBe(valid ? 0 : 1);
    expect(clientFactory).not.toHaveBeenCalled();
    for (const operation of Object.values(lifecycleDeps)) expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    'version: "1"\nname: broken\nnodes: [null]\n',
    'version: "1"\nname: broken\nnodes: []\nedges: [null]\n',
  ])("reports validator exceptions as internal failure, not invalid YAML: %s", async (yaml) => {
    for (const json of [false, true]) {
      const lifecycleDeps = mockLifecycleDeps();
      const clientFactory = vi.fn(() => { throw new Error("must stay local"); });
      const program = new Command().addCommand(softwareTeamCommand({ lifecycleDeps, clientFactory, readFile: () => yaml }));
      const { logs, exitCode } = await captureLogs(() => program.parseAsync([
        "node", "softwareTeam", "spec", "validate", "software-team.yaml", ...(json ? ["--json"] : []),
      ]));
      expect(exitCode).toBe(1);
      const message = "Internal validator error; validation did not complete.";
      if (json) expect(JSON.parse(logs.join("\n"))).toEqual({ error: message });
      else expect(logs.join("\n")).toBe(message);
      expect(clientFactory).not.toHaveBeenCalled();
      for (const operation of Object.values(lifecycleDeps)) expect(operation).not.toHaveBeenCalled();
    }
  });

  it("reports a null topology pod as structured invalid YAML, without contacting a daemon", async () => {
    const yaml = 'version: "0.2"\nname: broken\npods: [null]\n';
    for (const json of [false, true]) {
      const lifecycleDeps = mockLifecycleDeps();
      const clientFactory = vi.fn(() => { throw new Error("must stay local"); });
      const program = new Command().addCommand(softwareTeamCommand({ lifecycleDeps, clientFactory, readFile: () => yaml }));
      const { logs, exitCode } = await captureLogs(() => program.parseAsync([
        "node", "softwareTeam", "spec", "validate", "software-team.yaml", ...(json ? ["--json"] : []),
      ]));
      expect(exitCode).toBe(1);
      if (json) expect(JSON.parse(logs.join("\n"))).toMatchObject({ valid: false, errors: ["pods[0]: must be an object"] });
      else expect(logs.join("\n")).toBe("SoftwareTeam spec invalid:\n  pods[0]: must be an object\nFix: update software-team.yaml and re-validate.");
      expect(clientFactory).not.toHaveBeenCalled();
      for (const operation of Object.values(lifecycleDeps)) expect(operation).not.toHaveBeenCalled();
    }
  });

  it("advertises local validation in command help", () => {
    const validate = softwareTeamCommand().commands.find(command => command.name() === "validate")!;
    expect(validate.helpInformation()).toContain("locally (no daemon required)");
  });

  // Slice 16 (item 2): softwareTeam spec audit flags stale seat ids in the culture.
  function softwareTeamDepsMap(files: Record<string, string>): SoftwareTeamDeps {
    return {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      readFile: vi.fn((p: string) => {
        const key = Object.keys(files).find((k) => p.endsWith(k));
        if (key === undefined) throw new Error(`no such file: ${p}`);
        return files[key]!;
      }),
    };
  }

  it("SoftwareTeam spec audit: flags a stale culture seat id after a rename", async () => {
    const softwareTeamYaml = "schema_version: 1\nname: t\nculture_file: CULTURE.md\npods:\n  - id: dev1\n    members:\n      - id: builder\n      - id: qa\n";
    // culture still names the OLD id `dev1.impl` (renamed to dev1.builder)
    const culture = "The dev pod: `dev1.builder` builds, dispatch to `dev1.impl` for legacy, `dev1.qa` gates.";
    const deps = softwareTeamDepsMap({ "software-team.yaml": softwareTeamYaml, "CULTURE.md": culture });
    const program = new Command();
    program.addCommand(softwareTeamCommand(deps));
    const { logs } = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "spec", "audit", "/x/software-team.yaml", "--json"]));
    const result = JSON.parse(logs.join("\n"));
    const stale = result.findings.find((f: { kind: string }) => f.kind === "stale_culture_seat_id");
    expect(stale).toBeDefined();
    expect(stale.message).toContain("dev1.impl");
  });

  it("SoftwareTeam spec audit: consistent culture ids → no stale finding; a file path is not a false positive", async () => {
    const softwareTeamYaml = "schema_version: 1\nname: t\nculture_file: CULTURE.md\nstartup:\n  files: [x.md]\npods:\n  - id: dev1\n    members:\n      - id: impl\n";
    const culture = "The `dev1.impl` implements. See `docs/reference.md` and `README.md`.";
    const deps = softwareTeamDepsMap({ "software-team.yaml": softwareTeamYaml, "CULTURE.md": culture });
    const program = new Command();
    program.addCommand(softwareTeamCommand(deps));
    const { logs } = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "spec", "audit", "/x/software-team.yaml", "--json"]));
    const result = JSON.parse(logs.join("\n"));
    expect(result.findings.map((f: { kind: string }) => f.kind)).not.toContain("stale_culture_seat_id");
  });

  // T4: softwareTeam spec preflight -> exit 0, output contains "ready" + warnings
  it("SoftwareTeam spec preflight ready: prints ready + warnings", async () => {
    const deps = softwareTeamDeps("schema_version: 1\nname: test-software-team\nnodes: []\n");
    const program = new Command();
    program.addCommand(softwareTeamCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "spec", "preflight", "/tmp/software-team.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("Preflight ready");
    expect(output).toContain("cmux unavailable");
    expect(exitCode).toBeUndefined();
  });

  // T7: softwareTeam spec preflight with collision warnings -> output shows warnings
  it("SoftwareTeam spec preflight with collision warnings: shows warnings", async () => {
    const deps = softwareTeamDeps("schema_version: 1\nname: test-software-team\nCOLLISION\nnodes: []\n");
    const program = new Command();
    program.addCommand(softwareTeamCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "spec", "preflight", "/tmp/software-team.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("node name collision");
    expect(output).toContain("not ready");
    expect(exitCode).toBe(1);
  });

  // T8: softwareTeam spec preflight with ambiguous collision -> exit 1, output shows error
  it("SoftwareTeam spec preflight with ambiguous collision: exit 1, shows error", async () => {
    const deps = softwareTeamDeps("schema_version: 1\nname: test-software-team\nAMBIGUOUS\nnodes: []\n");
    const program = new Command();
    program.addCommand(softwareTeamCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "softwareTeam", "spec", "preflight", "/tmp/software-team.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("ambiguous node collision");
    expect(output).toContain("not ready");
    expect(exitCode).toBe(1);
  });

  it("SoftwareTeam spec audit reports missing culture and startup context without blocking", async () => {
    const clientFactory = vi.fn(() => new DaemonClient(`http://127.0.0.1:${port}`));
    const deps: SoftwareTeamDeps = {
      lifecycleDeps: mockLifecycleDeps(),
      clientFactory,
      readFile: vi.fn(() => "version: '0.2'\nname: sparse-software-team\npods: []\nedges: []\n"),
    };
    const program = new Command();
    program.exitOverride();
    const specCommand = softwareTeamCommand(deps);
    specCommand.exitOverride();
    program.addCommand(specCommand);

    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "softwareTeam", "spec", "audit", "software-team.yaml"]),
    );
    const output = logs.join("\n");
    expect(output).toContain("2 advisory findings");
    expect(output).toContain("culture_file");
    expect(output).toContain("startup.files");
    expect(output).toContain("softwareteam-architect");
    expect(exitCode).toBeUndefined();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("SoftwareTeam spec audit reports a complete spec clean as JSON", async () => {
    const deps = softwareTeamDeps([
      "version: '0.2'",
      "name: complete-software-team",
      "culture_file: CULTURE.md",
      "startup:",
      "  files:",
      "    - path: startup/context.md",
      "      delivery_hint: guidance_merge",
      "pods: []",
      "edges: []",
      "",
    ].join("\n"));
    const program = new Command();
    program.exitOverride();
    const specCommand = softwareTeamCommand(deps);
    specCommand.exitOverride();
    program.addCommand(specCommand);

    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "softwareTeam", "spec", "audit", "software-team.yaml", "--json"]),
    );
    expect(JSON.parse(logs.join("\n"))).toEqual({
      clean: true,
      findingCount: 0,
      findings: [],
    });
    expect(exitCode).toBeUndefined();
  });
});
