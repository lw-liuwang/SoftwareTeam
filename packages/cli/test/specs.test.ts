import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { specsCommand } from "../src/commands/specs.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return { spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log; const origErr = console.error; const origExitCode = process.exitCode; process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" ")); console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; } const exitCode = process.exitCode; process.exitCode = origExitCode; resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return { lifecycleDeps: { ...mockLifecycleDeps(), exists: vi.fn((p: string) => p === STATE_FILE), readFile: vi.fn((p: string) => { if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-03T00:00:00Z" } as DaemonState); return null; }), fetch: vi.fn(async () => ({ ok: true })) }, clientFactory: (baseUrl) => new DaemonClient(baseUrl) };
}

const LIBRARY_ENTRIES = [
  { id: "abc123", kind: "softwareTeam", name: "review-software-team", version: "0.2", sourceType: "builtin", sourcePath: "/builtin/review-software-team.yaml", relativePath: "review-software-team.yaml", updatedAt: "2026-04-01T00:00:00Z", summary: "A review softwareTeam" },
  { id: "def456", kind: "agent", name: "impl-agent", version: "1.0", sourceType: "user_file", sourcePath: "/home/user/.softwareteam/specs/impl-agent.yaml", relativePath: "impl-agent.yaml", updatedAt: "2026-04-01T00:00:00Z" },
];

const SOFTWARE_TEAM_REVIEW = {
  sourceState: "library_item", kind: "softwareTeam", name: "review-software-team", version: "0.2", format: "pod_aware",
  libraryEntryId: "abc123", sourcePath: "/builtin/review-software-team.yaml",
  pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", runtime: "claude-code", profile: "default" }], edges: [] }],
  edges: [], graph: { nodes: [], edges: [] }, raw: "name: review-software-team\n",
};

describe("Specs CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      if (url === "/api/specs/library" || url.startsWith("/api/specs/library?")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        const kind = new URL(`http://localhost${url}`).searchParams.get("kind");
        const filtered = kind ? LIBRARY_ENTRIES.filter((e) => e.kind === kind) : LIBRARY_ENTRIES;
        res.end(JSON.stringify(filtered));
      } else if (url === "/api/specs/library/abc123") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ entry: LIBRARY_ENTRIES[0], yaml: "name: review-software-team\n" }));
      } else if (url === "/api/specs/library/abc123/review") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(SOFTWARE_TEAM_REVIEW));
      } else if (url === "/api/specs/library/abc123" && req.method === "DELETE") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: "abc123", name: "review-software-team" }));
      } else if (url === "/api/specs/library/abc123/rename" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          entry: { ...LIBRARY_ENTRIES[0], id: "renamed123", name: "renamed-software-team", sourcePath: "/builtin/renamed-software-team.yaml" },
        }));
      } else if (url === "/api/specs/library/sync" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(LIBRARY_ENTRIES));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(specsCommand(runningDeps(port)));
    return prog;
  }

  it("specs help calls out managed apps in the library", () => {
    const logs: string[] = [];
    const cmd = makeCmd().commands.find((c) => c.name() === "specs")!;
    cmd.configureOutput({ writeOut: (str) => logs.push(str), writeErr: (str) => logs.push(str) });
    cmd.outputHelp();
    const help = logs.join("");
    expect(help).toContain("Browse, preview, and manage the spec library, including managed apps");
    expect(help).toContain("SoftwareTeam specs ls");
    expect(help).toContain("SoftwareTeam specs preview secrets-manager");
    expect(help).toContain("Add a spec file or full spec directory to the user library");
  });

  it("specs ls prints library entries", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "softwareTeam", "specs", "ls"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("review-software-team");
    expect(output).toContain("impl-agent");
  });

  it("specs ls --json prints raw JSON array", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "softwareTeam", "specs", "ls", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });

  it("specs show resolves by name and prints metadata", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "softwareTeam", "specs", "show", "review-software-team"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("review-software-team");
    expect(output).toContain("/builtin/review-software-team.yaml");
  });

  it("specs show with ambiguous name errors with candidates", async () => {
    // Create a server with duplicate names
    const dupServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { ...LIBRARY_ENTRIES[0], id: "aaa" },
        { ...LIBRARY_ENTRIES[0], id: "bbb", sourcePath: "/other/review-software-team.yaml" },
      ]));
    });
    await new Promise<void>((resolve) => { dupServer.listen(0, resolve); });
    const dupPort = (dupServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(specsCommand(runningDeps(dupPort)));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "softwareTeam", "specs", "show", "review-software-team"]);
    });
    dupServer.close();

    expect(logs.join("\n")).toContain("ambiguous");
    expect(exitCode).toBe(1);
  });

  it("specs show --kind resolves same-name softwareTeam/workflow entries", async () => {
    const dupServer = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      if (url === "/api/specs/library?kind=softwareTeam") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ ...LIBRARY_ENTRIES[0], id: "software-team-same", kind: "softwareTeam", name: "conveyor" }]));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => { dupServer.listen(0, resolve); });
    const dupPort = (dupServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(specsCommand(runningDeps(dupPort)));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "softwareTeam", "specs", "show", "conveyor", "--kind", "softwareTeam"]);
    });
    dupServer.close();

    const output = logs.join("\n");
    expect(output).toContain("Kind:     softwareTeam");
    expect(output).toContain("/builtin/review-software-team.yaml");
    expect(exitCode).toBeUndefined();
  });

  it("specs show not-found error points people back to managed apps in the library", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "softwareTeam", "specs", "show", "missing-app"]);
    });

    expect(logs.join("\n")).toContain("Run 'SoftwareTeam specs ls' to see available softwareTeams, agents, workflows, and managed apps.");
    expect(exitCode).toBe(1);
  });

  it("specs preview --json returns structured review", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "softwareTeam", "specs", "preview", "review-software-team", "--kind", "softwareTeam", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.kind).toBe("softwareTeam");
    expect(parsed.sourceState).toBe("library_item");
    expect(parsed.libraryEntryId).toBe("abc123");
  });

  it.each([
    ["starter", "builtin", "softwareTeam", true],
    ["factory", "builtin", "softwareTeam", true],
    ["starter", "user_file", "softwareTeam", false],
    ["research", "builtin", "softwareTeam", false],
    ["starter", "builtin", "agent", false],
  ])("preview %s/%s/%s keeps the review and scopes first-team guidance", async (name, sourceType, kind, guided) => {
    const entry = { ...LIBRARY_ENTRIES[0], name, sourceType, kind };
    const review = { ...SOFTWARE_TEAM_REVIEW, name, kind };
    const previewServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url?.endsWith("/review") ? review : [entry]));
    });
    await new Promise<void>(resolve => { previewServer.listen(0, resolve); });
    try {
      for (const json of [false, true]) {
        const program = new Command().addCommand(specsCommand(runningDeps((previewServer.address() as { port: number }).port)));
        const { logs, exitCode } = await captureLogs(() => program.parseAsync([
          "node", "softwareTeam", "specs", "preview", entry.id, "--kind", String(kind), ...(json ? ["--json"] : []),
        ]).then(() => {}));
        expect(exitCode).toBeUndefined();
        const output = logs.join("\n");
        if (guided) {
          expect(output).toContain("starter (builder + reviewer");
          expect(output).toContain("workshop (lead + builder + QA + reviewer");
          expect(output).toContain("factory (seven agents");
          expect(output).toContain("Unless you already picked a team");
          expect(output).toContain("sketch all three");
          expect(output).toContain("recommend one for your goal");
        } else {
          expect(output).not.toContain("First-team choices");
        }
        if (json) {
          const { guidance, ...original } = JSON.parse(output);
          expect(original).toEqual(review);
          expect(guidance?.length ?? 0).toBe(guided ? 1 : 0);
        }
      }
    } finally {
      await new Promise<void>(resolve => { previewServer.close(() => resolve()); });
    }
  });

  it("specs sync reports updated count", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "softwareTeam", "specs", "sync"]);
    });
    expect(logs.join("\n")).toContain("2");
  });

  it("specs add validates, copies, and reports entry ID", async () => {
    const { mkdtempSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    // Use temp SoftwareTeam home to avoid polluting real ~/.softwareteam/specs/
    const tmpDir = mkdtempSync(join(tmpdir(), "specs-add-"));
    const specPath = join(tmpDir, "test-spec.yaml");
    writeFileSync(specPath, 'name: test-spec\nversion: "0.2"\npods: []\nedges: []\n');
    const savedHome = process.env["HOME"];
    const savedSoftwareTeamHome = process.env["SOFTWARETEAM_HOME"];
    process.env["HOME"] = tmpDir;
    process.env["SOFTWARETEAM_HOME"] = join(tmpDir, ".softwareteam");

    const addServer = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (url.startsWith("/api/specs/review/softwareTeam") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ kind: "softwareTeam", name: "test-spec" }));
        } else if (url === "/api/specs/library/sync" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([{ id: "new-id", kind: "softwareTeam", name: "test-spec", sourcePath: join(tmpDir, ".softwareteam", "specs", "test-spec.yaml") }]));
        } else if (url === "/api/specs/library") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([]));
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => { addServer.listen(0, resolve); });
    const addPort = (addServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(specsCommand(runningDeps(addPort)));

    const { logs } = await captureLogs(async () => {
      await prog.parseAsync(["node", "softwareTeam", "specs", "add", specPath]);
    });

    addServer.close();

    // Verify it copied to temp HOME, not real HOME
    expect(existsSync(join(tmpDir, ".softwareteam", "specs", "test-spec.yaml"))).toBe(true);

    process.env["HOME"] = savedHome;
    if (savedSoftwareTeamHome !== undefined) process.env["SOFTWARETEAM_HOME"] = savedSoftwareTeamHome;
    else delete process.env["SOFTWARETEAM_HOME"];
    rmSync(tmpDir, { recursive: true, force: true });

    const output = logs.join("\n");
    expect(output).toContain("Added");
    expect(output).toContain("test-spec");
    expect(output).toContain("ID:");
  });

  it("specs add installs a full SoftwareTeam directory with adjacent resources", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpDir = mkdtempSync(join(tmpdir(), "specs-add-dir-"));
    const specDir = join(tmpDir, "building-softwareteam");
    mkdirSync(join(specDir, "guidance"), { recursive: true });
    mkdirSync(join(specDir, "agents", "lead", "guidance"), { recursive: true });
    writeFileSync(join(specDir, "guidance", "builder.md"), "# Builder Context\n");
    writeFileSync(join(specDir, "agents", "lead", "guidance", "role.md"), "# Lead Role\n");
    writeFileSync(join(specDir, "agents", "lead", "agent.yaml"), [
      'name: lead',
      'version: "1.0"',
      'profiles:',
      '  default:',
      '    uses:',
      '      skills: []',
      '      guidance: []',
      '      subagents: []',
      '      hooks: []',
      '      runtime_resources: []',
      '',
    ].join("\n"));
    writeFileSync(join(specDir, "software-team.yaml"), [
      'version: "0.2"',
      'name: building-softwareteam',
      'startup:',
      '  files:',
      '    - path: guidance/builder.md',
      '      delivery_hint: guidance_merge',
      '      required: true',
      'pods:',
      '  - id: orch',
      '    label: Orchestration',
      '    members:',
      '      - id: lead',
      '        agent_ref: "local:agents/lead"',
      '        profile: default',
      '        runtime: codex',
      '        cwd: "."',
      '    edges: []',
      'edges: []',
      '',
    ].join("\n"));

    const savedHome = process.env["HOME"];
    const savedSoftwareTeamHome = process.env["SOFTWARETEAM_HOME"];
    process.env["HOME"] = tmpDir;
    process.env["SOFTWARETEAM_HOME"] = join(tmpDir, ".softwareteam");

    const addServer = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      req.resume();
      req.on("end", () => {
        if (url.startsWith("/api/specs/review/softwareTeam") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ kind: "softwareTeam", name: "building-softwareteam" }));
        } else if (url === "/api/specs/library/sync" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([{
            id: "dir-id",
            kind: "softwareTeam",
            name: "building-softwareteam",
            sourcePath: join(tmpDir, ".softwareteam", "specs", "building-softwareteam", "software-team.yaml"),
          }]));
        } else if (url === "/api/specs/library") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([]));
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => { addServer.listen(0, resolve); });
    const addPort = (addServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(specsCommand(runningDeps(addPort)));

    try {
      const { logs } = await captureLogs(async () => {
        await prog.parseAsync(["node", "softwareTeam", "specs", "add", specDir]);
      });

      expect(existsSync(join(tmpDir, ".softwareteam", "specs", "building-softwareteam", "software-team.yaml"))).toBe(true);
      expect(existsSync(join(tmpDir, ".softwareteam", "specs", "building-softwareteam", "guidance", "builder.md"))).toBe(true);
      expect(existsSync(join(tmpDir, ".softwareteam", "specs", "building-softwareteam", "agents", "lead", "agent.yaml"))).toBe(true);
      expect(logs.join("\n")).toContain("building-softwareteam");
      expect(logs.join("\n")).toContain("ID:");
    } finally {
      addServer.close();
      process.env["HOME"] = savedHome;
      if (savedSoftwareTeamHome !== undefined) process.env["SOFTWARETEAM_HOME"] = savedSoftwareTeamHome;
      else delete process.env["SOFTWARETEAM_HOME"];
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("specs remove resolves by name and reports deletion", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "softwareTeam", "specs", "remove", "review-software-team"]);
    });

    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("Removed");
    expect(logs.join("\n")).toContain("review-software-team");
  });

  it("specs rename resolves by name and reports the new entry", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "softwareTeam", "specs", "rename", "review-software-team", "renamed-software-team"]);
    });

    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("Renamed");
    expect(logs.join("\n")).toContain("renamed-software-team");
  });
});
