import { Command } from "commander";
import { readFileSync } from "node:fs";
import { DaemonClient } from "../client.js";
import { shellQuote } from "../cross-host-executor.js";
import { readSelectedHost } from "../host-selection.js";
import { resolveSoftwareTeamHandle } from "../software-team-handle.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface AddMemberResponse {
  ok: boolean;
  result?: {
    podId: string;
    podNamespace: string;
    node: { logicalId: string; nodeId: string; status: string; error?: string; sessionName?: string };
    edges?: Array<{ from: string; to: string; kind: string }>;
    warnings?: string[];
  };
  code?: string;
  message?: string;
  errors?: string[];
  error?: string;
}

/** Quote a shell argument only when it needs it, so plain suggestions stay readable. */
function shellArg(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : shellQuote(s);
}

export function addMemberCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("add").description("Add a member to an existing pod in a running softwareTeam")
    .addHelpText("after", `
The SoftwareTeam can be named the way SoftwareTeam whoami --json reports it, or by id. A name that
matches more than one SoftwareTeam is refused; use one of the listed ids instead.

Examples:
  SoftwareTeam add my-software-team dev ./reviewer.member.yaml
  SoftwareTeam add 01KXYZ... dev ./reviewer.member.yaml --json`);
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<softwareTeam>", "SoftwareTeam name or ID of the target softwareTeam")
    .argument("<pod-namespace>", "Namespace of the existing pod to add the member to")
    .argument("<member-fragment-path>", "Path to YAML/JSON member fragment file (spec snake_case fields)")
    .option("--json", "JSON output for agents")
    .option("--software-team-root <path>", "Root directory for agent resolution")
    .action(async (softwareTeamHandle: string, podNamespace: string, fragmentPath: string, opts: { json?: boolean; softwareTeamRoot?: string }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      let fileContent: string;
      try {
        fileContent = readFileSync(fragmentPath, "utf-8");
      } catch {
        console.error(`Cannot read file: ${fragmentPath}`);
        process.exitCode = 1;
        return;
      }

      let member: Record<string, unknown>;
      let edges: unknown;
      try {
        // Dynamic import to avoid bundling yaml at module load (matches expand).
        const { parse } = await import("yaml");
        const parsed = (parse(fileContent) ?? {}) as Record<string, unknown>;
        if (parsed["member"] && typeof parsed["member"] === "object" && !Array.isArray(parsed["member"])) {
          // Wrapper form: { member: {...}, edges?: [...] }.
          member = parsed["member"] as Record<string, unknown>;
          edges = parsed["edges"];
        } else {
          // Bare member form. Lift any top-level `edges:` out as pod-local edges
          // so they are NOT silently dropped (the schema ignores unknown member
          // fields). The rest is the member.
          const { edges: bareEdges, ...rest } = parsed;
          member = rest;
          edges = bareEdges;
        }
      } catch {
        console.error("Invalid YAML/JSON in member fragment file");
        process.exitCode = 1;
        return;
      }

      // A PRESENT-but-non-array edges field is an honest error, never silently
      // omitted (governance FM2 no-silent-drop).
      if (edges !== undefined && edges !== null && !Array.isArray(edges)) {
        console.error("Invalid member fragment: 'edges' must be an array of { from, to, kind }.");
        process.exitCode = 1;
        return;
      }
      const body: Record<string, unknown> = { member };
      if (Array.isArray(edges)) body["edges"] = edges;
      if (opts.softwareTeamRoot) body["softwareTeamRoot"] = opts.softwareTeamRoot;

      const client = deps.clientFactory(getDaemonUrl(status));

      const refuse = (error: Record<string, unknown> & { message: string }) => {
        if (opts.json) console.log(JSON.stringify({ ok: false, ...error }, null, 2));
        else console.error(error.message);
        process.exitCode = 1;
      };

      // Resolve before the POST: an ambiguous name must stop here, before any
      // mutation, rather than add the member to whichever softwareTeam matched first.
      const resolution = await resolveSoftwareTeamHandle(client, softwareTeamHandle);

      // softwareTeam add has no --host and always targets the local daemon, while a
      // selected remote host makes whoami/ps report THAT host's softwareTeams. A name
      // copied from them must not land on a same-named local softwareTeam (every
      // install has a `kernel`). Exact local ids keep working as before.
      const selectedHost = readSelectedHost();
      if (selectedHost !== "local" && (resolution.kind === "ambiguous" || (resolution.kind === "resolved" && resolution.byName))) {
        refuse({
          code: "remote_host_selected",
          message: `Host '${selectedHost}' is selected, but SoftwareTeam add only targets the local daemon, so it does not resolve the SoftwareTeam name '${softwareTeamHandle}'. Nothing was added. `
            + "Run SoftwareTeam add on that host, or pass the local SoftwareTeam id (find it with SoftwareTeam ps --json after SoftwareTeam host select local).",
        });
        return;
      }

      if (resolution.kind === "ambiguous") {
        const softwareTeamRoot = opts.softwareTeamRoot ? ` --software-team-root ${shellArg(opts.softwareTeamRoot)}` : "";
        const suggestions = resolution.ids.map((id) => `SoftwareTeam add ${id} ${shellArg(podNamespace)} ${shellArg(fragmentPath)}${softwareTeamRoot}`);
        refuse({
          code: "software_team_ambiguous",
          message: `'${softwareTeamHandle}' matches ${resolution.ids.length} softwareTeams. Nothing was added. Re-run with the specific id, e.g. ${suggestions.join("  |  ")}`,
          candidates: resolution.ids,
        });
        return;
      }
      const softwareTeamId = resolution.kind === "resolved" ? resolution.id : softwareTeamHandle;

      const res = await client.post<AddMemberResponse>(
        `/api/software-teams/${encodeURIComponent(softwareTeamId)}/pods/${encodeURIComponent(podNamespace)}/members`,
        body,
        { timeoutMs: 120_000 },
      );
      const data = res.data;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        // Non-zero if the HTTP failed OR the new node did not fully launch.
        if (res.status >= 400 || (data.ok && data.result !== undefined && data.result.node.status !== "launched")) {
          process.exitCode = 1;
        }
        return;
      }

      if (res.status >= 400 || !data.ok) {
        // Honest 3-part error: the daemon's message already says what failed /
        // why / what to do (pod_not_found lists pods; member_conflict suggests a
        // new id); validation/preflight surface the specific field errors.
        const msg = data.message
          ?? (data.errors && data.errors.length > 0 ? data.errors.join("; ") : data.error)
          ?? `Add member failed (HTTP ${res.status})`;
        console.error(msg);
        if (resolution.kind === "passthrough" && data.code === "software_team_not_found") {
          console.error("Could not list softwareTeams to resolve a name. If this is a SoftwareTeam name, pass the SoftwareTeam id instead (SoftwareTeam ps --json).");
        }
        process.exitCode = 1;
        return;
      }

      const node = data.result!.node;
      const icon = node.status === "launched" ? "OK" : "FAIL";
      const session = node.sessionName ? ` (${node.sessionName})` : "";
      const error = node.error ? ` - ${node.error}` : "";
      console.log(`Added member to softwareTeam ${softwareTeamId === softwareTeamHandle ? softwareTeamId : `${softwareTeamHandle} (${softwareTeamId})`}`);
      console.log(`  Pod: ${data.result!.podNamespace}`);
      console.log(`  Member: [${icon}] ${node.logicalId}${session}${error}`);

      const persistedEdges = data.result!.edges ?? [];
      if (persistedEdges.length > 0) {
        console.log("  Edges:");
        for (const e of persistedEdges) console.log(`    ${e.from} ${e.kind} ${e.to}`);
      }

      if (data.result!.warnings && data.result!.warnings.length > 0) {
        console.log("");
        for (const w of data.result!.warnings) console.log(`  Warning: ${w}`);
      }

      if (node.status !== "launched") {
        process.exitCode = 1;
      }
    });

  return cmd;
}
