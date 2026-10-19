import type Database from "better-sqlite3";
import { SoftwareTeamRepository } from "./software-team-repository.js";
import { makeRunningSessionCounter } from "./running-name-guard.js";
import { shellQuote } from "../adapters/shell-quote.js";
import fs from "node:fs";
import path from "node:path";
import { parsePodBundleManifest } from "./bundle-types.js";

export interface BundleInstallContext {
  offered: { name: string; version: string | null; source: string };
  existing: Array<{ softwareTeamId: string; name: string; state: "running" | "stopped"; source: string | null; version: null }>;
  resolutions: string[];
}

/** Read the same session predicate as the import guard. A stored softwareTeam is not necessarily running. */
export function bundleInstallContext(
  db: Database.Database, softwareTeamName: string, offered: BundleInstallContext["offered"],
): BundleInstallContext {
  const running = makeRunningSessionCounter(db);
  const softwareTeams = new SoftwareTeamRepository(db);
  const unarchived = new Set(softwareTeams.findUnarchivedSoftwareTeamsByName(softwareTeamName).map(softwareTeam => softwareTeam.id));
  const existing = softwareTeams.findSoftwareTeamsByName(softwareTeamName)
    .filter(softwareTeam => unarchived.has(softwareTeam.id) || running(softwareTeam.id) > 0)
    .map(softwareTeam => {
      // History records the source used, not immutable manifest bytes. Never infer
      // an installed version from an archive that may since have been replaced.
      const source = (db.prepare("SELECT source_ref FROM bootstrap_runs WHERE software_team_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(softwareTeam.id) as { source_ref: string } | undefined)?.source_ref ?? null;
      return { softwareTeamId: softwareTeam.id, name: softwareTeam.name, state: running(softwareTeam.id) > 0 ? "running" as const : "stopped" as const, source, version: null };
    });
  const name = shellQuote(softwareTeamName);
  return {
    offered, existing,
    resolutions: existing.length === 0 ? [] : [
      `Use the existing team: SoftwareTeam ps --software-team ${name} --nodes${existing.every(softwareTeam => softwareTeam.state === "stopped") ? `; resume it with SoftwareTeam up --existing ${name}` : "; send work to its existing seats"}.`,
      `${existing.some(softwareTeam => softwareTeam.state === "running") ? `Stop it with SoftwareTeam down ${name}, then retry` : "Retry"} this install to replace the stopped team. The earlier generation is archived; the result gives its SoftwareTeam unarchive command.`,
      "Cancel this install and keep the existing team. --target selects a directory; it does not rename a team.",
    ],
  };
}

// Before 0.6.7 an unnamed bundle was "my-bundle" ("github-bundle" for a link), so a team installed then carries that
// name in its folder; context.existing already requires a team with the offered softwareTeam's name.
const EARLIER_DEFAULT_NAMES = new Set(["my-bundle", "github-bundle"]);

/** Require the recorded folder when available; old generations retain the manifest-only check. */
export function isExistingBundleTarget(context: BundleInstallContext, target: string, db: Database.Database): boolean {
  if (context.existing.length === 0) return false;
  try {
    const repo = new SoftwareTeamRepository(db);
    const recordedRoots = context.existing.flatMap(softwareTeam => {
      const root = repo.getSoftwareTeamInstallRoot(softwareTeam.softwareTeamId);
      return root === null ? [] : [root];
    });
    // An unbound older generation must not weaken a known generation's folder identity.
    if (recordedRoots.length > 0 && !recordedRoots.includes(fs.realpathSync.native(target))) return false;
    const manifest = parsePodBundleManifest(fs.readFileSync(path.join(target, "bundle.yaml"), "utf8")) as Record<string, unknown> | null;
    const name = manifest?.["name"];
    return manifest?.["schema_version"] === 2
      && (name === context.offered.name || (typeof name === "string" && EARLIER_DEFAULT_NAMES.has(name)));
  } catch {
    // Missing or unreadable identity keeps the existing first-install conflict handling.
    return false;
  }
}

export function bundleInstallContextLines(context: BundleInstallContext, includeChoices = true): string[] {
  return [
    ...context.existing.map(softwareTeam => `Installed team "${softwareTeam.name}" (${softwareTeam.softwareTeamId}): ${softwareTeam.state}; source: ${softwareTeam.source ?? "not recorded"}; version: not recorded.`),
    `Offered bundle "${context.offered.name}": version ${context.offered.version ?? "not recorded"}; source: ${context.offered.source}.`,
    ...(includeChoices ? context.resolutions : []),
  ];
}
