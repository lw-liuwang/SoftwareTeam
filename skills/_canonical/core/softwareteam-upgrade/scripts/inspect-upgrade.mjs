#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const softwareTeam = process.env.SOFTWARETEAM_BIN || "softwareTeam";

function probe(name, args, next) {
  const result = spawnSync(softwareTeam, args, { encoding: "utf8" });
  const stdout = result.stdout?.trim() || "";
  const stderr = result.stderr?.trim() || "";
  if (result.status === 0) {
    let value = stdout;
    try {
      value = JSON.parse(stdout);
    } catch {
      // Versions and older surfaces may intentionally return plain text.
    }
    return { name, ok: true, command: [softwareTeam, ...args], value };
  }
  return {
    name,
    ok: false,
    command: [softwareTeam, ...args],
    exitCode: result.status,
    error: stderr || stdout || result.error?.message || "command produced no diagnostic",
    next,
  };
}

const report = {
  schema: "softwareteam-upgrade-inspection/v1",
  generatedAt: new Date().toISOString(),
  softwareTeamVersion: probe("softwareTeamVersion", ["--version"], `run ${softwareTeam} --version directly and verify the installed wrapper`),
  daemonStatus: probe("daemonStatus", ["daemon", "status"], `run ${softwareTeam} daemon status and inspect daemon state and logs`),
  nodes: probe("nodes", ["ps", "--nodes", "-A", "--json"], `run ${softwareTeam} ps --nodes -A --json and resolve control-plane reachability before mutation`),
  plugins: probe("plugins", ["plugin", "list", "--json"], `run ${softwareTeam} plugin list --json and derive the installed plugin roots before refresh`),
};

report.ready = [report.softwareTeamVersion, report.daemonStatus, report.nodes, report.plugins].every((item) => item.ok);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
