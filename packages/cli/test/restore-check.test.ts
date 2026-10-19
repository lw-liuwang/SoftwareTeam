import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { restoreCheckCommand, type RestoreCheckDeps } from "../src/commands/restore-check.js";

function makeResult(overrides?: Record<string, unknown>) {
  return {
    verdict: "restorable",
    readiness: {
      status: "ready",
      reason: "all_observable_checks_green",
      blockingSoftwareTeamCount: 0,
      caveatSoftwareTeamCount: 0,
      unknownSoftwareTeamCount: 0,
    },
    continuity: {
      status: "not_proven",
      evidence: "Strict same-session/provider-context resume is not verified by restore-check v1. Observable readiness is verified.",
      provenCapabilities: [],
      unprovenCapabilities: ["provider_session_resume", "context_window_preservation", "interrupted_work_functional_resume"],
    },
    softwareTeams: [{
      softwareTeamId: "software-team-1",
      softwareTeamName: "test-software-team",
      status: "ready",
      verdict: "restorable",
      expectedNodes: 1,
      runningReadyNodes: 1,
      blockedNodes: 0,
      caveatNodes: 0,
      blockingChecks: [],
      caveatChecks: [],
    }],
    hostInfra: {
      status: "not_inspected",
      evidence: "No host bootstrap/autostart source inspected by v0",
    },
    counts: { red: 0, yellow: 1, green: 5 },
    checks: [
      { check: "daemon.reachable", status: "green", evidence: "Daemon running on port 7434", remediation: "" },
      { check: "host.state-dir-writable", status: "green", evidence: "~/.softwareteam/ is writable", remediation: "" },
      { check: "softwareTeam.test-software-team.snapshot", status: "yellow", evidence: "No snapshot found", remediation: "Create a snapshot" },
    ],
    repairPacket: null,
    recovery: {
      status: "not_needed",
      summary: "All observable softwareTeams are already running/ready; no recovery action needed.",
      actions: [],
      blocked: [],
      unknown: [],
    },
    ...overrides,
  };
}

function makeDeps(overrides?: {
  daemonDown?: boolean;
  result?: Record<string, unknown>;
  serverError?: boolean;
}): { deps: RestoreCheckDeps; requestedPaths: string[] } {
  const requestedPaths: string[] = [];
  return {
    requestedPaths,
    deps: {
      lifecycleDeps: {} as RestoreCheckDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => {
          requestedPaths.push(path);
          if (overrides?.serverError) return { status: 500, data: { error: "internal error" } };
          return { status: 200, data: makeResult(overrides?.result) };
        }),
      }) as unknown as ReturnType<RestoreCheckDeps["clientFactory"]>,
    },
  };
}

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7434 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7434"),
  };
});

describe("SoftwareTeam restore-check", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    process.exitCode = undefined;
  });

  it("JSON output has verdict + counts + checks + repairPacket", async () => {
    const { deps } = makeDeps();
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.verdict).toBe("restorable");
    expect(json.readiness.status).toBe("ready");
    expect(json.continuity).toBeDefined();
    expect(json.softwareTeams).toBeInstanceOf(Array);
    expect(json.hostInfra.status).toBe("not_inspected");
    expect(json.counts).toBeDefined();
    expect(json.checks).toBeInstanceOf(Array);
    expect(json.repairPacket).toBeNull();
    expect(json.recovery).toEqual(expect.objectContaining({
      status: "not_needed",
      actions: [],
      blocked: [],
      unknown: [],
    }));
    expect(json.checks[0].check).toBeDefined();
    expect(json.checks[0].status).toBeDefined();
    expect(json.checks[0].evidence).toBeDefined();
    expect(json.checks[0].remediation).toBeDefined();
  });

  it("JSON output preserves declared host-infra status and evidence", async () => {
    const { deps } = makeDeps({
      result: {
        hostInfra: {
          status: "declared",
          evidence: "Host infra declaration at /tmp/softwareteam/host-infra.json declared, not verified; daemonBootstrap mechanism=launchd; requiredSupportingInfra=1",
        },
      },
    });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.hostInfra.status).toBe("declared");
    expect(json.hostInfra.evidence).toContain("declared, not verified");
    expect(json.hostInfra.evidence).toContain("mechanism=launchd");
  });

  it("human output includes verdict + check details + remediation", async () => {
    const { deps } = makeDeps({ result: { verdict: "restorable_with_caveats" } });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--full"]);

    const output = logs.join("\n");
    expect(output).toContain("RESTORE CHECK");
    expect(output).toContain("RESTORABLE WITH CAVEATS");
    expect(output).toContain("READINESS:");
    expect(output).toContain("Per-software-team summary");
    expect(output).toContain("test-software-team");
    expect(output).toContain("Host bootstrap/autostart");
    expect(output).toContain("RECOVERY:");
    expect(output).toContain("daemon.reachable");
  });

  it("human output includes exact recovery action commands", async () => {
    const { deps } = makeDeps({
      result: {
        verdict: "not_restorable",
        readiness: {
          status: "not_ready",
          reason: "blockers_present",
          blockingSoftwareTeamCount: 1,
          caveatSoftwareTeamCount: 0,
          unknownSoftwareTeamCount: 0,
        },
        recovery: {
          status: "actionable",
          summary: "1 SoftwareTeam can be recovered by known SoftwareTeam command; 0 blocked; 0 unknown.",
          actions: [
            {
              scope: "softwareTeam",
              softwareTeamId: "software-team-1",
              softwareTeamName: "test-software-team",
              action: "restore_from_latest_snapshot",
              command: "SoftwareTeam up --existing test-software-team",
              reason: "SoftwareTeam has a latest snapshot and one or more seats are not running/ready.",
              safe: false,
              blocking: true,
            },
          ],
          blocked: [],
          unknown: [],
        },
      },
    });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam"]);

    const output = logs.join("\n");
    expect(output).toContain("RECOVERY: ACTIONABLE");
    expect(output).toContain("SoftwareTeam up --existing test-software-team");
    expect(output).toContain("1 SoftwareTeam can be recovered");
  });

  it("human output shows declared-not-verified host-infra evidence", async () => {
    const { deps } = makeDeps({
      result: {
        readiness: {
          status: "ready",
          reason: "all_observable_checks_green_host_infra_declared_not_verified",
          blockingSoftwareTeamCount: 0,
          caveatSoftwareTeamCount: 0,
          unknownSoftwareTeamCount: 0,
        },
        hostInfra: {
          status: "declared",
          evidence: "Host infra declaration at /tmp/softwareteam/host-infra.json declared, not verified; daemonBootstrap mechanism=launchd; requiredSupportingInfra=1",
        },
      },
    });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--full"]);

    const output = logs.join("\n");
    expect(output).toContain("READINESS: ready (all_observable_checks_green_host_infra_declared_not_verified)");
    expect(output).toContain("Host bootstrap/autostart: declared");
    expect(output).toContain("declared, not verified");
    expect(output).toContain("mechanism=launchd");
  });

  it("JSON output preserves host-infra evidence-path presence copy", async () => {
    const { deps } = makeDeps({
      result: {
        hostInfra: {
          status: "declared",
          evidence: "Host infra declaration at /tmp/softwareteam/host-infra.json declared, evidence paths present, not autostart verified; daemonBootstrap mechanism=launchd; requiredSupportingInfra=1; evidencePaths=/tmp/softwareteam/daemon/launchd.plist,/tmp/softwareteam/supervisor-wake/README.md",
        },
        checks: [
          { check: "host.bootstrap-autostart.declaration", status: "green", evidence: "declared, evidence paths present, not autostart verified", remediation: "" },
        ],
      },
    });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.hostInfra.status).toBe("declared");
    expect(json.hostInfra.evidence).toContain("evidence paths present");
    expect(json.hostInfra.evidence).toContain("not autostart verified");
    expect(json.checks[0].evidence).toContain("not autostart verified");
  });

  it("human output preserves missing host-infra evidence-path repair guidance", async () => {
    const missingPath = "/tmp/softwareteam/supervisor-wake/README.md";
    const { deps } = makeDeps({
      result: {
        verdict: "restorable_with_caveats",
        readiness: {
          status: "ready_with_caveats",
          reason: "caveats_present",
          blockingSoftwareTeamCount: 0,
          caveatSoftwareTeamCount: 0,
          unknownSoftwareTeamCount: 0,
        },
        hostInfra: {
          status: "declared",
          evidence: `Host infra declaration at /tmp/softwareteam/host-infra.json declared with insufficient evidence paths; missing ${missingPath}`,
        },
        counts: { red: 0, yellow: 1, green: 4 },
        checks: [
          { check: "host.bootstrap-autostart.declaration", status: "yellow", evidence: `Missing required evidence path: ${missingPath}`, remediation: `Add or repair host infra evidence path: ${missingPath}` },
        ],
        repairPacket: [
          { step: 1, command: `Add or repair host infra evidence path: ${missingPath}`, rationale: `Missing required evidence path: ${missingPath}`, safe: false, blocking: false },
        ],
      },
    });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--full"]);

    const output = logs.join("\n");
    expect(output).toContain("RESTORABLE WITH CAVEATS");
    expect(output).toContain(missingPath);
    expect(output).toContain("Repair steps: 1");
    expect(output).toContain("0 blocking");
    expect(output).toContain("1 caveats");
  });

  it("exit 0 for restorable verdict", async () => {
    const { deps } = makeDeps({ result: { verdict: "restorable" } });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("exit 0 for restorable_with_caveats verdict", async () => {
    const { deps } = makeDeps({ result: { verdict: "restorable_with_caveats" } });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("exit 1 for not_restorable verdict", async () => {
    const { deps } = makeDeps({ result: { verdict: "not_restorable", counts: { red: 1, yellow: 0, green: 0 } } });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);
    expect(process.exitCode).toBe(1);
  });

  it("exit 2 for unknown verdict", async () => {
    const { deps } = makeDeps({ result: { verdict: "unknown", counts: { red: 0, yellow: 0, green: 0 } } });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);
    expect(process.exitCode).toBe(2);
  });

  it("exit 2 on daemon 500 error with blocking repairPacket", async () => {
    const { deps } = makeDeps({ serverError: true });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);
    expect(process.exitCode).toBe(2);
    const json = JSON.parse(logs.join(""));
    expect(json.repairPacket).not.toBeNull();
    expect(json.repairPacket[0].blocking).toBe(true);
    expect(json.repairPacket[0].command).toContain("SoftwareTeam daemon logs");
  });

  it("human output shows repair step count when repairPacket is non-null", async () => {
    const { deps } = makeDeps({ result: {
      verdict: "not_restorable",
      counts: { red: 1, yellow: 1, green: 3 },
      repairPacket: [
        { step: 1, command: "Start the daemon", rationale: "Daemon down", safe: false, blocking: true },
        { step: 2, command: "Create snapshot", rationale: "No snapshot", safe: false, blocking: false },
      ],
    }});
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--full"]);

    const output = logs.join("\n");
    expect(output).toContain("Repair steps: 2");
    expect(output).toContain("1 blocking");
    expect(output).toContain("1 caveats");
  });

  it("--software-team passes through to daemon route query", async () => {
    const { deps, requestedPaths } = makeDeps();
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--software-team", "softwareteam-pm", "--json"]);

    expect(requestedPaths.some((p) => p.includes("softwareTeam=softwareteam-pm"))).toBe(true);
  });

  it("--no-queue passes through to daemon route query", async () => {
    const { deps, requestedPaths } = makeDeps();
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--no-queue", "--json"]);

    expect(requestedPaths.some((p) => p.includes("noQueue=true"))).toBe(true);
  });

  it("--no-hooks passes through to daemon route query", async () => {
    const { deps, requestedPaths } = makeDeps();
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--no-hooks", "--json"]);

    expect(requestedPaths.some((p) => p.includes("noHooks=true"))).toBe(true);
  });

  it("daemon-down produces not_restorable locally without daemon call", async () => {
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    (getDaemonStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "stopped", healthy: false });

    const { deps, requestedPaths } = makeDeps();
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.verdict).toBe("not_restorable");
    expect(json.readiness.status).toBe("not_ready");
    expect(json.softwareTeams).toEqual([]);
    expect(json.hostInfra.status).toBe("unknown");
    expect(json.checks[0].check).toBe("daemon.reachable");
    expect(json.checks[0].status).toBe("red");
    expect(json.recovery).toEqual(expect.objectContaining({
      status: "blocked",
      actions: [],
      unknown: [],
      blocked: [
        expect.objectContaining({
          scope: "host",
          reason: expect.stringContaining("Daemon is not running"),
        }),
      ],
    }));
    // Daemon-down local result includes repairPacket with blocking step
    expect(json.repairPacket).not.toBeNull();
    expect(json.repairPacket[0].blocking).toBe(true);
    expect(json.repairPacket[0].command).toContain("SoftwareTeam daemon start");
    expect(process.exitCode).toBe(1);
    // Should NOT have called the daemon
    expect(requestedPaths).toHaveLength(0);
  });

  it("daemon 500 local fallback includes readiness shape", async () => {
    const { deps } = makeDeps({ serverError: true });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.verdict).toBe("unknown");
    expect(json.readiness).toEqual(expect.objectContaining({
      status: "unknown",
      reason: "unknown_probe_state",
    }));
    expect(json.softwareTeams).toEqual([]);
    expect(json.hostInfra.status).toBe("unknown");
    expect(json.recovery).toEqual(expect.objectContaining({
      status: "unknown",
      actions: [],
      blocked: [],
      unknown: [
        expect.objectContaining({
          scope: "host",
          reason: expect.stringContaining("HTTP 500"),
        }),
      ],
    }));
    expect(json.repairPacket[0]).toEqual(expect.objectContaining({
      blocking: true,
      safe: true,
    }));
  });

  // --- H62 absence proofs ---

  it("JSON output has no fullyBack or assertion fields", async () => {
    const { deps } = makeDeps({});
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect("fullyBack" in json).toBe(false);
    expect("assertion" in json).toBe(false);
    expect(json.readiness).toBeDefined();
    expect(json.continuity).toBeDefined();
  });

  it("human output has no FULLY BACK line", async () => {
    const { deps } = makeDeps({});
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--full"]);

    const output = logs.join("\n");
    expect(output).not.toContain("FULLY BACK");
    expect(output).toContain("READINESS:");
    expect(output).toContain("CONTINUITY:");
  });

  it("daemon-down CLI fallback emits readiness + continuity with no legacy fields", async () => {
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    (getDaemonStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "stopped", healthy: false });

    const { deps } = makeDeps({});
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect("fullyBack" in json).toBe(false);
    expect("assertion" in json).toBe(false);
    expect(json.readiness.status).toBe("not_ready");
    expect(json.continuity.status).toBe("not_proven");
    expect(json.continuity.unprovenCapabilities.length).toBeGreaterThan(0);
  });

  it("per-software-team status values use readiness vocabulary", async () => {
    const { deps } = makeDeps({});
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "softwareTeam", "--json"]);

    const json = JSON.parse(logs.join(""));
    for (const softwareTeam of json.softwareTeams) {
      expect(["ready", "ready_with_caveats", "not_ready", "unknown"]).toContain(softwareTeam.status);
      expect(softwareTeam.status).not.toBe("fully_back");
      expect(softwareTeam.status).not.toBe("not_fully_back");
    }
  });
});

describe("OPR.0.4.0.29 — --ready is compact + ready detail (not a no-op, not the firehose)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  it("--ready keeps compact AND adds ready=1 (regression: FAILS if --ready is a no-op or drops compact)", async () => {
    const { deps, requestedPaths } = makeDeps({});
    await restoreCheckCommand(deps).parseAsync(["node", "softwareTeam", "--ready"]);
    expect(requestedPaths[0]).toContain("compact=1");
    expect(requestedPaths[0]).toContain("ready=1");
  });

  it("default is compact WITHOUT ready", async () => {
    const { deps, requestedPaths } = makeDeps({});
    await restoreCheckCommand(deps).parseAsync(["node", "softwareTeam"]);
    expect(requestedPaths[0]).toContain("compact=1");
    expect(requestedPaths[0]).not.toContain("ready=1");
  });

  it("--full drops compact (the firehose); --ready does NOT", async () => {
    const full = makeDeps({});
    await restoreCheckCommand(full.deps).parseAsync(["node", "softwareTeam", "--full"]);
    expect(full.requestedPaths[0]).not.toContain("compact=1");
  });
});

describe("OPR.0.4.3.12 — fixture-home isolation guard", () => {
  let logs: string[];
  let fixtureHome: string;
  // Snapshot of the SoftwareTeam target env vars the ambient session may set.
  const ENV_KEYS = ["SOFTWARETEAM_HOME", "SOFTWARETEAM_PORT", "SOFTWARETEAM_URL", "SOFTWARETEAM_HOST", "SOFTWARETEAM_DB", "SOFTWARETEAM_PORT", "SOFTWARETEAM_URL"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
    // Isolate the target env: clear ambient SOFTWARETEAM_PORT/URL/etc so the
    // fixture's config.json is the resolved daemon target, then point HOME
    // at a fresh fixture dir.
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    fixtureHome = mkdtempSync(join(tmpdir(), "softwareteam-qa-rc-test-"));
    writeFileSync(join(fixtureHome, ".softwareteam-fixture"), "");
    process.env.SOFTWARETEAM_HOME = fixtureHome;
  });

  afterEach(() => {
    rmSync(fixtureHome, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it("fixture-scoped home + divergent target → honest both-homes result, non-mutating, no scope:host", async () => {
    writeFileSync(join(fixtureHome, "config.json"), JSON.stringify({ daemon: { port: 9911 } }));
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    (getDaemonStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "stopped", healthy: false });

    const { deps, requestedPaths } = makeDeps();
    await restoreCheckCommand(deps).parseAsync(["node", "softwareTeam", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.verdict).toBe("unknown");
    expect(json.checks[0].check).toBe("home.fixture-scoped");
    // Names BOTH homes + the divergent port.
    expect(json.checks[0].evidence).toContain(fixtureHome);
    expect(json.checks[0].evidence).toContain(join(homedir(), ".softwareteam"));
    expect(json.checks[0].evidence).toContain("9911");
    // Non-mutating remediation — never `SoftwareTeam daemon start`.
    expect(json.repairPacket[0].blocking).toBe(false);
    expect(json.repairPacket[0].safe).toBe(true);
    expect(logs.join("")).not.toContain("SoftwareTeam daemon start");
    // No scope:host down-signal.
    expect(json.recovery.status).toBe("unknown");
    expect(json.recovery.blocked).toEqual([]);
    // Honest "unknown" exit, not the blocking not_restorable(1).
    expect(process.exitCode).toBe(2);
    // Daemon route not called.
    expect(requestedPaths).toHaveLength(0);
  });

  it("leaked SOFTWARETEAM_URL under a fixture home also triggers the guard", async () => {
    process.env.SOFTWARETEAM_URL = "http://127.0.0.1:9977";
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    (getDaemonStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "stopped", healthy: false });

    const { deps } = makeDeps();
    await restoreCheckCommand(deps).parseAsync(["node", "softwareTeam", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.verdict).toBe("unknown");
    expect(json.checks[0].check).toBe("home.fixture-scoped");
    expect(json.checks[0].evidence).toContain("9977");
    expect(process.exitCode).toBe(2);
  });

  it("fixture home but DEFAULT/non-divergent target → falls through to genuine daemon-down packet", async () => {
    // No config.json → daemon.port resolves to the default 7434 (source
    // "default") → NOT divergent → guard skipped → existing packet unchanged.
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    (getDaemonStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "stopped", healthy: false });

    const { deps } = makeDeps();
    await restoreCheckCommand(deps).parseAsync(["node", "softwareTeam", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.verdict).toBe("not_restorable");
    expect(json.checks[0].check).toBe("daemon.reachable");
    expect(json.repairPacket[0].command).toContain("SoftwareTeam daemon start");
    expect(json.repairPacket[0].blocking).toBe(true);
    expect(json.recovery.blocked[0].scope).toBe("host");
    expect(process.exitCode).toBe(1);
  });
});

describe("OPR.0.4.0.29 FR-8 — class breakdown render", () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  it("compact human output renders the 5-class CLASSES line when classCounts is present", async () => {
    const { deps } = makeDeps({ result: { classCounts: { ready: 3, ready_with_caveats: 1, not_ready: 2, attention_required: 0, unknown: 0 } } });
    await restoreCheckCommand(deps).parseAsync(["node", "softwareTeam"]);
    const output = logs.join("\n");
    expect(output).toContain("CLASSES:");
    expect(output).toContain("3 ready");
    expect(output).toContain("2 not_ready");
  });
});
