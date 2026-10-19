import nodePath from "node:path";
import { Command } from "commander";
import fs from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface ImportDeps extends StatusDeps {
  readFile: (path: string) => string;
}

const LONG_RUNNING_IMPORT_TIMEOUT_MS = 120_000;

export function importCommand(depsOverride?: ImportDeps): Command {
  const cmd = new Command("import").description("Import a SoftwareTeam spec from YAML");
  const getDeps = (): ImportDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };

  cmd
    .argument("<path>", "Path to YAML SoftwareTeam spec file")
    .option("--instantiate", "Instantiate the SoftwareTeam after import")
    .option("--materialize-only", "Create SoftwareTeam topology without launching sessions")
    .option("--workspace-only", "Apply only the workspace declaration to an existing softwareTeam")
    .option("--preflight", "Run preflight checks")
    .option("--target-software-team <softwareTeamId>", "Target existing SoftwareTeam for materialization or workspace apply")
    .option("--software-team-root <root>", "Root directory for pod-aware resolution")
    .option("--cwd <path>", "Override launch/materialization working directory for all members")
    .action(async (filePath: string, opts: { instantiate?: boolean; materializeOnly?: boolean; workspaceOnly?: boolean; preflight?: boolean; targetSoftwareTeam?: string; softwareTeamRoot?: string; cwd?: string }) => {
      const deps = getDeps();

      // Read local file first (before daemon check — fail fast on missing file)
      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`Cannot read file: ${filePath}`);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // Detect pod-aware specs for X-Software-Team-Root header
      let podAware = false;
      try { const { parse } = await import("yaml"); const parsed = parse(yaml); podAware = !!parsed && Array.isArray(parsed.pods); } catch { /* not parseable — let daemon validate */ }
      const softwareTeamRoot = podAware
        ? (opts.softwareTeamRoot ? nodePath.resolve(opts.softwareTeamRoot) : nodePath.dirname(nodePath.resolve(filePath)))
        : undefined;
      const cwdOverride = opts.cwd ? nodePath.resolve(opts.cwd) : undefined;
      const extraHeaders = {
        ...(softwareTeamRoot ? { "X-Software-Team-Root": softwareTeamRoot } : {}),
        ...(cwdOverride ? { "X-Cwd-Override": cwdOverride } : {}),
      };

      if (opts.instantiate && opts.materializeOnly) {
        console.error("Choose either --instantiate or --materialize-only, not both.");
        process.exitCode = 1;
        return;
      }
      if (opts.workspaceOnly && (opts.instantiate || opts.materializeOnly || opts.preflight)) {
        console.error("--workspace-only cannot be combined with --instantiate, --materialize-only, or --preflight.");
        process.exitCode = 1;
        return;
      }

      if (opts.workspaceOnly) {
        if (!opts.targetSoftwareTeam) {
          console.error("--workspace-only requires --target-software-team <softwareTeamId>.");
          process.exitCode = 1;
          return;
        }
        const res = await client.postText<
          { softwareTeamId: string; changed: boolean; workspace: unknown }
          | { ok: false; code: string; errors?: string[]; message?: string; error?: string }
        >("/api/software-teams/import/workspace", yaml, "text/yaml", { "X-Target-software-team-Id": opts.targetSoftwareTeam });
        if (res.status >= 400) {
          const data = res.data as { errors?: string[]; message?: string; error?: string };
          const detail = data.errors?.join("\n  ") ?? data.message ?? data.error ?? `status ${res.status}`;
          console.error(`Workspace apply failed:\n  ${detail}\nFix: update the SoftwareTeamSpec workspace or target SoftwareTeam and retry.`);
          process.exitCode = 1;
          return;
        }
        const data = res.data as { softwareTeamId: string; changed: boolean };
        console.log(data.changed
          ? `Workspace applied to SoftwareTeam ${data.softwareTeamId}`
          : `Workspace already matches SoftwareTeam ${data.softwareTeamId}`);
        return;
      }

      if (opts.preflight) {
        const res = await client.postText<{ ready?: boolean; warnings?: string[]; errors?: string[] }>("/api/software-teams/import/preflight", yaml, "text/yaml", extraHeaders);
        if (res.status >= 400) {
          console.error(`Preflight failed (HTTP ${res.status}). Check your spec syntax and software-team-root path.`);
          process.exitCode = 1;
          return;
        }
        const data = res.data;
        if (data.errors && data.errors.length > 0) {
          console.error(`Preflight errors:\n${data.errors.map((e) => `  ${e}`).join("\n")}`);
        }
        if (data.warnings && data.warnings.length > 0) {
          console.log(`Preflight warnings:\n${data.warnings.map((w) => `  ${w}`).join("\n")}`);
        }
        if (data.ready) {
          console.log("Preflight passed");
        } else {
          console.error("Preflight not ready. Fix: resolve the errors above and retry.");
          process.exitCode = 1;
        }
        return;
      }

      if (opts.materializeOnly) {
        if (!podAware) {
          console.error("Materialize-only requires a pod-aware SoftwareTeamSpec with pods.");
          process.exitCode = 1;
          return;
        }
        const headers = {
          ...extraHeaders,
          ...(opts.targetSoftwareTeam ? { "X-Target-software-team-Id": opts.targetSoftwareTeam } : {}),
        };
        const res = await client.postText<{ softwareTeamId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }> } | { ok: false; code: string; errors?: string[]; message?: string; error?: string }>("/api/software-teams/import/materialize", yaml, "text/yaml", headers);
        if (res.status === 409 || res.status === 400 || res.status === 404) {
          const data = res.data as { ok?: false; code?: string; errors?: string[]; message?: string; error?: string };
          if (data.code === "software_team_name_running") {
            console.error(data.error ?? data.message ?? "A SoftwareTeam with this name is already running.");
            process.exitCode = 1;
            return;
          }
          const detail = data.errors?.join("\n  ") ?? data.message ?? data.error ?? `status ${res.status}`;
          console.error(`Materialize failed:\n  ${detail}\nFix: update your spec or target SoftwareTeam and retry.`);
          process.exitCode = 1;
          return;
        }
        if (res.status >= 400) {
          console.error(`Materialize failed (HTTP ${res.status}). Check spec and daemon logs.`);
          process.exitCode = 1;
          return;
        }
        const data = res.data as { softwareTeamId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }> };
        console.log(`SoftwareTeam materialized: ${data.specName} (${data.softwareTeamId})`);
        for (const n of data.nodes) {
          console.log(`  ${n.logicalId}: ${n.status}`);
        }
        return;
      }

      if (opts.instantiate) {
        const res = await client.postText<{ softwareTeamId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }> } | { ok: false; code: string; errors?: string[]; message?: string; error?: string }>(
          "/api/software-teams/import",
          yaml,
          "text/yaml",
          extraHeaders,
          { timeoutMs: LONG_RUNNING_IMPORT_TIMEOUT_MS },
        );
        if (res.status === 409 || res.status === 400) {
          const data = res.data as { ok: false; code: string; errors?: string[]; message?: string; error?: string };
          if (data.code === "software_team_name_running") {
            console.error(data.error ?? data.message ?? "A SoftwareTeam with this name is already running.");
            process.exitCode = 1;
            return;
          }
          const detail = data.errors?.join("\n  ") ?? data.message ?? `status ${res.status}`;
          console.error(`Import failed:\n  ${detail}\nFix: check your SoftwareTeam spec and retry. Validate first with: SoftwareTeam spec validate <path>`);
          process.exitCode = 1;
        } else if (res.status >= 400) {
          console.error(`Import failed (HTTP ${res.status}). Check spec and daemon logs.`);
          process.exitCode = 1;
        } else {
          const data = res.data as { softwareTeamId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }>; attachCommand?: string; warnings?: string[] };
          console.log(`SoftwareTeam created: ${data.specName} (${data.softwareTeamId})`);
          for (const warning of data.warnings ?? []) console.warn(`Warning: ${warning}`);
          for (const n of data.nodes) {
            console.log(`  ${n.logicalId}: ${n.status}`);
          }
          if (data.attachCommand) {
            console.log(`Attach: ${data.attachCommand}`);
          }
        }
        return;
      }

      // Default: validate only
      const res = await client.postText<{ valid?: boolean; errors?: string[] }>("/api/software-teams/import/validate", yaml);
      if (res.status >= 400) {
        console.error(`Validation failed: invalid spec (HTTP ${res.status}). Check your YAML syntax and retry.`);
        process.exitCode = 1;
        return;
      }
      const data = res.data;
      if (data.valid) {
        console.log("Valid");
      } else {
        console.error(`SoftwareTeam spec invalid:\n${(data.errors ?? []).map((e) => `  ${e}`).join("\n")}\nFix: update your spec and re-validate with: SoftwareTeam spec validate <path>`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
