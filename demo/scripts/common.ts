import fs from "node:fs";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  filterNodesForSoftwareTeamId,
  selectCurrentSoftwareTeamSummary,
} from "../../packages/daemon/src/domain/demo-software-team-selector.js";

export interface DemoSoftwareTeamSummary {
  softwareTeamId: string;
  name: string;
  nodeCount?: number;
  status?: string;
}

export interface DemoNodeEntry {
  softwareTeamId: string;
  softwareTeamName: string;
  logicalId: string;
  canonicalSessionName: string | null;
  nodeKind: string;
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: string | null;
  restoreOutcome: string | null;
  resumeType?: string | null;
  resumeToken?: string | null;
  latestError?: string | null;
  cwd?: string | null;
}

export function repoRoot(): string {
  return nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i++;
  }
  return result;
}

export function runCommand(command: string, args: string[], cwd = repoRoot()): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function runSoftwareTeam(args: string[]): string {
  return runCommand("softwareTeam", args);
}

export function runSoftwareTeamJson<T>(args: string[]): T {
  const output = runSoftwareTeam(args);
  return JSON.parse(output) as T;
}

export function runTmux(args: string[], cwd = repoRoot()): string {
  return runCommand("tmux", args, cwd);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function listSoftwareTeamSummaries(): DemoSoftwareTeamSummary[] {
  return runSoftwareTeamJson<DemoSoftwareTeamSummary[]>(["ps", "--json"]);
}

export function getCurrentSoftwareTeamSummary(softwareTeamNameOrId: string): DemoSoftwareTeamSummary | null {
  const summaries = listSoftwareTeamSummaries();
  const byId = summaries.find((summary) => summary.softwareTeamId === softwareTeamNameOrId);
  if (byId) {
    return byId;
  }
  return selectCurrentSoftwareTeamSummary(summaries, softwareTeamNameOrId);
}

export function listSoftwareTeamNodes(softwareTeamNameOrId: string): DemoNodeEntry[] {
  const summary = getCurrentSoftwareTeamSummary(softwareTeamNameOrId);
  if (!summary) {
    return [];
  }
  return filterNodesForSoftwareTeamId(
    runSoftwareTeamJson<DemoNodeEntry[]>(["ps", "--nodes", "--json"]),
    summary.softwareTeamId
  );
}

export function resolveNodeCwd(cwdValue: string | null | undefined): string {
  if (!cwdValue || cwdValue === ".") return repoRoot();
  if (nodePath.isAbsolute(cwdValue)) return cwdValue;
  return nodePath.resolve(repoRoot(), cwdValue);
}

export function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function writeJson(outputPath: string, data: unknown): void {
  fs.mkdirSync(nodePath.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function isAgentRuntime(runtime: string | null): boolean {
  return runtime === "claude-code" || runtime === "codex";
}
