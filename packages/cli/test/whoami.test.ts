import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { whoamiCommand, resolveIdentitySource } from "../src/commands/whoami.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return { spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = []; const origLog = console.log; const origErr = console.error; const origExitCode = process.exitCode; process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" ")); console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; } const exitCode = process.exitCode; process.exitCode = origExitCode; resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return { lifecycleDeps: { ...mockLifecycleDeps(), exists: vi.fn((p: string) => p === STATE_FILE), readFile: vi.fn((p: string) => { if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-03T00:00:00Z" } as DaemonState); return null; }), fetch: vi.fn(async () => ({ ok: true })) }, clientFactory: (baseUrl) => new DaemonClient(baseUrl) };
}

function stoppedDeps(): StatusDeps {
  return {
    lifecycleDeps: {
      ...mockLifecycleDeps(),
      exists: vi.fn(() => false),
      fetch: vi.fn(async () => { throw new Error("refused"); }),
    },
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

const WHOAMI_RESPONSE = {
  resolvedBy: "node_id",
  identity: {
    softwareTeamId: "software-team-1", softwareTeamName: "my-software-team", nodeId: "node-1", logicalId: "dev.impl",
    attachmentType: "tmux",
    podId: "pod-dev-123", podNamespace: "dev", podLabel: "Development", memberId: "impl", memberLabel: "Implementer",
    sessionName: "dev-impl@my-software-team", runtime: "claude-code", cwd: "/tmp",
    agentRef: "local:agents/impl", profile: "default",
    resolvedSpecName: "impl", resolvedSpecVersion: "1.0",
  },
  peers: [{ logicalId: "dev.qa", sessionName: "dev-qa@my-software-team", runtime: "codex", podId: "pod-dev-123", podNamespace: "dev", memberId: "qa" }],
  peersNote: "peers = this softwareTeam's roster excluding self (no edge filter); edges = directional relationships; use `SoftwareTeam ps --nodes` for node inventory including self + live state",
  edges: {
    outgoing: [{ kind: "delegates_to", to: { logicalId: "dev.qa", sessionName: "dev-qa@my-software-team" } }],
    incoming: [],
  },
  transcript: { enabled: true, path: "/tmp/transcripts/my-software-team/dev-impl@my-software-team.log", tailCommand: "SoftwareTeam transcript dev-impl@my-software-team --tail 100", grepCommand: null },
  commands: { sendExamples: ["SoftwareTeam send dev-qa@my-software-team 'message' --verify"], captureExamples: ["SoftwareTeam capture dev-qa@my-software-team"] },
};

const UNBOUND_WHOAMI_RESPONSE = {
  ...WHOAMI_RESPONSE,
  identity: {
    ...WHOAMI_RESPONSE.identity,
    sessionName: null,
  },
  transcript: { enabled: false, path: null, tailCommand: null, grepCommand: null },
  commands: { sendExamples: [], captureExamples: [] },
};

describe("Whoami CLI", () => {
  let server: http.Server;
  let port: number;
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      if (url.includes("/api/whoami") && url.includes("nodeId=node-1")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(WHOAMI_RESPONSE));
      } else if (url.includes("/api/whoami") && url.includes("nodeId=node-2")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(UNBOUND_WHOAMI_RESPONSE));
      } else if (url.includes("/api/whoami") && url.includes("sessionName=dev-impl")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...WHOAMI_RESPONSE, resolvedBy: "session_name" }));
      } else if (url.includes("/api/whoami") && url.includes("sessionName=unknown")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found in any managed softwareTeam. Check: SoftwareTeam ps --nodes" }));
      } else if (url.includes("/api/whoami") && url.includes("sessionName=ambiguous")) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session 'ambiguous' is ambiguous — found in 2 softwareTeams." }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  beforeEach(() => {
    savedEnv = {
      SOFTWARETEAM_NODE_ID: process.env["SOFTWARETEAM_NODE_ID"],
      SOFTWARETEAM_SESSION_NAME: process.env["SOFTWARETEAM_SESSION_NAME"],
      TMUX_PANE: process.env["TMUX_PANE"],
    };
    delete process.env["SOFTWARETEAM_NODE_ID"];
    delete process.env["SOFTWARETEAM_SESSION_NAME"];
    delete process.env["TMUX_PANE"];
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(whoamiCommand(runningDeps(port)));
    return prog;
  }

  it("--node-id flag resolves and prints identity", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami", "--node-id", "node-1"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("my-software-team");
    expect(output).toContain("dev-impl@my-software-team");
  });

  it("--session flag resolves and prints identity", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami", "--session", "dev-impl@my-software-team"]);
    });
    expect(logs.join("\n")).toContain("my-software-team");
  });

  it("SOFTWARETEAM_NODE_ID env var resolves when no flags given", async () => {
    process.env["SOFTWARETEAM_NODE_ID"] = "node-1";
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami"]);
    });
    expect(logs.join("\n")).toContain("my-software-team");
  });

  it("SOFTWARETEAM_SESSION_NAME env var resolves when no node-id env", async () => {
    process.env["SOFTWARETEAM_SESSION_NAME"] = "dev-impl@my-software-team";
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami"]);
    });
    expect(logs.join("\n")).toContain("my-software-team");
  });

  it("TMUX_PANE resolves via tmux display-message to exact session name (no metadata set)", () => {
    // Test the resolution function directly with a controlled tmux mock
    process.env["TMUX_PANE"] = "%42";
    const mockTmuxExec = vi.fn((cmd: string) => {
      if (cmd.includes("show-option")) throw new Error("unknown option");
      return "dev-impl@my-software-team";
    });

    const result = resolveIdentitySource({}, mockTmuxExec);

    const displayCalls = mockTmuxExec.mock.calls.filter((c) => (c[0] as string).includes("display-message"));
    expect(displayCalls).toHaveLength(1);
    expect(displayCalls[0]![0]).toContain("%42");
    expect(result).toEqual({ sessionName: "dev-impl@my-software-team" });
  });

  it("--json prints raw daemon JSON response", async () => {
    process.env["SOFTWARETEAM_NODE_ID"] = "node-1";
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.resolvedBy).toBe("node_id");
    expect(parsed.identity.logicalId).toBe("dev.impl");
    expect(parsed.peers).toBeDefined();
    expect(parsed.edges).toBeDefined();
  });

  it("no resolution source → exit 1 with guidance", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Cannot determine identity");
  });

  it("daemon 404 → exit 1 with not-found guidance", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami", "--session", "unknown"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("not found");
  });

  it("daemon 409 → exit 1 with ambiguity message", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami", "--session", "ambiguous"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("ambiguous");
  });

  // Adopted-session parity: tmux metadata resolution
  it("TMUX_PANE with @softwareteam_node_id metadata resolves nodeId (takes precedence over display-message)", () => {
    process.env["TMUX_PANE"] = "%42";
    // Mock: @softwareteam_node_id returns a value, display-message would return a DIFFERENT session name
    const mockTmuxExec = vi.fn((cmd: string) => {
      if (cmd.includes("show-option") && cmd.includes("@softwareteam_node_id")) return "node-claimed-123";
      if (cmd.includes("display-message")) return "fallback-session-name";
      throw new Error("unexpected tmux call");
    });

    const result = resolveIdentitySource({}, mockTmuxExec);

    expect(result).toEqual({ nodeId: "node-claimed-123" });
    // display-message should NOT have been called — metadata took precedence
    const displayCalls = mockTmuxExec.mock.calls.filter((c) => (c[0] as string).includes("display-message"));
    expect(displayCalls).toHaveLength(0);
  });

  it("TMUX_PANE with @softwareteam_session_name (no node_id) resolves sessionName (takes precedence over display-message)", () => {
    process.env["TMUX_PANE"] = "%42";
    const mockTmuxExec = vi.fn((cmd: string) => {
      if (cmd.includes("show-option") && cmd.includes("@softwareteam_node_id")) throw new Error("unknown option");
      if (cmd.includes("show-option") && cmd.includes("@softwareteam_session_name")) return "claimed-session@software-team";
      if (cmd.includes("display-message")) return "different-raw-session";
      throw new Error("unexpected tmux call");
    });

    const result = resolveIdentitySource({}, mockTmuxExec);

    expect(result).toEqual({ sessionName: "claimed-session@software-team" });
    const displayCalls = mockTmuxExec.mock.calls.filter((c) => (c[0] as string).includes("display-message"));
    expect(displayCalls).toHaveLength(0);
  });

  it("TMUX_PANE with no metadata falls back to display-message", () => {
    process.env["TMUX_PANE"] = "%42";
    const mockTmuxExec = vi.fn((cmd: string) => {
      if (cmd.includes("show-option")) throw new Error("unknown option");
      if (cmd.includes("display-message")) return "raw-session-name";
      throw new Error("unexpected tmux call");
    });

    const result = resolveIdentitySource({}, mockTmuxExec);

    expect(result).toEqual({ sessionName: "raw-session-name" });
  });

  it("TMUX_PANE with metadata error falls through gracefully to display-message", () => {
    process.env["TMUX_PANE"] = "%42";
    let callCount = 0;
    const mockTmuxExec = vi.fn((cmd: string) => {
      callCount++;
      if (cmd.includes("show-option")) throw new Error("tmux not available");
      if (cmd.includes("display-message")) return "fallback-session";
      throw new Error("unexpected");
    });

    const result = resolveIdentitySource({}, mockTmuxExec);

    expect(result).toEqual({ sessionName: "fallback-session" });
  });

  it("human output includes softwareTeam, pod, session, peers, edges, transcript", async () => {
    process.env["SOFTWARETEAM_NODE_ID"] = "node-1";
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("SoftwareTeam:");
    expect(output).toContain("my-software-team");
    expect(output).toContain("Pod:        dev / impl");
    expect(output).toContain("Logical ID:");
    expect(output).toContain("Transport:");
    expect(output).toContain("dev.impl");
    expect(output).toContain("Pod:");
    expect(output).toContain("Session:");
    expect(output).toContain("dev-impl@my-software-team");
    expect(output).toContain("Peers:");
    expect(output).toContain("dev.qa");
    expect(output).toContain("Edges:");
    expect(output).toContain("delegates_to");
    expect(output).toContain("Transcript:");
  });

  // OPR.99.0.6.1 — the clarified Peers header (the roster contract, in-band).
  it("human Peers header names the roster contract and points at edges + SoftwareTeam ps --nodes", async () => {
    process.env["SOFTWARETEAM_NODE_ID"] = "node-1";
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami"]);
    });
    const output = logs.join("\n");
    // Legacy grep target preserved verbatim.
    expect(output).toContain("Peers:");
    // The discriminator: a fresh reader cannot misread peers[] as the
    // edge-subset (pointed to edges below) or as host inventory (pointed to
    // SoftwareTeam ps --nodes for inventory incl. self).
    expect(output).toContain("roster, excluding self");
    expect(output).toContain("directional edges below");
    expect(output).toContain("SoftwareTeam ps --nodes");
    // Peers + edges still render normally under the clarified header.
    expect(output).toContain("dev.qa");
    expect(output).toContain("delegates_to");
  });

  it("--full --json carries the additive peersNote; peers[] name/shape unchanged; no roster field", async () => {
    // OPR.0.4.0.27: the FULL peer shape now lives behind --full (bare --json is
    // the compact recovery projection).
    process.env["SOFTWARETEAM_NODE_ID"] = "node-1";
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami", "--full", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.peersNote).toContain("roster excluding self");
    expect(Array.isArray(parsed.peers)).toBe(true);
    expect(Object.keys(parsed.peers[0]).sort()).toEqual(
      ["logicalId", "memberId", "podId", "podNamespace", "runtime", "sessionName"],
    );
    expect(parsed.roster).toBeUndefined();
    expect(parsed.podRoster).toBeUndefined();
  });

  it("human output shows missing session honestly and omits transcript section for unbound nodes", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami", "--node-id", "node-2"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Session:    —");
    expect(output).not.toContain("Transcript:");
  });

  it("daemon down with SOFTWARETEAM_NODE_ID env returns partial JSON instead of hard-failing", async () => {
    process.env["SOFTWARETEAM_NODE_ID"] = "node-1";
    const program = new Command();
    program.exitOverride();
    program.addCommand(whoamiCommand(stoppedDeps()));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "SoftwareTeam", "whoami", "--json"]);
    });

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.partial).toBe(true);
    expect(parsed.daemonReachable).toBe(false);
    expect(parsed.identity.nodeId).toBe("node-1");
    expect(exitCode).toBeUndefined();
  });

  it("daemon down preserves SOFTWARETEAM_SESSION_NAME alongside SOFTWARETEAM_NODE_ID in partial JSON", async () => {
    process.env["SOFTWARETEAM_NODE_ID"] = "node-1";
    process.env["SOFTWARETEAM_SESSION_NAME"] = "dev-impl@my-software-team";
    const program = new Command();
    program.exitOverride();
    program.addCommand(whoamiCommand(stoppedDeps()));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "SoftwareTeam", "whoami", "--json"]);
    });

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.partial).toBe(true);
    expect(parsed.identity.nodeId).toBe("node-1");
    expect(parsed.identity.sessionName).toBe("dev-impl@my-software-team");
    expect(exitCode).toBeUndefined();
  });

  it("daemon down with SOFTWARETEAM_SESSION_NAME env prints partial human output", async () => {
    process.env["SOFTWARETEAM_SESSION_NAME"] = "dev-impl@my-software-team";
    const program = new Command();
    program.exitOverride();
    program.addCommand(whoamiCommand(stoppedDeps()));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "SoftwareTeam", "whoami"]);
    });

    const output = logs.join("\n");
    expect(output).toContain("daemon unreachable — topology and peer info unavailable.");
    expect(output).toContain("dev-impl@my-software-team");
    expect(exitCode).toBeUndefined();
  });

  // --- OPR.0.4.0.27 compact-default whoami ---

  it("AC-1/AC-3: --json default is the compact recovery allowlist (exact keys), omitting heavy fields", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami", "--node-id", "node-1", "--json"]);
    });
    const json = JSON.parse(logs.join("")) as Record<string, any>;
    // identity = EXACTLY the 8 recovery keys.
    expect(Object.keys(json.identity).sort()).toEqual(
      ["logicalId", "memberId", "nodeId", "podId", "podNamespace", "softwareTeamName", "runtime", "sessionName"].sort(),
    );
    // recovery essentials present.
    expect(json.resolvedBy).toBe("node_id");
    expect(json.identity.softwareTeamName).toBe("my-software-team");
    expect(json.identity.nodeId).toBe("node-1");
    expect(json.identity.sessionName).toBe("dev-impl@my-software-team");
    expect(json.peers[0].sessionName).toBe("dev-qa@my-software-team");
    expect(json.peersNote).toBeTruthy();
    expect(json.edges.outgoing[0].to.sessionName).toBe("dev-qa@my-software-team");
    expect(json.transcript.path).toContain("dev-impl@my-software-team");
    // heavy/verbose fields OMITTED.
    expect(json.contextUsage).toBeUndefined();
    expect(json.commands).toBeUndefined();
    expect(json.workspace).toBeUndefined();
    expect(json.runtimeContext).toBeUndefined();
    expect(json.identity.cwd).toBeUndefined();
    expect(json.identity.agentRef).toBeUndefined();
    expect(json.identity.softwareTeamId).toBeUndefined();
    // peers dropped their verbose sub-fields.
    expect(json.peers[0].podId).toBeUndefined();
    expect(json.peers[0].memberId).toBeUndefined();
  });

  it("AC-2: --full --json reproduces the complete payload", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami", "--node-id", "node-1", "--json", "--full"]);
    });
    const json = JSON.parse(logs.join("")) as Record<string, any>;
    expect(json.commands).toBeDefined();
    expect(json.identity.cwd).toBe("/tmp");
    expect(json.identity.agentRef).toBe("local:agents/impl");
    expect(json.identity.softwareTeamId).toBe("software-team-1");
    expect(json.peers[0].podId).toBe("pod-dev-123");
  });

  it("compact human output omits the Context line; --full keeps it", async () => {
    const compact = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami", "--node-id", "node-1"]);
    });
    expect(compact.logs.join("\n")).not.toContain("Context:");
    expect(compact.logs.join("\n")).toContain("my-software-team"); // identity still rendered

    const full = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "SoftwareTeam", "whoami", "--node-id", "node-1", "--full"]);
    });
    expect(full.logs.join("\n")).toContain("Context:");
  });

  it("AC-6: --help teaches --full / --verbose", () => {
    let out = "";
    const cmd = whoamiCommand(runningDeps(port));
    cmd.configureOutput({ writeOut: (s) => { out += s; } });
    cmd.outputHelp();
    const help = out.replace(/\s+/g, " ");
    expect(help).toContain("--full");
    expect(help).toContain("--verbose");
  });
});
