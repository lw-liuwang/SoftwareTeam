import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import stringWidth from "string-width";
import { psCommand } from "../src/commands/ps.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

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
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

describe("Ps CLI", () => {
  let server: http.Server;
  let port: number;
  let psData: unknown[];
  let nodesData: Record<string, unknown[]>;
  let savedSessionName: string | undefined;

  beforeAll(async () => {
    savedSessionName = process.env.SOFTWARETEAM_SESSION_NAME;
    delete process.env.SOFTWARETEAM_SESSION_NAME;
    psData = [];
    nodesData = {};
    server = http.createServer(async (req, res) => {
      // OPR.0.4.4.21: the softwareTeam tier always requests ?includeArchived=true
      // (client-side visibility split) — match by prefix, not exact URL.
      if (req.url?.startsWith("/api/ps") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(psData));
      } else if (req.url?.match(/^\/api\/software-teams\/([^/]+)\/nodes(?:\?.*)?$/) && req.method === "GET") {
        const softwareTeamId = decodeURIComponent(req.url.match(/^\/api\/software-teams\/([^/]+)\/nodes(?:\?.*)?$/)![1]!);
        if (softwareTeamId in nodesData) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(nodesData[softwareTeamId]));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `SoftwareTeam "${softwareTeamId}" not found` }));
        }
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    if (savedSessionName !== undefined) process.env.SOFTWARETEAM_SESSION_NAME = savedSessionName;
  });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(runningDeps(port)));
    return prog;
  }

  // T9: ps table output with softwareTeams
  it("ps prints formatted table", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "review-software-team", nodeCount: 3, runningCount: 3, status: "running", uptime: "2h 15m", latestSnapshot: "5m ago" },
      { softwareTeamId: "software-team-2", name: "dev-software-team", nodeCount: 2, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: "1d ago" },
    ];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("SOFTWARE_TEAM");
    expect(output).toContain("NODES");
    expect(output).toContain("RUNNING");
    expect(output).toContain("STATUS");
    expect(output).toContain("review-software-team");
    // OPR.0.4.4.21 FR-1: on the bare default, stopped softwareTeams are HISTORY —
    // one count line, not rows (field of view stays O(active softwareTeams)).
    expect(output).not.toContain("dev-software-team");
    expect(output).toContain("not shown: 1 stopped (SoftwareTeam ps --filter status=stopped)");
    // FR-1 display elements: host rollup line + affordance footer.
    expect(output).toContain("1 softwareTeam · 3 seats · 0 need attention");
    expect(output).toContain("drill: SoftwareTeam ps --software-team <name>");
    expect(output).toContain("running");
    expect(exitCode).toBeUndefined(); // 0
  });

  it.each(["--full", "--verbose"])("ps %s preserves complete cells and aligns columns", async (flag) => {
    const longName = "demo-production-integration-software-team";
    const longUptime = "12345d 23h 59m";
    psData = [
      { softwareTeamId: "software-team-1", name: longName, nodeCount: 5, runningCount: 5, status: "running", uptime: longUptime, latestSnapshot: "1m ago" },
      { softwareTeamId: "software-team-2", name: "short", nodeCount: 2, runningCount: 2, status: "running", uptime: "1m", latestSnapshot: "2m ago" },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", flag]);
    });
    const header = logs.find((line) => line.startsWith("SOFTWARE_TEAM"))!;
    const longRow = logs.find((line) => line.startsWith("demo-"))!;
    const shortRow = logs.find((line) => line.startsWith("short"))!;
    expect(longRow).toContain(longName);
    expect(longRow).toContain(longUptime);
    expect(longRow).not.toContain("…");
    expect(longRow).toMatch(new RegExp(`${longName} {2,}5`));
    expect(longRow.indexOf("5", longName.length)).toBe(header.indexOf("NODES"));
    expect(shortRow.indexOf("2")).toBe(header.indexOf("NODES"));
    expect(longRow.indexOf("1m ago")).toBe(header.indexOf("SNAPSHOT"));
    expect(shortRow.indexOf("2m ago")).toBe(header.indexOf("SNAPSHOT"));
  });

  it.each(["--full", "--verbose", ""])("ps %s aligns CJK SoftwareTeam names by terminal width", async (flag) => {
    const name = "演示-生产-集成-长名称-software-team";
    psData = [
      { softwareTeamId: "software-team-1", name, nodeCount: 5, runningCount: 5, status: "running" },
      { softwareTeamId: "software-team-2", name: "short", nodeCount: 2, runningCount: 2, status: "running" },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", ...(flag ? [flag] : [])]);
    });
    const header = logs.find((line) => line.startsWith("SOFTWARE_TEAM"))!;
    const cjkRow = logs.find((line) => line.startsWith("演示"))!;
    const shortRow = logs.find((line) => line.startsWith("short"))!;
    const nodeColumn = stringWidth(header.slice(0, header.indexOf("NODES")));
    expect(stringWidth(cjkRow.slice(0, cjkRow.indexOf("5")))).toBe(nodeColumn);
    expect(stringWidth(shortRow.slice(0, shortRow.indexOf("2")))).toBe(nodeColumn);
    if (flag) expect(cjkRow).toContain(name);
    else expect(cjkRow).toContain("…");
  });

  it("ps compact rows separate truncated names from counts", async () => {
    psData = [{ softwareTeamId: "software-team-1", name: "demo-production-integration-software-team", nodeCount: 5, runningCount: 5, status: "running" }];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps"]);
    });
    const header = logs.find((line) => line.startsWith("SOFTWARE_TEAM"))!;
    const row = logs.find((line) => line.startsWith("demo-"))!;
    expect(row).toMatch(/… {2,}5/);
    expect(row.indexOf("5")).toBe(header.indexOf("NODES"));
  });

  it("ps compact table stays within its original width", async () => {
    psData = [{
      softwareTeamId: "software-team-1", name: "short", nodeCount: 1, runningCount: 1,
      activeCount: 0, hasWorkCount: 0, attentionCount: 0,
      status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: "1m ago",
    }];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps"]);
    });
    const header = logs.find((line) => line.startsWith("SOFTWARE_TEAM"))!;
    const row = logs.find((line) => line.startsWith("short"))!;
    expect(stringWidth(header)).toBeLessThanOrEqual(100);
    expect(stringWidth(row)).toBeLessThanOrEqual(98);
  });

  it.each([false, true])("ps separates the footer when hidden history is %s", async (hiddenHistory) => {
    psData = [{ softwareTeamId: "software-team-1", name: "live", nodeCount: 1, runningCount: 1, status: "running" }];
    if (hiddenHistory) {
      psData.push({ softwareTeamId: "software-team-2", name: "stopped", nodeCount: 1, runningCount: 0, status: "stopped" });
    }
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--full"]);
    });
    const rowIndex = logs.findIndex((line) => line.startsWith("live"));
    expect(logs[rowIndex + 1]).toBe("");
    expect(logs[rowIndex + 2]).toMatch(hiddenHistory ? /^not shown:/ : /^drill:/);
    expect(logs.filter((line) => line === "")).toHaveLength(1);
  });

  it("ps --full preserves the archived marker and separates its legend", async () => {
    const name = "demo-production-integration-archived";
    psData = [{ softwareTeamId: "software-team-1", name, nodeCount: 1, runningCount: 0, status: "stopped", isArchived: true }];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--full", "--include-archived"]);
    });
    const rowIndex = logs.findIndex((line) => line.startsWith(name));
    expect(rowIndex).toBeGreaterThan(0);
    expect(logs[rowIndex]).toContain(`${name} *  `);
    expect(logs[rowIndex + 1]).toBe("");
    expect(logs[rowIndex + 2]).toMatch(/^\* = archived/);
  });

  it("ps filtered output without a footer has no extra blank line", async () => {
    psData = [{ softwareTeamId: "software-team-1", name: "live", nodeCount: 1, runningCount: 1, status: "running" }];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--filter", "status=running"]);
    });
    expect(logs).toHaveLength(3);
    expect(logs.at(-1)).toMatch(/^live/);
  });

  // OPR.0.4.4.21 FR-1 (arch pin, STATED contract): the JSON-vs-table scope
  // split — default --json keeps ALL non-archived entries INCLUDING stopped
  // softwareTeams (a stopped softwareTeam vanishing from default JSON would silently break
  // status-monitoring scripts); only the HUMAN table folds them.
  it("OPR.0.4.4.21: default --json keeps stopped softwareTeams while the table folds them", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "live-software-team", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null },
      { softwareTeamId: "software-team-2", name: "halted-software-team", nodeCount: 2, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: null },
    ];
    const { logs: jsonLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json"]);
    });
    const parsed = JSON.parse(jsonLogs.join(""));
    expect(parsed.map((e: { name: string }) => e.name).sort()).toEqual(["halted-software-team", "live-software-team"]);

    const { logs: humanLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps"]);
    });
    const output = humanLogs.join("\n");
    expect(output).toContain("live-software-team");
    expect(output).not.toContain("halted-software-team");
    expect(output).toContain("not shown: 1 stopped (SoftwareTeam ps --filter status=stopped)");
  });

  // OPR.0.4.4.21 fixback (qa1 F4): attentionCount is selectable via --fields
  // (it is emitted by default JSON, so the allow-list must carry it).
  it("OPR.0.4.4.21: --fields attentionCount projects the additive field", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "attn-software-team", softwareTeamName: "attn-software-team", nodeCount: 2, runningCount: 2, status: "running", uptime: "1m", latestSnapshot: null, attentionCount: 1 },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--fields", "softwareTeamName,attentionCount"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.entries[0]).toEqual({ softwareTeamName: "attn-software-team", attentionCount: 1 });
  });

  // T10: ps --json outputs PsEntry[]
  it("ps --json outputs parseable JSON array", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "test", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].softwareTeamId).toBe("software-team-1");
  });

  // T11: ps empty -> 'No softwareTeams'
  it("ps with no softwareTeams prints No softwareTeams", async () => {
    psData = [];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps"]);
    });
    expect(logs.some((l) => l.includes("No softwareTeams"))).toBe(true);
  });

  it("ps recovers when daemon.json is missing but configured daemon is healthy", async () => {
    const savedPort = process.env["SOFTWARETEAM_PORT"];
    const savedHost = process.env["SOFTWARETEAM_HOST"];
    process.env["SOFTWARETEAM_PORT"] = String(port);
    process.env["SOFTWARETEAM_HOST"] = "127.0.0.1";
    try {
      psData = [
        { softwareTeamId: "software-team-1", name: "recovered-team", nodeCount: 1, runningCount: 1, status: "running", uptime: "15s", latestSnapshot: null },
      ];
      const prog = new Command();
      prog.exitOverride();
      prog.addCommand(psCommand({
        lifecycleDeps: mockLifecycleDeps({
          exists: vi.fn(() => false),
          fetch: vi.fn(async (url: string) => {
            expect(url).toBe(`http://127.0.0.1:${port}/healthz`);
            return { ok: true };
          }),
        }),
        clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      }));

      const { logs, exitCode } = await captureLogs(async () => {
        await prog.parseAsync(["node", "SoftwareTeam", "ps"]);
      });
      const output = logs.join("\n");
      expect(output).toContain("recovered-team");
      expect(output).not.toMatch(/Daemon not running/i);
      expect(exitCode).toBeUndefined();
    } finally {
      if (savedPort === undefined) delete process.env["SOFTWARETEAM_PORT"];
      else process.env["SOFTWARETEAM_PORT"] = savedPort;
      if (savedHost === undefined) delete process.env["SOFTWARETEAM_HOST"];
      else process.env["SOFTWARETEAM_HOST"] = savedHost;
    }
  });

  it.each([false, true])("ps cleanup opt-out=%s preserves ordinary housekeeping by default", async (noCleanup) => {
    const state = { pid: 555, port, db: "test.sqlite", startedAt: "2026-01-01T00:00:00Z" };
    const receipt = { schema: "softwareteam.daemon-shutdown/v1", pid: 555,
      startedAt: "2026-01-01T00:01:00Z", completedAt: "2026-01-01T00:02:00Z",
      phase: "complete", outcome: "clean", failures: [] };
    const deps = mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE || p.endsWith("daemon-shutdown.json")),
      readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify(state)
        : p.endsWith("daemon-shutdown.json") ? JSON.stringify(receipt) : null),
      isProcessAlive: vi.fn(() => false),
    });
    const prog = new Command().exitOverride().addCommand(psCommand({ lifecycleDeps: deps,
      clientFactory: (url) => new DaemonClient(url) }));
    await captureLogs(() => prog.parseAsync(["node", "SoftwareTeam", "ps", ...(noCleanup ? ["--no-cleanup"] : [])]).then(() => {}));
    if (noCleanup) expect(deps.removeFile).not.toHaveBeenCalled();
    else expect(deps.removeFile).toHaveBeenCalledWith(STATE_FILE);
  });

  // NS-T08: ps --nodes tests

  it("ps --nodes --full formats table with SoftwareTeam context and restore columns", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "test-software-team", nodeCount: 2, runningCount: 2, status: "running", uptime: "1h", latestSnapshot: null },
    ];
    nodesData["software-team-1"] = [
      {
        softwareTeamId: "software-team-1", softwareTeamName: "test-software-team", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test-software-team", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: "tmux attach -t dev-impl@test-software-team", resumeCommand: null, latestError: null,
      },
      {
        softwareTeamId: "software-team-1", softwareTeamName: "test-software-team", logicalId: "infra.server", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "infra-server@test-software-team", nodeKind: "infrastructure", runtime: "terminal",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: "tmux attach -t infra-server@test-software-team", resumeCommand: null, latestError: null,
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A", "--full"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("SOFTWARE_TEAM");
    expect(output).toContain("POD");
    expect(output).toContain("MEMBER");
    expect(output).toContain("SESSION");
    expect(output).toContain("RUNTIME");
    expect(output).toContain("RESTORE");
    expect(output).toContain("test-software-team#software-team-1");
    expect(output).toContain("dev-impl@test-software-team");
    expect(output).toContain("terminal");
  });

  it("ps --nodes --full includes SoftwareTeam identifiers so duplicate SoftwareTeam names stay distinguishable", async () => {
    psData = [
      { softwareTeamId: "software-team-old", name: "demo-software-team", nodeCount: 1, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: "1m ago" },
      { softwareTeamId: "software-team-new", name: "demo-software-team", nodeCount: 1, runningCount: 1, status: "running", uptime: "10s", latestSnapshot: null },
    ];
    nodesData["software-team-old"] = [
      {
        softwareTeamId: "software-team-old", softwareTeamName: "demo-software-team", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@demo-software-team", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "exited", startupStatus: "failed", restoreOutcome: "failed",
        tmuxAttachCommand: null, resumeCommand: null, latestError: "old restore failed",
      },
    ];
    nodesData["software-team-new"] = [
      {
        softwareTeamId: "software-team-new", softwareTeamName: "demo-software-team", logicalId: "dev.impl", podId: "pod-2", podNamespace: "dev",
        canonicalSessionName: "dev-impl@demo-software-team", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A", "--full"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("demo-software-team#software-team-old");
    expect(output).toContain("demo-software-team#software-team-new");
  });

  it("ps --nodes --json --full produces valid JSON array with restoreOutcome", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "test-software-team", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null },
    ];
    nodesData["software-team-1"] = [
      {
        softwareTeamId: "software-team-1", softwareTeamName: "test-software-team", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test-software-team", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "resumed",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
        agentActivity: {
          state: "idle",
          reason: "idle_status_bar",
          evidenceSource: "pane_heuristic",
          sampledAt: "2026-04-24T12:00:00.000Z",
          evidence: "gpt-5.5 xhigh fast · Context [████ ]",
        },
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A", "--json", "--full"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].restoreOutcome).toBe("resumed");
    expect(parsed[0].nodeKind).toBe("agent");
    expect(parsed[0].podNamespace).toBe("dev");
    expect(parsed[0].agentActivity).toMatchObject({
      state: "idle",
      reason: "idle_status_bar",
      evidenceSource: "pane_heuristic",
    });
  });

  it("ps --nodes human output shows activity as a separate runtime truth field", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "test-software-team", nodeCount: 2, runningCount: 2, status: "running", uptime: "1m", latestSnapshot: null },
    ];
    nodesData["software-team-1"] = [
      {
        softwareTeamId: "software-team-1", softwareTeamName: "test-software-team", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test-software-team", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
        agentActivity: { state: "running", reason: "mid_work_pattern", evidenceSource: "pane_heuristic", sampledAt: "2026-04-24T12:00:00.000Z", evidence: "Working" },
      },
      {
        softwareTeamId: "software-team-1", softwareTeamName: "test-software-team", logicalId: "dev.qa", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-qa@test-software-team", nodeKind: "agent", runtime: "codex",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
        agentActivity: { state: "unknown", reason: "capture_failed", evidenceSource: "pane_heuristic", sampledAt: "2026-04-24T12:00:00.000Z", evidence: null },
      },
    ];

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A"]);
    });

    const output = logs.join("\n");
    expect(output).toContain("ACTIVITY");
    expect(output).toContain("running");
    expect(output).toContain("unknown");
    expect(output).toContain("dev-impl@test-software-team");
  });

  it("ps --nodes includes infrastructure nodes (compact shows session)", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "test-software-team", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null },
    ];
    nodesData["software-team-1"] = [
      {
        softwareTeamId: "software-team-1", softwareTeamName: "test-software-team", logicalId: "infra.daemon", podId: "pod-1", podNamespace: "infra",
        canonicalSessionName: "infra-daemon@test-software-team", nodeKind: "infrastructure", runtime: "terminal",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("infra-daemon@test-software-team");
    expect(output).toContain("test-software-team");
  });

  it("ps --nodes truncates long SoftwareTeam and session names so the table stays aligned", async () => {
    psData = [
      {
        softwareTeamId: "software-team-very-long-id-1234567890",
        name: "softwareteam-buildout-with-an-extremely-long-name",
        nodeCount: 1,
        runningCount: 1,
        status: "running",
        uptime: "1m",
        latestSnapshot: null,
      },
    ];
    nodesData["software-team-very-long-id-1234567890"] = [
      {
        softwareTeamId: "software-team-very-long-id-1234567890",
        softwareTeamName: "softwareteam-buildout-with-an-extremely-long-name",
        logicalId: "research1.analyst",
        podId: "pod-research",
        podNamespace: "research1",
        canonicalSessionName: "research1-analyst-with-an-extremely-long-session-name@softwareteam-buildout-with-an-extremely-long-name",
        nodeKind: "agent",
        runtime: "claude-code",
        sessionStatus: "running",
        startupStatus: "ready",
        restoreOutcome: "n-a",
        tmuxAttachCommand: null,
        resumeCommand: null,
        latestError: null,
      },
    ];

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A"]);
    });
    const lines = logs.join("\n").split("\n");
    expect(lines[1]).toContain("…");
    expect(lines[1]!.length).toBeLessThan(180);
  });

  it("ps (no flag) still works backward compatible", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "compat-software-team", nodeCount: 1, runningCount: 1, status: "running", uptime: "5m", latestSnapshot: null },
    ];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("compat-software-team");
    expect(output).toContain("SOFTWARE_TEAM");
    expect(exitCode).toBeUndefined();
  });

  it("ps help text includes examples and exit codes", () => {
    const psCmd = psCommand(runningDeps(port));
    let helpOutput = "";
    psCmd.configureOutput({ writeOut: (s) => { helpOutput += s; } });
    psCmd.outputHelp();
    expect(helpOutput).toContain("SoftwareTeam ps --nodes");
    expect(helpOutput).toContain("Exit codes");
  });

  it("ps --nodes warns on per-software-team fetch failure", async () => {
    psData = [
      { softwareTeamId: "nonexistent", name: "bad-software-team", nodeCount: 1, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: null },
    ];
    nodesData = {}; // no nodes data → server returns 404
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Warning");
    expect(output).toContain("bad-software-team");
  });

  it("daemon not running error includes guidance", async () => {
    const stoppedDeps: StatusDeps = {
      lifecycleDeps: mockLifecycleDeps({
        fetch: vi.fn(async () => { throw new Error("refused"); }),
      }),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    };
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(stoppedDeps));
    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "SoftwareTeam", "ps"]);
    });
    expect(logs.some((l) => l.includes("SoftwareTeam daemon start"))).toBe(true);
    expect(exitCode).toBe(1);
  });

  // L2 lifecycle column / JSON shape (softwareTeam + node level)
  it("ps prints LIFECYCLE column with abbreviated software-team-level state", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "running-software-team", nodeCount: 2, runningCount: 2, status: "running", lifecycleState: "running", uptime: "2h", latestSnapshot: null },
      { softwareTeamId: "software-team-2", name: "recover-software-team", nodeCount: 2, runningCount: 0, status: "stopped", lifecycleState: "recoverable", uptime: null, latestSnapshot: "1h ago" },
      { softwareTeamId: "software-team-3", name: "stop-software-team", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null },
      { softwareTeamId: "software-team-4", name: "deg-software-team", nodeCount: 2, runningCount: 1, status: "partial", lifecycleState: "degraded", uptime: "30m", latestSnapshot: null },
      { softwareTeamId: "software-team-5", name: "att-software-team", nodeCount: 2, runningCount: 2, status: "running", lifecycleState: "attention_required", uptime: "10m", latestSnapshot: null },
    ];
    const { logs } = await captureLogs(async () => {
      // OPR.0.4.4.21 — --include-archived is the full-breadth view (no
      // stopped fold), so every lifecycle abbreviation stays visible here.
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--include-archived"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("LIFECYCLE");
    expect(output).toContain("run");
    expect(output).toContain("rec");
    expect(output).toContain("stp");
    expect(output).toContain("deg");
    expect(output).toContain("att");
  });

  it("ps --json includes lifecycleState in SoftwareTeam entries", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "test", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "recoverable", uptime: null, latestSnapshot: "5m ago" },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed[0].lifecycleState).toBe("recoverable");
  });

  it("ps --nodes prints LIFECYCLE column with per-node abbreviated state", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "mixed-software-team", nodeCount: 3, runningCount: 1, status: "partial", lifecycleState: "degraded", uptime: "15m", latestSnapshot: null },
    ];
    nodesData["software-team-1"] = [
      {
        softwareTeamId: "software-team-1", softwareTeamName: "mixed-software-team", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@mixed-software-team", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "running",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
      {
        softwareTeamId: "software-team-1", softwareTeamName: "mixed-software-team", logicalId: "dev.qa", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-qa@mixed-software-team", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "detached", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "recoverable",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
      {
        softwareTeamId: "software-team-1", softwareTeamName: "mixed-software-team", logicalId: "dev.lead", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-lead@mixed-software-team", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "detached", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "detached",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("LIFECYCLE");
    expect(output).toContain("run");
    expect(output).toContain("rec");
    expect(output).toContain("det");
  });

  it("ps --nodes --json includes lifecycleState per node", async () => {
    psData = [
      { softwareTeamId: "software-team-1", name: "test", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "recoverable", uptime: null, latestSnapshot: null },
    ];
    nodesData["software-team-1"] = [
      {
        softwareTeamId: "software-team-1", softwareTeamName: "test", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "detached", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "recoverable",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed[0].lifecycleState).toBe("recoverable");
  });

  // L3-followup: trustworthy and scale-safe SoftwareTeam ps.
  describe("L3-followup: trustworthy and scale-safe SoftwareTeam ps", () => {
    it("ps --json passes through softwareTeamName alias from server (jq '.[].softwareTeamName' regression)", async () => {
      psData = [
        { softwareTeamId: "software-team-1", name: "alpha", softwareTeamName: "alpha", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].name).toBe("alpha");
      expect(parsed[0].softwareTeamName).toBe("alpha");
    });

    it("ps --json without flags emits a bare array (back-compat)", async () => {
      psData = [
        { softwareTeamId: "software-team-1", name: "alpha", softwareTeamName: "alpha", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
        { softwareTeamId: "software-team-2", name: "beta", softwareTeamName: "beta", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    });

    it("ps --json --limit emits envelope shape with truncated/totalSoftwareTeams/hint", async () => {
      psData = Array.from({ length: 10 }, (_, i) => ({
        softwareTeamId: `software-team-${i}`, name: `r${i}`, softwareTeamName: `r${i}`,
        nodeCount: 1, runningCount: 1, status: "running" as const, lifecycleState: "running" as const,
        uptime: "1m", latestSnapshot: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--limit", "3"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed.entries).toHaveLength(3);
      expect(parsed.totalSoftwareTeams).toBe(10);
      expect(parsed.truncated).toBe(true);
      expect(parsed.hint).toContain("--full");
    });

    it("ps --json --fields projects only named fields", async () => {
      psData = [
        { softwareTeamId: "software-team-1", name: "alpha", softwareTeamName: "alpha", nodeCount: 2, runningCount: 1, status: "partial", lifecycleState: "degraded", uptime: "1m", latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--fields", "softwareTeamName,status,lifecycleState"]);
      });
      const parsed = JSON.parse(logs.join(""));
      // Envelope (because --fields specified)
      expect(parsed.entries[0]).toEqual({ softwareTeamName: "alpha", status: "partial", lifecycleState: "degraded" });
      expect(parsed.entries[0].nodeCount).toBeUndefined();
    });

    it("ps --json --summary emits aggregate-only shape", async () => {
      psData = [
        { softwareTeamId: "software-team-1", name: "a", softwareTeamName: "a", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
        { softwareTeamId: "software-team-2", name: "b", softwareTeamName: "b", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null },
        { softwareTeamId: "software-team-3", name: "c", softwareTeamName: "c", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "attention_required", uptime: null, latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--summary"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(parsed.totalSoftwareTeams).toBe(3);
      expect(parsed.totalRunning).toBe(1);
      expect(parsed.byLifecycle.running).toBe(1);
      expect(parsed.byLifecycle.stopped).toBe(1);
      expect(parsed.byLifecycle.attention_required).toBe(1);
      expect(parsed.entries).toBeUndefined();
    });

    it("ps --filter status=running narrows entries", async () => {
      psData = [
        { softwareTeamId: "software-team-1", name: "a", softwareTeamName: "a", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
        { softwareTeamId: "software-team-2", name: "b", softwareTeamName: "b", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--filter", "status=running"]);
      });
      const parsed = JSON.parse(logs.join(""));
      // Envelope because --filter specified
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].name).toBe("a");
    });

    it("ps --filter lifecycleState=attention_required narrows entries", async () => {
      psData = [
        { softwareTeamId: "software-team-1", name: "a", softwareTeamName: "a", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
        { softwareTeamId: "software-team-2", name: "b", softwareTeamName: "b", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "attention_required", uptime: "1m", latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--filter", "lifecycleState=attention_required"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].lifecycleState).toBe("attention_required");
    });

    it("ps --filter rejects unknown keys with actionable error and exits 1", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--filter", "unknown=foo"]);
      });
      expect(logs.some((l) => l.includes("Unknown --filter key 'unknown'"))).toBe(true);
      expect(logs.some((l) => l.includes("Supported:"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --filter rejects malformed value (no '=') and exits 1", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--filter", "noequals"]);
      });
      // PL-012: error message now names the comparator family since
      // numeric ops (>=, >, <=, <, =) are accepted.
      expect(logs.some((l) => l.includes("--filter must be key") && l.includes("op = "))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --limit rejects non-numeric values and exits 1", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--limit", "abc"]);
      });
      expect(logs.some((l) => l.includes("--limit must be a non-negative integer"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    // C9a: --fields UX rejection alignment with --filter pattern.

    it("ps --json --fields rejects unknown field with sorted supported list (software-team-level)", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--fields", "softwareTeamId,bogus"]);
      });
      const stderr = logs.join("\n");
      expect(stderr).toContain("Unknown --fields key 'bogus'");
      expect(stderr).toContain("Supported:");
      // Sorted software-team-level allow-list keys appear in the message.
      expect(stderr).toContain("latestSnapshot");
      expect(stderr).toContain("softwareTeamName");
      expect(stderr).toContain("nodeCount");
      expect(exitCode).toBe(1);
    });

    it("ps --json --fields rejects multiple unknown fields with 'keys' plural", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--fields", "foo,bar"]);
      });
      const stderr = logs.join("\n");
      expect(stderr).toContain("Unknown --fields keys 'foo', 'bar'");
      expect(exitCode).toBe(1);
    });

    it("ps --json --fields rejects empty string and exits 1", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--fields", ""]);
      });
      expect(logs.some((l) => l.includes("--fields cannot be empty"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --json --fields rejects whitespace-only-after-trim and exits 1", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--fields", ",,"]);
      });
      expect(logs.some((l) => l.includes("--fields cannot be empty"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --json --fields rejects node-only field at software-team-level (logicalId)", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--fields", "softwareTeamId,logicalId"]);
      });
      expect(logs.some((l) => l.includes("Unknown --fields key 'logicalId'"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --json --fields accepts both name AND softwareTeamName at software-team-level (aliasing preserved per 0a9fb43)", async () => {
      psData = [
        { softwareTeamId: "software-team-1", name: "alpha", softwareTeamName: "alpha", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
      ];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--fields", "name,softwareTeamName"]);
      });
      expect(exitCode).not.toBe(1);
      const parsed = JSON.parse(logs.join(""));
      expect(parsed.entries[0]).toEqual({ name: "alpha", softwareTeamName: "alpha" });
    });

    it("ps --nodes --json --fields rejects 'name' with softwareTeamName hint (load-bearing aliasing decision)", async () => {
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A", "--json", "--fields", "name,logicalId"]);
      });
      const stderr = logs.join("\n");
      expect(stderr).toContain("Unknown --fields key 'name'");
      expect(stderr).toContain("Hint: 'name' is a software-team-level field; use 'softwareTeamName' for node entries.");
      expect(exitCode).toBe(1);
    });

    it("ps --nodes --json --fields rejects bogus key with sorted node-level supported list", async () => {
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A", "--json", "--fields", "softwareTeamName,bogus"]);
      });
      const stderr = logs.join("\n");
      expect(stderr).toContain("Unknown --fields key 'bogus'");
      expect(stderr).toContain("Supported:");
      // Sorted node-level allow-list — node-level-only key must be present.
      expect(stderr).toContain("agentActivity");
      expect(stderr).toContain("logicalId");
      // SoftwareTeam-level-only key must NOT be in the node-level supported list.
      expect(stderr).not.toMatch(/Supported:[^.]*\bname\b/);
      expect(exitCode).toBe(1);
    });

    it("ps --filter rejection still works after --fields rejection wired in (regression)", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--filter", "unknown=v"]);
      });
      expect(logs.some((l) => l.includes("Unknown --filter key 'unknown'"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --filter status=running --fields softwareTeamName combined still works (regression)", async () => {
      psData = [
        { softwareTeamId: "software-team-1", name: "a", softwareTeamName: "a", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
        { softwareTeamId: "software-team-2", name: "b", softwareTeamName: "b", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null },
      ];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json", "--filter", "status=running", "--fields", "softwareTeamName,status"]);
      });
      expect(exitCode).not.toBe(1);
      const parsed = JSON.parse(logs.join(""));
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0]).toEqual({ softwareTeamName: "a", status: "running" });
    });

    // Synthetic large-host fixture: 60 softwareTeams (just over default 50 budget) is
    // the smallest fixture that proves human-truncation behavior. Per Amendment
    // C: the L4 proof already exercised real 100x10 scale; this test asserts
    // the truncation path fires and the footer is honest. Using 60 instead of
    // 100 keeps the test fast while still proving the budget boundary.
    it("ps human output truncates above HUMAN_SOFTWARE_TEAM_BUDGET (50) with honest footer (Amendment C)", async () => {
      psData = Array.from({ length: 60 }, (_, i) => ({
        softwareTeamId: `software-team-${String(i).padStart(2, "0")}`,
        name: `r${String(i).padStart(2, "0")}`,
        softwareTeamName: `r${String(i).padStart(2, "0")}`,
        nodeCount: 1, runningCount: 1, status: "running" as const, lifecycleState: "running" as const,
        uptime: "1m", latestSnapshot: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps"]);
      });
      const output = logs.join("\n");

      // Header present
      expect(output).toContain("LIFECYCLE");
      // First 50 softwareTeam names visible
      expect(output).toContain("r00");
      expect(output).toContain("r49");
      // Beyond-budget softwareTeams not in default human output
      expect(output).not.toContain("r59");
      // Truncation footer with actual remaining count
      expect(output).toMatch(/and 10 more softwareTeams \(truncated at 50\)/);
      expect(output).toContain("SoftwareTeam ps --full");
    });

    it("ps --full disables human truncation; all 60 softwareTeams printed", async () => {
      psData = Array.from({ length: 60 }, (_, i) => ({
        softwareTeamId: `software-team-${i}`, name: `r${i}`, softwareTeamName: `r${i}`,
        nodeCount: 1, runningCount: 1, status: "running" as const, lifecycleState: "running" as const,
        uptime: "1m", latestSnapshot: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--full"]);
      });
      const output = logs.join("\n");
      expect(output).toContain("r0");
      expect(output).toContain("r59");
      expect(output).not.toMatch(/truncated/);
    });

    it("ps --json default unbounded for large softwareTeams: emits all 60 entries (back-compat)", async () => {
      psData = Array.from({ length: 60 }, (_, i) => ({
        softwareTeamId: `software-team-${i}`, name: `r${i}`, softwareTeamName: `r${i}`,
        nodeCount: 1, runningCount: 1, status: "running" as const, lifecycleState: "running" as const,
        uptime: "1m", latestSnapshot: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--json"]);
      });
      const parsed = JSON.parse(logs.join(""));
      // Default JSON stays a bare array of all 60; NO envelope.
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(60);
    });

    it("ps --nodes --json default unbounded: bare array (back-compat)", async () => {
      psData = [
        { softwareTeamId: "software-team-1", name: "test", softwareTeamName: "test", nodeCount: 2, runningCount: 1, status: "partial", lifecycleState: "degraded", uptime: "1m", latestSnapshot: null },
      ];
      nodesData["software-team-1"] = Array.from({ length: 5 }, (_, i) => ({
        softwareTeamId: "software-team-1", softwareTeamName: "test", logicalId: `dev.n${i}`, podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: `n${i}@test`, nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "running",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A", "--json"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(5);
    });

    it("ps --nodes --json --limit emits envelope shape with totalNodes/truncated/hint", async () => {
      psData = [
        { softwareTeamId: "software-team-1", name: "test", softwareTeamName: "test", nodeCount: 5, runningCount: 5, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
      ];
      nodesData["software-team-1"] = Array.from({ length: 5 }, (_, i) => ({
        softwareTeamId: "software-team-1", softwareTeamName: "test", logicalId: `dev.n${i}`, podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: `n${i}@test`, nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "running",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "SoftwareTeam", "ps", "--nodes", "-A", "--json", "--limit", "2"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(parsed.entries).toHaveLength(2);
      expect(parsed.totalNodes).toBe(5);
      expect(parsed.truncated).toBe(true);
      expect(parsed.hint).toContain("--nodes");
      expect(parsed.hint).toContain("--full");
    });
  });
});

describe("OPR.0.4.0.26 — SoftwareTeam ps help reflects the slimmed node-list contract", () => {
  it("no longer advertises the pre-0.4.0 complete node payload (recoveryGuidance/currentUsage relocated)", () => {
    // Capture the FULL rendered help (the addHelpText "after" block is only in
    // outputHelp, not helpInformation). Normalize whitespace so commander's
    // line-wrapping doesn't split tokens.
    let out = "";
    const cmd = psCommand();
    cmd.configureOutput({ writeOut: (s) => { out += s; } });
    cmd.outputHelp();
    const help = out.replace(/\s+/g, " ");
    // The now-false pre-0.4.0 promises are gone (after-text AND the --full option row).
    expect(help).not.toContain("same as pre-0.4.0 default");
    expect(help).not.toContain("recoveryGuidance, resume commands");
    expect(help).not.toContain("Show complete per-node payload");
    // The new node-list contract is documented in-CLI (AC-4).
    expect(help).toContain("recoveryGuidance: null");
    expect(help).toContain("contextUsage.currentUsage: null");
  });
});
