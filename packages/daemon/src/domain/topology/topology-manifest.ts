// OPR.0.4.4.11 — the topology manifest: the SHAREABLE artifact (FR-1).
//
// The key set is CLOSED (arch return R11-1 — this IS the thin-manifest
// enforcement): an ordered `softwareTeams[]` of entries {source, host?} plus an
// optional manifest-level `concurrency` cap (default 1 = sequential).
// NOTHING ELSE. Unknown keys reject loudly — silently ignoring one would
// reopen the founder's ratified non-goal by stealth. Cross-softwareTeam
// edge/routing/dependency keys reject with a message NAMING that non-goal
// (thin manifest; inter-softwareTeam routing is deferred topology-Q1). `on_failure`
// was considered and REMOVED for v0 (spec-guard + arch fold): stop-on-failure
// is the only behavior; re-adding it is an explicit pm-lead decision.
//
// Detection contract (PRD FR-1 + guard G-1 folds; the router consumes the
// exported sniffs): `.softwareteamtopology` extension OR a YAML document with a
// top-level `softwareTeams:` LIST. Extension wins when both could apply (arch ruling
// 1 — declared kind binds); a `.softwareteamtopology` file failing validation errors
// AS a topology, never falls through to software-team-spec parsing.
//
// Unknown-host-id validation (the FR-1 fourth structural class) resolves
// against the hosts registry via the shared hosts-registry-reader at the
// launcher's pre-launch validation pass — still before any launch attempt;
// this module is filesystem/registry-free by design.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface TopologySoftwareTeamEntry {
  source: string;
  host?: string;
}

export interface TopologyManifest {
  softwareTeams: TopologySoftwareTeamEntry[];
  /** Normalized: the manifest's cap, or the default 1 (sequential). */
  concurrency: number;
}

export type TopologyManifestResult =
  | { ok: true; manifest: TopologyManifest }
  | { ok: false; errors: string[] };

/** The ratified non-goal family: any key that would smuggle cross-softwareTeam
 *  edges/routing/dependency semantics into the thin manifest. */
const EDGE_ROUTING_KEYS = new Set([
  "edge",
  "edges",
  "route",
  "routes",
  "routing",
  "dependency",
  "dependencies",
  "deps",
  "depends_on",
  "dependsOn",
  "needs",
  "after",
  "links",
  "wires",
  "connections",
]);

const MANIFEST_KEYS = new Set(["softwareTeams", "concurrency"]);
const ENTRY_KEYS = new Set(["source", "host"]);

function edgeRoutingRejection(prefix: string, key: string): string {
  return `${prefix}: '${key}' is a cross-software-team edge/routing/dependency key — REJECTED. The topology manifest is deliberately THIN (founder-ratified non-goal: no cross-software-team edges, no routing semantics; inter-software-team routing is the deferred topology-Q1 decision). Remove the key; the manifest carries only softwareTeams[]{source, host?} + concurrency.`;
}

function unknownKeyRejection(prefix: string, key: string, allowed: string): string {
  if (key === "on_failure") {
    return `${prefix}: 'on_failure' was removed for v0 — stop-on-failure is the only behavior (the walk stops at the first failed entry; already-started softwareTeams are reported honestly). Re-adding the key is an explicit pm-lead decision. Remove it.`;
  }
  return `${prefix}: unknown key '${key}' — the manifest key set is CLOSED (${allowed}). Remove or fix the key.`;
}

/** Validate an already-parsed YAML document as a topology manifest.
 *  Collects EVERY structural error (per-entry, what/why/fix) rather than
 *  failing fast — FR-1 reports them all before any launch. */
export function validateTopologyManifest(parsed: unknown, sourcePath: string): TopologyManifestResult {
  const where = `topology manifest at ${sourcePath}`;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: [`${where}: must be a YAML object with a top-level 'softwareTeams' list`] };
  }
  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of Object.keys(obj)) {
    if (MANIFEST_KEYS.has(key)) continue;
    if (EDGE_ROUTING_KEYS.has(key)) {
      errors.push(edgeRoutingRejection(where, key));
    } else {
      errors.push(unknownKeyRejection(where, key, "'softwareTeams' + optional 'concurrency'"));
    }
  }

  let concurrency = 1;
  const rawConcurrency = obj["concurrency"];
  if (rawConcurrency !== undefined) {
    if (typeof rawConcurrency !== "number" || !Number.isInteger(rawConcurrency) || rawConcurrency < 1) {
      errors.push(
        `${where}: 'concurrency' must be a positive integer (a fixed staged-launch cap; default 1 = sequential; adaptive throttling is out of scope) — got ${JSON.stringify(rawConcurrency)}`,
      );
    } else {
      concurrency = rawConcurrency;
    }
  }

  const softwareTeams = obj["softwareTeams"];
  if (!Array.isArray(softwareTeams)) {
    errors.push(`${where}: 'softwareTeams' must be a list of entries {source, host?} — the ordered launch plan`);
    return { ok: false, errors };
  }
  if (softwareTeams.length === 0) {
    errors.push(`${where}: 'softwareTeams' is empty — a topology must name at least one SoftwareTeam to launch`);
    return { ok: false, errors };
  }

  const validated: TopologySoftwareTeamEntry[] = [];
  for (let i = 0; i < softwareTeams.length; i++) {
    const raw = softwareTeams[i];
    const prefix = `${where}: softwareTeams[${i}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${prefix}: must be an object with a 'source' SoftwareTeam ref (spec path, library name, or .softwareteambundle path) and optional 'host'`);
      continue;
    }
    const entry = raw as Record<string, unknown>;

    for (const key of Object.keys(entry)) {
      if (ENTRY_KEYS.has(key)) continue;
      if (EDGE_ROUTING_KEYS.has(key)) {
        errors.push(edgeRoutingRejection(prefix, key));
      } else {
        errors.push(unknownKeyRejection(prefix, key, "'source' + optional 'host'"));
      }
    }

    const source = entry["source"];
    if (typeof source !== "string" || source.trim() === "") {
      errors.push(`${prefix}.source: required non-empty string — a softwareTeam SPEC PATH (v0 boundary; see the per-form rejections below)`);
      continue;
    }
    // ── v0 source-form boundary (arch ruling 2026-07-05, guard F2/F3 fold):
    // topology entries are SPEC PATHS ONLY, rejected at PARSE time — uniform
    // entry semantics beat mid-walk failure, and neither widening is free:
    // bundle targetRoot is a pm-gated closed-key extension (R11-1); library
    // names need a daemon resolution seam (P4-adjacent+). Both are NAMED
    // DEFERRALS. Direct-to-software-team-up forms are untouched (FR-2 stands).
    if (/\.softwareteambundle$/i.test(source)) {
      errors.push(
        `${prefix}.source: '.softwareteambundle' entries are not supported in v0 — topology entries are SPEC PATHS ONLY (a bundle entry needs an explicit per-entry targetRoot, a pm-gated extension of the closed key set; deferred). Workaround: launch that SoftwareTeam directly — single-software-team 'SoftwareTeam up ${source}' accepts all source kinds unchanged.`,
      );
      continue;
    }
    if (/\.softwareteamtopology$/i.test(source)) {
      errors.push(`${prefix}.source: nested topology manifests are not supported — every entry must be a single-software-team spec path.`);
      continue;
    }
    if (!source.includes("/") && !/\.ya?ml$/i.test(source)) {
      errors.push(
        `${prefix}.source: '${source}' is a bare library/SoftwareTeam name — v0 topology entries are SPEC PATHS ONLY (name entries need a daemon-side resolution seam; deferred). Workaround: run 'SoftwareTeam up ${source}' individually, or reference its spec file by path.`,
      );
      continue;
    }
    const host = entry["host"];
    if (host !== undefined && (typeof host !== "string" || host.trim() === "")) {
      errors.push(`${prefix}.host: optional, but if present must be a non-empty registered host id (per-entry 'host:' is the ONLY topology placement mechanism)`);
      continue;
    }
    validated.push({ source, ...(host !== undefined ? { host: host as string } : {}) });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: { softwareTeams: validated, concurrency } };
}

/** Load + parse + validate a topology manifest file. Parse failures error AS
 *  a topology (arch ruling 1: the declared kind binds — no software-team-spec
 *  fall-through). */
export function loadTopologyManifest(path: string): TopologyManifestResult {
  if (!existsSync(path)) {
    return {
      ok: false,
      errors: [
        `topology manifest not found at ${path}. Create a .softwareteamtopology YAML file with a top-level 'softwareTeams:' list of {source, host?} entries (+ optional 'concurrency').`,
      ],
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { ok: false, errors: [`failed to read topology manifest at ${path}: ${(err as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return { ok: false, errors: [`failed to parse topology manifest YAML at ${path}: ${(err as Error).message}`] };
  }
  return validateTopologyManifest(parsed, path);
}

/** Detection sniff (FR-1 + guard G-1/yaml folds): a parsed YAML document is
 *  topology-SHAPED iff it carries a top-level `softwareTeams:` LIST. A softwareTeam spec never
 *  carries top-level `softwareTeams`, so the sniff is unambiguous. Shape only — full
 *  validation still runs (and rejects) as a topology afterwards. */
export function hasTopLevelSoftwareTeamsList(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return Array.isArray((parsed as Record<string, unknown>)["softwareTeams"]);
}

/** Raw-text form of the sniff for router branches that have not parsed yet
 *  (the extensionless path-form fallback). Unparseable YAML sniffs false —
 *  it then flows to the existing non-topology handling unchanged. */
export function yamlTextHasTopLevelSoftwareTeamsList(raw: string): boolean {
  try {
    return hasTopLevelSoftwareTeamsList(parseYaml(raw));
  } catch {
    return false;
  }
}
