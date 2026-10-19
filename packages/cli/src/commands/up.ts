import nodePath from "node:path";
import { isGitHubBundleLink, importGitHubBundle, bundleIdentityLines, printBundleLinkError } from "../lib/bundle-source.js";
import { getCliVersion, bundleRoutingSummary, bundleInstallError, startupAttentionSummary } from "./bundle.js";
import { showBundleBehaviourBeforeAction } from "../bundle-behaviour.js";
import { resolveEffectiveHost } from "../host-selection.js";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYamlDoc } from "yaml";
import { Command } from "commander";
import { DaemonClient, DaemonConnectionError } from "../client.js";
import { getDaemonStatus, getDaemonUrl, startDaemon, type LifecycleDeps, daemonStatusGuard } from "../daemon-lifecycle.js";
import { prepareDaemonAutoStart } from "../daemon-auto-start.js";
import type { StartOptions } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { formatThreePart, type ThreePartRejection } from "./workflow-errors.js";

const LONG_RUNNING_UP_TIMEOUT_MS = 120_000;

/** OPR.0.3.4.2 — default interactive [y/N] prompt for the awaiting-decision
 *  ASK (TTY only; tests inject promptYesNo instead). Default answer: No. */
async function defaultPromptYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// OPR.0.3.2.22 Bug 3 helper — mirrors cwd-resolution.isPathInsideRoot in
// the daemon so the CLI can decide whether a path-form sourceRef lives
// inside the daemon install root without importing the daemon package.
function isPathInsideRoot(candidate: string, root: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(root), nodePath.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative));
}

// #226 — mirrors cwd-resolution.isFilesystemRoot in the daemon.
function isFilesystemRoot(cwd: string): boolean {
  const resolved = nodePath.resolve(cwd);
  return resolved === nodePath.parse(resolved).root;
}

/** The mistakes the daemon would refuse in an env: block, caught before anything is sent. */
function checkEnvAssignment(assignment: string): string | null {
  const eq = assignment.indexOf("=");
  if (eq <= 0) return `expects KEY=VALUE, got "${assignment}"`;
  const name = assignment.slice(0, eq);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return `"${name}" is not a valid name; names match ^[A-Z_][A-Z0-9_]*$`;
  if (name.startsWith("SOFTWARETEAM_")) return `"${name}" is reserved; SOFTWARETEAM_* names belong to SoftwareTeam`;
  const value = assignment.slice(eq + 1);
  if (value === "") return `${name}: value must not be empty`;
  if (value.includes("\0")) return `${name}: value must not contain a NUL byte`;
  return null;
}

// OPR.0.4.4.11 (arch return R11-2) — pre-dispatch detection of a topology
// source for the --host rejection. Mirrors the daemon's FR-1 detection
// contract without importing the daemon package: `.softwareteamtopology` extension,
// or a readable path-form YAML document with a top-level `softwareTeams:` LIST.
export function sourceLooksLikeTopology(source: string): boolean {
  if (/\.softwareteamtopology$/i.test(source)) return true;
  // Name-form sources (no slash, no known extension) keep software-team-name
  // semantics — never sniffed (same precedence as the daemon router).
  if (!source.includes("/") && !source.match(/\.(ya?ml)$/i)) return false;
  try {
    const p = nodePath.resolve(source);
    if (!existsSync(p)) return false;
    const parsed: unknown = parseYamlDoc(readFileSync(p, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Array.isArray((parsed as Record<string, unknown>)["softwareTeams"]);
  } catch {
    return false; // unreadable/unparseable — existing flows own the error
  }
}

export const HOST_TOPOLOGY_REJECTION =
  "SoftwareTeam up --host cannot take a topology source: per-entry 'host:' in the manifest is the ONLY placement mechanism for topologies (two placement mechanisms must not coexist). Put 'host: <id>' on the entries you want placed remotely and run 'SoftwareTeam up <topology>' without --host.";

export function upCommand(
  depsOverride?: StatusDeps & {
    lifecycleDeps?: LifecycleDeps;
    preflightExec?: (cmd: string) => Promise<string>;
    /** OPR.0.3.4.2 — injectable [y/N] prompt for the awaiting-decision ASK
     *  (tests drive it; default = readline on stdin, offered on TTY only). */
    promptYesNo?: (question: string) => Promise<boolean>;
  },
): Command {
  const cmd = new Command("up")
    .description("Launch a SoftwareTeam or managed app from a spec, library entry, or bundle")
    .addHelpText("after", `
Examples:
  SoftwareTeam up secrets-manager
  SoftwareTeam up ./software-team.yaml
  SoftwareTeam up ./demo.softwareteambundle --target ~/work

An existing softwareTeam's name restores that SoftwareTeam from its automatically selected usable
snapshot, resuming seats where their harness allows; it refuses while any of its seats is live. A spec
whose SoftwareTeam name already exists starts a new team in place of the stopped one, which
is archived, and refuses if the old one may still be running. To bring a stopped
team back with its conversations, run SoftwareTeam up <software-team-name> --existing, not the spec.
`);
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<source>", "GitHub bundle link, path to a .yaml SoftwareTeam spec or .softwareteambundle, or a library name such as secrets-manager")
    .option("--non-interruptive", "Accept harness first-launch warnings for this SoftwareTeam at full bypass; saved for later launches")
    .option("--no-non-interruptive", "Turn off this softwareTeam's saved warning-acceptance choice (stop an existing SoftwareTeam with SoftwareTeam down first)")
    .option("--plan", "Plan mode — preview without executing")
    .option("--yes", "Auto-approve trusted actions")
    .option("--cwd <path>", "Override launch working directory for all members for this run only")
    .option("--env <KEY=VALUE>", "Set a launch environment variable on every seat for this run only; repeatable. Not saved: a later restore uses the spec's env: block. Values are visible to local processes, so never pass secrets", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--target <root>", "Install target for a .softwareteambundle (default: current directory). A v2 bundle is materialized there and relative member cwds resolve against it; --cwd still overrides launch cwd")
    .option("--preset <name>", "For a GitHub bundle link, choose a declared configuration")
    .option("--seat <member=runtime>", "For a GitHub bundle link, choose a declared seat runtime; repeatable", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--existing", "Treat <source> as an existing SoftwareTeam name; bypass library-spec name resolution")
    .option("--fresh <seats...>", "Deliberately fresh-prime the named seats (logical ids) instead of resuming their original sessions (operation B; reported as fresh-primed)")
    .option("--json", "JSON output for agents")
    .option("--host <id>", "Run on a remote host declared in ~/.softwareteam/hosts.yaml")
    .action(async (source: string, opts: { nonInterruptive?: boolean; plan?: boolean; yes?: boolean; cwd?: string; env?: string[]; target?: string; existing?: boolean; fresh?: string[]; json?: boolean; host?: string; preset?: string; seat?: string[] }) => {
      // OPR.0.4.6.MH1 FR-2: selected-host routing — explicit --host wins;
      // else the persisted selection feeds the SHIPPED --host path; no
      // selection = today exactly. Topology
      // sources are EXEMPT: per-entry host: is the only topology placement
      // (shipped R11-2); implicit selection must not turn a flagless
      // topology up into the rejected --host form.
      if (!sourceLooksLikeTopology(source)) opts.host = resolveEffectiveHost(opts.host);
      const deps = getDepsF();
      const envOverride: Record<string, string> = {};
      for (const assignment of opts.env ?? []) {
        const problem = checkEnvAssignment(assignment);
        if (problem) {
          console.error(`--env ${problem}`);
          process.exitCode = 1;
          return;
        }
        const eq = assignment.indexOf("=");
        envOverride[assignment.slice(0, eq)] = assignment.slice(eq + 1);
      }
      const envOverrideBody = Object.keys(envOverride).length > 0 ? envOverride : undefined;
      if (envOverrideBody && sourceLooksLikeTopology(source)) {
        console.error("--env applies to a new launch from one SoftwareTeam spec or bundle. A topology launches several softwareTeams from their own specs; put env: in each softwareTeam's spec instead.");
        process.exitCode = 1;
        return;
      }

      // Link preparation verifies the effective endpoint before fetch or local auto-start.
      // Existing path/name dispatch below is unchanged.
      if (isGitHubBundleLink(source)) {
        try {
          const imported = await importGitHubBundle(source, deps, opts);
          if (imported.res.status >= 400) {
            if (opts.json) console.log(JSON.stringify(imported.res.data)); else console.error(imported.res.data.error ?? "Create failed");
            process.exitCode = 2; return;
          }
          const behaviour = await showBundleBehaviourBeforeAction(() => imported.client.post<Record<string, unknown>>(
            "/api/bundles/inspect", { bundlePath: imported.bundlePath },
          ));
          let installed: { status: number; data: Record<string, unknown> };
          try {
            installed = await imported.client.post<Record<string, unknown>>("/api/bundles/install", {
              bundlePath: imported.bundlePath, plan: opts.plan ?? false, autoApprove: opts.yes ?? false, nonInterruptive: opts.nonInterruptive,
              targetRoot: opts.target ? nodePath.resolve(opts.target) : process.cwd(),
              cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : undefined,
              envOverride: envOverrideBody,
              cliVersion: getCliVersion(),
            }, { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS });
          } catch {
            throw new Error(`Bundle install outcome is unknown. Archive retained at ${imported.bundlePath}; check SoftwareTeam ps and SoftwareTeam bundle history before retrying.`);
          }
          const { source: builtSource, configurationId, packageDigest, archiveHash, assembler } = imported.res.data;
          const data = { ...installed.data, source: builtSource, configurationId, packageDigest, archiveHash, assembler, ...(behaviour ? { behaviour } : {}) };
          if (opts.json) console.log(JSON.stringify(data));
          else {
            for (const line of bundleIdentityLines(data)) console.log(line);
            console.log(`Status: ${installed.data.status ?? (installed.status >= 400 ? "not attempted" : "unknown")}`);
            for (const line of startupAttentionSummary(installed.data)) console.log(line);
            if (installed.data.softwareTeamId) console.log(`SoftwareTeam: ${installed.data.softwareTeamId}`);
            for (const line of bundleRoutingSummary(installed.data)) console.log(line);
            for (const warning of (installed.data.warnings as string[] | undefined) ?? []) console.warn(warning);
            if (installed.status >= 400) console.error(bundleInstallError(installed.data, false));
          }
          if (installed.status >= 400 || ["failed", "partial", "partially_restored", "not_attempted"].includes(String(installed.data.status ?? installed.data.softwareTeamResult))) process.exitCode = installed.status === 409 ? 1 : 2;
        } catch (err) { printBundleLinkError(err, opts.json); }
        return;
      }

      if (opts.host) {
        // OPR.0.4.4.11 R11-2: --host + topology source is REJECTED before
        // any dispatch — per-entry 'host:' is the only topology placement
        // mechanism. The daemon route carries the same rejection on its
        // public write path (double-sided enforcement, arch ruling 4).
        if (sourceLooksLikeTopology(source)) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: HOST_TOPOLOGY_REJECTION, code: "host_flag_topology" }));
          } else {
            console.error(HOST_TOPOLOGY_REJECTION);
          }
          process.exitCode = 1;
          return;
        }
        // The remote daemon restores a bare softwareTeam name from its own spec, so there is no launch for --env.
        if (envOverrideBody && !source.includes("/") && !/\.(ya?ml|softwareteambundle|softwareteamtopology)$/i.test(source)) {
          console.error("--env applies to a new launch from a SoftwareTeam spec or bundle. A restore keeps the softwareTeam's own env: block; to change it, edit env: in the spec and launch again.");
          process.exitCode = 1;
          return;
        }
        const { runRemoteHttpOp } = await import("../remote-host-ops.js");
        const body = {
          sourceRef: source,
          plan: opts.plan,
          autoApprove: opts.yes, nonInterruptive: opts.nonInterruptive,
          cwdOverride: opts.cwd,
          envOverride: envOverrideBody,
          targetRoot: opts.target,
          existing: opts.existing,
          freshLogicalIds: opts.fresh,
        };
        const behaviour = /\.softwareteambundle$/i.test(source) && !opts.existing
          ? await showBundleBehaviourBeforeAction(async () => {
            const inspected = await runRemoteHttpOp(opts.host!, "POST", "/api/bundles/inspect", { bundlePath: source }, deps, opts);
            return { status: inspected.ok ? 200 : 500, data: (inspected.data ?? { error: inspected.error }) as Record<string, unknown> };
          }) : undefined;
        const result = await runRemoteHttpOp(opts.host, "POST", "/api/up", body, deps, { ...opts, timeoutMs: opts.plan ? undefined : LONG_RUNNING_UP_TIMEOUT_MS });
        if (behaviour) result.data = { ...(result.data as Record<string, unknown> | undefined), behaviour };
        if (opts.json) {
          console.log(JSON.stringify(result));
          if (!result.ok) process.exitCode = 1;
        } else if (result.ok) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          for (const line of formatRemoteUpFailure(opts.host, result)) console.error(line);
          process.exitCode = 1;
        }
        return;
      }

      // Run preflight before auto-start
      let status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running") {
        let startOptions: StartOptions;
        try {
          const prepared = await prepareDaemonAutoStart(deps.lifecycleDeps, depsOverride?.preflightExec);
          startOptions = prepared.options;
          const preflightResult = prepared.preflight;
          if (!preflightResult.ready) {
            for (const check of preflightResult.checks.filter((c) => !c.ok)) {
              console.error(`✗ ${check.name}: ${check.error}`);
              if (check.reason) console.error(`  Why: ${check.reason}`);
              if (check.fix) console.error(`  Fix: ${check.fix}`);
            }
            process.exitCode = 1;
            return;
          }
        } catch (preErr) {
          console.error(`Preflight error: ${preErr instanceof Error ? preErr.message : String(preErr)}`);
          process.exitCode = 1;
          return;
        }

        try {
          await startDaemon(startOptions, deps.lifecycleDeps);
          status = await getDaemonStatus(deps.lifecycleDeps);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 2;
          return;
        }
      }

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // Detect softwareTeam name vs file path: names don't contain / and don't end in
      // .yaml/.yml/.softwareteambundle/.softwareteamtopology. OPR.0.4.4.11 (guard G-1): the
      // topology extension resolves as a PATH (same as yaml/softwareteambundle) so a
      // bare `factory.softwareteamtopology` reaches the daemon's topology routing
      // instead of library/existing-softwareTeam name resolution. Extensionless
      // no-slash sources keep software_team_name precedence byte-for-byte.
      const isSoftwareTeamName = !source.includes("/") && !source.match(/\.(ya?ml|softwareteambundle|softwareteamtopology)$/i);
      let sourceRef = isSoftwareTeamName ? source : nodePath.resolve(source);

      // If it looks like a name, check for library spec match
      let defaultLibraryCwdOverride: string | undefined;
      // Cache softwareTeam summaries so we can both detect ambiguity AND derive lifecycleState
      // for "Recovering ..." vs "Turning on ..." wording (post-L2).
      let softwareTeamSummariesCache: Array<{ id: string; name: string; lifecycleState?: string }> | null = null;
      const fetchSoftwareTeamSummaries = async () => {
        if (softwareTeamSummariesCache !== null) return softwareTeamSummariesCache;
        try {
          const res = await client.get<Array<{ id: string; name: string; lifecycleState?: string }>>("/api/software-teams/summary");
          softwareTeamSummariesCache = res.data ?? [];
        } catch {
          softwareTeamSummariesCache = [];
        }
        return softwareTeamSummariesCache;
      };
      // OPR.0.3.3.19 (AC-7): archived softwareTeams are excluded from default `SoftwareTeam up`
      // name resolution. If <source> matches ONLY an archived softwareTeam (no active
      // softwareTeam of that name), refuse with an honest error pointing at
      // `softwareTeam unarchive` - never silently restore an archived softwareTeam, never
      // silently fall through. Applies to both default and --existing paths.
      const refuseArchivedName = async (name: string): Promise<boolean> => {
        const activeSummaries = await fetchSoftwareTeamSummaries();
        const activeMatch = activeSummaries.some((r) => r.name === name);
        if (!activeMatch) {
          try {
            const archRes = await client.get<Array<{ id: string; name: string }>>(
              "/api/software-teams/summary?archived=only",
            );
            const archivedMatches = (archRes.data ?? []).filter((r) => r.name === name);
            if (archivedMatches.length > 0) {
              // `softwareTeam unarchive` resolves by softwareTeam ID, not name (it posts to
              // /api/software-teams/<softwareTeamId>/unarchive), so the remediation MUST name the
              // id - telling the operator `softwareTeam unarchive <name>` would 404. If
              // the name is ambiguous across multiple archived softwareTeams, surface the
              // id list rather than guessing a single target.
              const ids = archivedMatches.map((r) => r.id);
              if (opts.json) {
                console.log(JSON.stringify({
                  error: "software_team_archived",
                  softwareTeam: name,
                  archivedSoftwareTeamIds: ids,
                  action: ids.length === 1
                    ? `SoftwareTeam unarchive ${ids[0]}`
                    : `SoftwareTeam unarchive <softwareTeamId> (archived softwareTeams named '${name}': ${ids.join(", ")})`,
                }));
              } else if (ids.length === 1) {
                console.error(`SoftwareTeam "${name}" is archived, so it is hidden from 'SoftwareTeam up' name resolution.`);
                console.error(`  Bring it back first: SoftwareTeam unarchive ${ids[0]}`);
                console.error(`  Then power it on:    SoftwareTeam up ${name}`);
              } else {
                console.error(`${ids.length} archived softwareTeams are named "${name}"; they are hidden from 'SoftwareTeam up' name resolution.`);
                console.error(`  Unarchive the one you want by id (then 'SoftwareTeam up'):`);
                for (const id of ids) console.error(`    SoftwareTeam unarchive ${id}`);
              }
              process.exitCode = 1;
              return true;
            }
          } catch {
            // Archived-summary probe failed (e.g. older daemon) - fall through
            // to normal resolution; there are no archive semantics to enforce.
          }
        }
        return false;
      };
      // A restore brings the softwareTeam back from its own spec, so there is no launch to apply --env to.
      const refuseEnvOnRestore = (): boolean => {
        if (!envOverrideBody) return false;
        console.error("--env applies to a new launch from a SoftwareTeam spec or bundle. A restore keeps the softwareTeam's own env: block; to change it, edit env: in the spec and launch again.");
        process.exitCode = 1;
        return true;
      };
      if (isSoftwareTeamName && await refuseArchivedName(source)) return;
      if (isSoftwareTeamName && !opts.existing) {
        try {
          const { resolveLibrarySpec } = await import("./specs.js");
          const entry = await resolveLibrarySpec(client, source, { kind: "softwareTeam" });
          // Library match found — check for existing-softwareTeam collision
          // Use /api/software-teams/summary which mirrors findSoftwareTeamsByName (includes stopped softwareTeams)
          const softwareTeamSummaries = await fetchSoftwareTeamSummaries();
          // An alias must not bypass the canonical name's existing/archive checks.
          const resolvedName = source === "first-project" && entry.name === "starter" && entry.sourceType === "builtin"
            ? entry.name : source;
          if (resolvedName !== source && await refuseArchivedName(resolvedName)) return;
          const softwareTeamMatches = softwareTeamSummaries.filter((r) => r.name === source || r.name === resolvedName);
          if (softwareTeamMatches.length > 0) {
            console.error(`'${source}' is ambiguous — it matches both an existing SoftwareTeam restore target and a library spec.`);
            console.error(`  To launch the library spec: SoftwareTeam up ${entry.sourcePath}`);
            console.error(`  The software-team-name match refers to a stopped softwareTeam / snapshot-backed restore path.`);
            console.error(`  To recover the existing SoftwareTeam instead of importing a starter: SoftwareTeam up ${softwareTeamMatches[0]!.name} --existing`);
            process.exitCode = 1;
            return;
          }
          sourceRef = entry.sourcePath;
          if (!opts.cwd && entry.kind === "softwareTeam" && entry.sourceType === "builtin") {
            defaultLibraryCwdOverride = process.cwd();
          }
        } catch (resolveErr) {
          // Ambiguity within library — surface it
          if ((resolveErr as Error).message?.includes("ambiguous")) {
            console.error((resolveErr as Error).message);
            process.exitCode = 1;
            return;
          }
          // Not found or other error — proceed with existing software-team-name behavior
        }

        // Wording divergence (post-L2): if sourceRef stayed as the softwareTeam name we are
        // routing through the existing-SoftwareTeam restore path. Print "Recovering ..." or
        // "Turning on ..." per the softwareTeam's derived lifecycleState. Help text honesty:
        // "Recover" describes what `SoftwareTeam up` does; it does not promise success before
        // tester L4 VM proof completes.
        if (sourceRef === source && refuseEnvOnRestore()) return;
        if (sourceRef === source && !opts.json) {
          const summaries = await fetchSoftwareTeamSummaries();
          const match = summaries.find((r) => r.name === source);
          if (match?.lifecycleState === "recoverable") {
            console.log(`Recovering softwareTeam "${source}" from latest snapshot or current DB state...`);
          } else if (match?.lifecycleState === "stopped") {
            console.log(`Turning on softwareTeam "${source}"...`);
          }
        }
      } else if (isSoftwareTeamName && opts.existing && refuseEnvOnRestore()) {
        return;
      } else if (isSoftwareTeamName && opts.existing && !opts.json) {
        const summaries = await fetchSoftwareTeamSummaries();
        const match = summaries.find((r) => r.name === source);
        if (match?.lifecycleState === "recoverable") {
          console.log(`Recovering softwareTeam "${source}" from latest snapshot or current DB state...`);
        } else {
          console.log(`Turning on existing softwareTeam "${source}"...`);
        }
      }

      const isSoftwareTeamBundle = !isSoftwareTeamName && /\.softwareteambundle$/i.test(sourceRef);
      const targetRoot = opts.target ? nodePath.resolve(opts.target) : (isSoftwareTeamBundle ? process.cwd() : undefined);

      // OPR.0.3.2.22 Bug 3 — extend the bare `SoftwareTeam up <builtin>` default-cwd
      // treatment to path-form. Builtin starter specs declare member-level
      // cwd: "." which resolves to the spec directory (inside the daemon's
      // install root). Without --cwd that trips getSoftwareTeamInstallCwdError
      // at preflight. Bare-name form is already rescued at the
      // resolveLibrarySpec branch above (entry.sourceType === "builtin");
      // path-form `SoftwareTeam up <install-internal-spec>` is the remaining gap.
      //
      // Detection: source is path-form (not isSoftwareTeamName, not isSoftwareTeamBundle),
      // no --cwd was given, no defaultLibraryCwdOverride was set by the
      // bare-name branch above, AND the resolved path lives inside the
      // daemon's install root (fetched via /api/info). When all hold,
      // default cwdOverride to process.cwd() so the operator's project
      // dir is used as launch cwd, and print a one-line notice. If
      // /api/info is unavailable, fall through silently — the daemon
      // preflight will still surface the install-cwd error.
      //
      // Structural redesign of how builtin starter specs declare cwd is
      // out of scope (deferred to 0.3.3 per the slice triage).
      if (!opts.cwd && !isSoftwareTeamName && !isSoftwareTeamBundle && defaultLibraryCwdOverride === undefined) {
        try {
          // Short timeout: a healthy daemon answers /api/info in <100ms; if
          // it doesn't, fall through to the daemon's own preflight error
          // rather than adding a multi-second stall to every SoftwareTeam up.
          const infoRes = await client.get<{ installRoot?: string }>("/api/info", { timeoutMs: 2000 });
          const installRoot = infoRes.data?.installRoot;
          if (installRoot && isPathInsideRoot(sourceRef, installRoot)) {
            defaultLibraryCwdOverride = process.cwd();
            if (!opts.json) {
              console.log("Defaulting cwd to current directory because the spec lives inside the SoftwareTeam install.");
            }
          }
        } catch {
          // /api/info unavailable — fall through. The daemon preflight
          // returns getSoftwareTeamInstallCwdError if this is in fact the
          // install-internal case; the operator gets the same hint they
          // would have gotten pre-Bug-3.
        }
      }

      // #226 — the launch continues, but a cwd this command chose (not an explicit --cwd) that is the
      // filesystem root puts every agent's project files there, which is rarely what the person meant.
      if (defaultLibraryCwdOverride !== undefined && isFilesystemRoot(defaultLibraryCwdOverride)) {
        console.error(`warning: launching in ${defaultLibraryCwdOverride} because it is your current directory. Agents write their project files (.claude/, .mcp.json and similar) in their working directory, and some may fail if it isn't writable. To launch in your project, run SoftwareTeam up again from it or pass --cwd <project dir>.`);
      }

      // OPR.0.3.4.4 — honest async: a client timeout / connection loss in
      // APPLY mode does NOT mean the operation failed; the daemon may still
      // be processing. Report in-progress/unknown with a verify command,
      // never a bare connection failure (the false-failure that caused the
      // outage's wrong next move). No operation id is surfaced client-side
      // on timeout today, so the honest message is the MVP floor.
      const printHonestTimeout = (err: DaemonConnectionError): void => {
        console.error(`The CLI timed out waiting for the daemon, but the operation may STILL BE IN PROGRESS.`);
        console.error(`This does not mean the operation failed; the daemon may still be processing it.`);
        console.error(`Verify the actual state with: SoftwareTeam ps`);
        console.error(`(underlying: ${err.message})`);
        process.exitCode = 1;
      };

      const behaviour = isSoftwareTeamBundle ? await showBundleBehaviourBeforeAction(() => client.post<Record<string, unknown>>(
        "/api/bundles/inspect", { bundlePath: sourceRef },
      )) : undefined;
      let res: { status: number; data: Record<string, unknown> };
      try {
        res = await client.post<Record<string, unknown>>("/api/up", {
          sourceRef,
          plan: opts.plan ?? false,
          autoApprove: opts.yes ?? false, nonInterruptive: opts.nonInterruptive,
          cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : defaultLibraryCwdOverride,
          envOverride: envOverrideBody,
          targetRoot,
          // OPR.0.3.4.2 — operation B opt-in seats (deliberate fresh-prime).
          freshLogicalIds: opts.fresh,
        }, opts.plan ? undefined : { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS });
      } catch (err) {
        if (err instanceof DaemonConnectionError && !opts.plan) {
          printHonestTimeout(err);
          return;
        }
        throw err;
      }

      if (behaviour) res.data = { ...res.data, behaviour };

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status === 409 ? 1 : 2;
        const softwareTeamResult = res.data["softwareTeamResult"] as string | undefined;
        if (softwareTeamResult === "partially_restored" || softwareTeamResult === "failed" || softwareTeamResult === "not_attempted") process.exitCode = 1;
        return;
      }

      // OPR.0.4.4.11 — topology aggregate rendering (full success OR honest
      // partial; the daemon returns the same closed {softwareTeamRef, host, status,
      // error?} entries either way, skipped entries explicitly present).
      const topoEntries = res.data["entries"] as Array<{ softwareTeamRef: string; host: string; status: string; error?: string }> | undefined;
      if (typeof res.data["topology"] === "string" && Array.isArray(topoEntries)) {
        const topoOk = res.data["ok"] === true;
        console.log(
          topoOk
            ? `Topology up: all ${topoEntries.length} softwareTeams launched.`
            : "Topology up FAILED — honest partial state (started softwareTeams stay up; no rollback):",
        );
        for (const e of topoEntries) {
          const tag = e.status === "ok" ? " ok " : e.status === "failed" ? "FAIL" : "skip";
          console.log(`  [${tag}] ${e.softwareTeamRef} @ ${e.host}${e.error ? ` — ${e.error}` : ""}`);
        }
        if (!topoOk) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const code = res.data["code"] as string | undefined;
        const error = res.data["error"] as Partial<ThreePartRejection> | null | undefined;
        if (error && typeof error === "object" && typeof error.fact === "string"
          && typeof error.consequence === "string" && typeof error.action === "string") {
          for (const line of formatThreePart(error as ThreePartRejection)) console.error(line);
          const nodes = res.data["attentionNodes"] as Array<{ logicalId: string; sessionName?: string; reason: string }> | undefined;
          for (const node of nodes ?? []) {
            console.error(`  ${node.logicalId}${node.sessionName ? ` (${node.sessionName})` : ""}: ${node.reason}`);
          }
        } else if (code === "cycle_error") {
          console.error("Cycle detected in SoftwareTeam topology. Check edge definitions for circular dependencies.");
        } else if (code === "validation_failed") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`SoftwareTeam spec validation failed:\n${errors.map((e) => `  ${e}`).join("\n")}\nFix: update your SoftwareTeam spec and retry.`);
        } else if (code === "preflight_failed") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`Preflight check failed:\n${errors.map((e) => `  ${e}`).join("\n")}\nFix: resolve the issues above and retry.`);
        } else if (code === "pre_restore_validation_failed") {
          printRestoreNotAttempted(res.data as RestoreNotAttemptedData);
        } else if (code === "invalid_topology_manifest") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`Topology manifest invalid:\n${errors.map((e) => `  ${e}`).join("\n")}\nFix: the manifest key set is CLOSED — softwareTeams[]{source, host?} plus optional concurrency.`);
        } else if (code === "software_team_name_running" || code === "generation_unconfirmed" || code === "compose_project_conflict") {
          // S5b final-fix F1 (OPR.0.5.4.11): the guard's teaching refusal is
          // self-describing (running softwareTeam identity, what was checked,
          // nothing-created, alternatives) — render it verbatim, never the
          // generic unknown-error/validate-your-spec fallback. #141's
          // generation_unconfirmed refusal is self-describing the same way.
          const teaching = bundleInstallError(res.data, false);
          console.error(teaching);
        } else {
          const errorText = bundleInstallError(res.data, false);
          console.error(`Up failed: ${errorText} (HTTP ${res.status}). Check daemon logs or validate your spec with: SoftwareTeam spec validate <path>`);
          if (/agent_ref resolution failed|No agent\.yaml found/i.test(errorText)) {
            console.error("Hint: local: agent_ref paths resolve relative to the SoftwareTeam spec directory, not your shell cwd.");
            console.error("      Keep the agents/ tree beside the softwareTeam YAML, or switch those refs to path:/absolute/path.");
          }
        }
        // File disposition and generation recovery matter on every failure,
        // including validation and preflight refusals after materialization.
        for (const warning of (res.data["warnings"] as string[]) ?? []) console.error(`  warning: ${warning}`);
        const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
        for (const s of stages) {
          console.log(`  ${s.stage}: ${s.status}`);
        }
        process.exitCode = res.status === 409 ? 1 : 2;
        return;
      }

      // Success output
      const resStatus = res.data["status"] as string;

      // OPR.0.3.4.4 — read-only restore plan preview (`--plan` on the
      // existing-softwareTeam path). Renders intended per-seat actions; nothing ran.
      if (resStatus === "plan" && res.data["mode"] === "restore") {
        const planSoftwareTeamName = res.data["softwareTeamName"] as string | undefined;
        const planSnapshot = res.data["snapshot"] as { id: string; kind: string; createdAt: string } | null;
        console.log(`Plan: restore softwareTeam "${planSoftwareTeamName ?? source}" (read-only preview)`);
        if (planSnapshot) {
          console.log(`Snapshot: ${planSnapshot.id} (kind=${planSnapshot.kind}, captured ${planSnapshot.createdAt})`);
        } else if (res.data["wouldCaptureCurrentState"] === true) {
          console.log(`Snapshot: none usable — apply would first capture current DB state as an auto-rehydrate snapshot.`);
        }
        const planNodes = (res.data["nodes"] as Array<{ logicalId: string; intendedAction: string; reason?: string; tokenState?: string; provenance?: string | null; lastVerified?: string | null; freshRequired?: boolean; runtimePrompt?: string }>) ?? [];
        for (const n of planNodes) {
          console.log(`  ${n.logicalId}: ${n.intendedAction}${n.reason ? ` — ${n.reason}` : ""}`);
          // OPR.0.4.3.20 FR-6 — per-seat token truth: present/missing/stale/unverified
          // + provenance + freshness + expected runtime prompt + explicit --fresh.
          if (n.tokenState) {
            const reverify = (n.tokenState === "stale" || n.tokenState === "unverified") ? " — re-verify" : "";
            const prov = n.provenance ? ` (${n.provenance})` : "";
            const verified = n.lastVerified ? `, verified ${n.lastVerified}` : "";
            const fresh = n.freshRequired ? "; --fresh required" : "";
            const prompt = n.runtimePrompt ? `; ${n.runtimePrompt}` : "";
            console.log(`      token: ${n.tokenState}${reverify}${prov}${verified}${fresh}${prompt}`);
          }
        }
        console.log("No changes made.");
        return;
      }

      if (resStatus === "restored") {
        // Existing-softwareTeam power-on handoff
        const softwareTeamId = res.data["softwareTeamId"] as string;
        const softwareTeamName = res.data["softwareTeamName"] as string | undefined;
        const softwareTeamResult = res.data["softwareTeamResult"] as string | undefined;
        const snapshotKind = res.data["snapshotKind"] as string | undefined;
        // L3b: when the daemon falls back to a non-auto-pre-down snapshot, surface
        // the kind so operators see the manual fallback explicitly. The note is
        // printed BEFORE the "SoftwareTeam restored" line so it's visible in the typical
        // top-of-output scan.
        if (snapshotKind && snapshotKind !== "auto-pre-down") {
          console.log(`Restoring from manual snapshot (kind=${snapshotKind}); no auto-pre-down snapshot available.`);
        }
        console.log(`SoftwareTeam "${softwareTeamName ?? softwareTeamId}" restored (ID: ${softwareTeamId})`);
        if (softwareTeamResult) console.log(`Result: ${softwareTeamResult}`);
        const nodes = (res.data["nodes"] as Array<{ logicalId: string; status: string; error?: string }>) ?? [];
        for (const n of nodes) {
          // OPR.0.3.4.2 — the five-term vocabulary renders distinctly; the
          // awaiting-decision reason is part of the line (not a dead end).
          if (n.status === "awaiting-decision" && n.error) {
            console.log(`  ${n.logicalId}: awaiting-decision — ${n.error}`);
          } else {
            console.log(`  ${n.logicalId}: ${n.status}`);
          }
        }
        const warnings = (res.data["warnings"] as string[]) ?? [];
        for (const w of warnings) {
          console.error(`  warning: ${w}`);
        }
        // Attach command from server response (uses real canonical session name)
        const attachCommand = res.data["attachCommand"] as string | undefined;
        if (attachCommand) {
          console.log(`Attach: ${attachCommand}`);
        }

        // OPR.0.3.4.2 — the actionable ASK/offer for awaiting-decision seats.
        // TTY: interactive [y/N] per seat; accepted seats re-run as a
        // deliberate fresh-prime (operation B). Headless: the machine status
        // stays awaiting-decision with the explicit --fresh hint. NEVER an
        // auto-substitution.
        const awaiting = nodes.filter((n) => n.status === "awaiting-decision");
        if (awaiting.length > 0) {
          const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) || Boolean(deps.promptYesNo);
          if (interactive) {
            const ask = deps.promptYesNo ?? defaultPromptYesNo;
            const accepted: string[] = [];
            for (const n of awaiting) {
              const reason = n.error ?? "original session unresumable";
              const yes = await ask(`Couldn't resume original session for ${n.logicalId} (reason: ${reason}). Start a fresh primed session instead? [y/N] `);
              if (yes) accepted.push(n.logicalId);
            }
            if (accepted.length > 0) {
              let freshRes: { status: number; data: Record<string, unknown> };
              try {
                freshRes = await client.post<Record<string, unknown>>("/api/up", {
                  sourceRef,
                  plan: false,
                  autoApprove: opts.yes ?? false, nonInterruptive: opts.nonInterruptive,
                  cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : defaultLibraryCwdOverride,
                  envOverride: envOverrideBody,
                  targetRoot,
                  freshLogicalIds: accepted,
                }, { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS });
              } catch (err) {
                if (err instanceof DaemonConnectionError) {
                  printHonestTimeout(err);
                  return;
                }
                throw err;
              }
              const freshNodes = (freshRes.data["nodes"] as Array<{ logicalId: string; status: string }>) ?? [];
              for (const n of freshNodes.filter((fn) => accepted.includes(fn.logicalId))) {
                console.log(`  ${n.logicalId}: ${n.status}`);
              }
            } else {
              console.log(`  No fresh sessions started. Re-run with --fresh <seat...> when you decide.`);
            }
          } else {
            for (const n of awaiting) {
              console.error(`  ${n.logicalId}: awaiting-decision — no session started. To deliberately fresh-prime: SoftwareTeam up --existing ${source} --fresh ${n.logicalId}`);
            }
          }
        }

        if (softwareTeamResult === "partially_restored" || softwareTeamResult === "failed" || softwareTeamResult === "not_attempted" || nodes.some((n) => n.status === "failed" || n.status === "awaiting-decision")) {
          process.exitCode = 1;
        }
      } else {
        // Fresh boot handoff
        const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
        for (const s of stages) {
          console.log(`  ${s.stage}: ${s.status}`);
        }

        const softwareTeamId = res.data["softwareTeamId"] as string | undefined;
        if (softwareTeamId) {
          console.log(`\nSoftwareTeam: ${softwareTeamId}`);
          // Dashboard — use softwareTeam ui open (knows the real UI URL)
          console.log(`Dashboard: SoftwareTeam ui open`);
        }
        console.log(`Status: ${resStatus}`);
        for (const line of startupAttentionSummary(res.data)) console.log(line);

        // Surface warnings (e.g. transcript attach failures)
        const warnings = (res.data["warnings"] as string[]) ?? [];
        for (const w of warnings) {
          console.error(`  warning: ${w}`);
        }

        // Attach command from server response
        const attachCommand = res.data["attachCommand"] as string | undefined;
        if (attachCommand) {
          console.log(`Attach: ${attachCommand}`);
        }

        if (resStatus === "partial") process.exitCode = 1;
      }
    });

  return cmd;
}

/** Render a failed remote `SoftwareTeam up` response without stringifying an unknown
 *  body as `[object Object]`. JSON mode keeps the complete RemoteOpResult;
 *  human mode shows known daemon guidance and safely falls back for older or
 *  partial error bodies. */
export function formatRemoteUpFailure(
  hostId: string,
  result: { error?: string; data?: unknown },
): string[] {
  const lines = [`Error on host ${hostId}${result.error ? `: ${result.error}` : ""}`];
  const payload = result.data !== null && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : undefined;
  const error = payload?.["error"];
  let detailAdded = false;

  if (typeof error === "string" && error.trim()) {
    lines.push(error.trim());
    detailAdded = true;
  } else if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const body = error as Record<string, unknown>;
    const fact = typeof body["fact"] === "string" ? body["fact"] : undefined;
    const consequence = typeof body["consequence"] === "string" ? body["consequence"] : undefined;
    const action = typeof body["action"] === "string" ? body["action"] : undefined;
    const message = typeof body["message"] === "string" ? body["message"].trim() : undefined;
    if (fact && consequence && action) {
      lines.push(...formatThreePart({ fact, consequence, action }));
      detailAdded = true;
    } else {
      if (fact) lines.push(`Error: ${fact}`);
      if (consequence) lines.push(consequence);
      if (action) lines.push(action);
      if (message) lines.push(message);
      detailAdded = Boolean(fact || consequence || action || message);
    }
  }

  if (!detailAdded && typeof payload?.["message"] === "string" && payload["message"].trim()) {
    lines.push(payload["message"].trim());
    detailAdded = true;
  }
  if (!detailAdded && Array.isArray(payload?.["errors"])) {
    const errors = payload["errors"].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (errors.length > 0) {
      lines.push(...errors.map((entry) => `  ${entry.trim()}`));
      detailAdded = true;
    }
  }
  if (typeof payload?.["code"] === "string" && payload["code"].trim()) {
    lines.push(`Code: ${payload["code"].trim()}`);
  }
  for (const node of Array.isArray(payload?.["attentionNodes"]) ? payload["attentionNodes"] : []) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
    const entry = node as Record<string, unknown>;
    if (typeof entry["logicalId"] !== "string" || typeof entry["reason"] !== "string") continue;
    const session = typeof entry["sessionName"] === "string" ? ` (${entry["sessionName"]})` : "";
    lines.push(`  ${entry["logicalId"]}${session}: ${entry["reason"]}`);
    detailAdded = true;
  }
  if (Array.isArray(payload?.["warnings"])) {
    for (const warning of payload["warnings"]) {
      if (typeof warning === "string" && warning.trim()) lines.push(`  warning: ${warning.trim()}`);
    }
  }
  if (!detailAdded && typeof result.data === "string" && result.data.trim()) {
    lines.push(result.data.trim());
    detailAdded = true;
  }
  if (!detailAdded) lines.push("Remote daemon did not return a recognized error message.");
  return lines;
}

interface RestoreBlocker {
  code: string;
  severity?: string;
  logicalId?: string;
  nodeId?: string;
  target?: string;
  path?: string;
  message: string;
  remediation: string;
}

interface RestoreNotAttemptedData {
  error?: string;
  softwareTeamResult?: string;
  blockers?: RestoreBlocker[];
}

function printRestoreNotAttempted(data: RestoreNotAttemptedData): void {
  console.error(`Restore blocked: ${data.error ?? "pre-restore validation failed"}`);
  if (data.softwareTeamResult) {
    console.error(`Result: ${data.softwareTeamResult}`);
  }
  for (const blocker of data.blockers ?? []) {
    const scope = blocker.logicalId ?? blocker.nodeId ?? blocker.target ?? blocker.code;
    console.error(`  ${scope}: ${blocker.message}`);
    if (blocker.path) console.error(`    path: ${blocker.path}`);
    console.error(`    remediation: ${blocker.remediation}`);
  }
}
