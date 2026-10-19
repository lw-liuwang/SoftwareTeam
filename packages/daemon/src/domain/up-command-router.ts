import { LegacySoftwareTeamSpecCodec as LegacyCodec } from "./software-team-spec-codec.js";
import { LegacySoftwareTeamSpecSchema as LegacySchema } from "./software-team-spec-schema.js";
import { SoftwareTeamSpecCodec as PodCodec } from "./software-team-spec-codec.js";
import { SoftwareTeamSpecSchema as PodSchema } from "./software-team-spec-schema.js";
import { yamlTextHasTopLevelSoftwareTeamsList } from "./topology/topology-manifest.js";

export type SourceKind = "software_team_spec" | "software_team_bundle" | "software_team_name" | "topology";

export interface RouteResult {
  sourceKind: SourceKind;
  sourceRef: string;
}

interface RouterFsOps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  readHead: (path: string, bytes: number) => Buffer;
}

/** Gzip magic bytes: 0x1f 0x8b */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function podSchemaOwnsDiagnostics(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if ("pods" in obj) return true;
  // Legacy owns diagnostics only when the document declares a legacy marker;
  // otherwise a typo in the canonical root cannot silently switch schemas.
  return !("nodes" in obj || "schema_version" in obj);
}

/**
 * Routes a source path to the correct bootstrap pipeline based on
 * file extension or content-based auto-detection.
 */
export class UpCommandRouter {
  private fs: RouterFsOps;

  constructor(deps: { fsOps: RouterFsOps }) {
    this.fs = deps.fsOps;
  }

  route(sourceRef: string): RouteResult {
    // SoftwareTeam name detection: no '/' and no file extension → treat as existing softwareTeam name.
    // OPR.0.4.4.11 (guard G-1): `.softwareteamtopology` counts as a file extension here,
    // so a bare `factory.softwareteamtopology` reaches topology routing. A no-slash
    // EXTENSIONLESS source keeps software_team_name precedence byte-for-byte (FR-2
    // negative AC; `./file` is the explicit path escape hatch).
    if (!sourceRef.includes("/") && !sourceRef.match(/\.(ya?ml|softwareteambundle|softwareteamtopology)$/i)) {
      return { sourceKind: "software_team_name", sourceRef };
    }

    if (!this.fs.exists(sourceRef)) {
      throw new Error(`Source not found: ${sourceRef}. Provide a .yaml SoftwareTeam spec path or a SoftwareTeam name to restore.`);
    }

    // Extension-based routing
    const ext = sourceRef.split(".").pop()?.toLowerCase();
    if (ext === "softwareteambundle") {
      return { sourceKind: "software_team_bundle", sourceRef };
    }
    // OPR.0.4.4.11 (arch ruling 1): the declared extension BINDS — a
    // `.softwareteamtopology` file failing manifest validation errors downstream AS a
    // topology; it never falls through to software-team-spec parsing.
    if (ext === "softwareteamtopology") {
      return { sourceKind: "topology", sourceRef };
    }
    if (ext === "yaml" || ext === "yml") {
      // OPR.0.4.4.11 (guard yaml fold): a YAML document with a top-level
      // `softwareTeams:` LIST is a topology by the FR-1 detection contract — sniff
      // BEFORE software-team-spec validation so a `factory.yaml` topology never dies
      // in a confusing software-team-spec error. A softwareTeam spec never carries top-level
      // `softwareTeams:`, so the sniff is unambiguous. Unreadable files flow to the
      // existing software-team-spec path, which reports them unchanged.
      try {
        if (yamlTextHasTopLevelSoftwareTeamsList(this.fs.readFile(sourceRef))) {
          return { sourceKind: "topology", sourceRef };
        }
      } catch {
        // fall through — validateYamlAsSoftwareTeamSpec owns the error surface
      }
      // Validate semantically — reject bundle.yaml, package.yaml, etc.
      return this.validateYamlAsSoftwareTeamSpec(sourceRef);
    }

    // Auto-detection fallback for extensionless files
    return this.autoDetect(sourceRef);
  }

  private validateYamlAsSoftwareTeamSpec(sourceRef: string): RouteResult {
    try {
      const content = this.fs.readFile(sourceRef);

      // Try canonical pod-aware schema first
      const podRaw = PodCodec.parse(content);
      const podValidation = PodSchema.validate(podRaw);
      if (podValidation.valid) {
        return { sourceKind: "software_team_spec", sourceRef };
      }
      // S7: a pod-shaped document belongs to the pod-aware validator even
      // when invalid. Falling through to legacy replaces an exact topology
      // diagnostic with the unrelated "nodes is required" error.
      if (podSchemaOwnsDiagnostics(podRaw)) {
        throw new Error(`Source is YAML but not a valid SoftwareTeam spec: ${podValidation.errors[0] ?? "unknown error"}`);
      }

      // Fall back to legacy schema
      const raw = LegacyCodec.parse(content);
      const validation = LegacySchema.validate(raw);
      if (validation.valid) {
        return { sourceKind: "software_team_spec", sourceRef };
      }

      // Not a valid softwareTeam spec — give helpful error
      const obj = raw as Record<string, unknown> | null;
      if (obj && typeof obj === "object") {
        if ("packages" in obj && ("integrity" in obj || "software_team_spec" in obj)) {
          throw new Error(`Source appears to be a bundle manifest (bundle.yaml), not a SoftwareTeam spec. Use 'SoftwareTeam bundle install' instead.`);
        }
        if ("exports" in obj || "compatibility" in obj) {
          throw new Error(`Source appears to be a package manifest (package.yaml), not a SoftwareTeam spec. Use 'SoftwareTeam package install' instead.`);
        }
      }

      throw new Error(`Source is YAML but not a valid SoftwareTeam spec: ${validation.errors[0] ?? "unknown error"}`);
    } catch (err) {
      if ((err as Error).message.includes("Source appears") || (err as Error).message.includes("Source is YAML")) {
        throw err;
      }
      throw new Error(`Failed to parse '${sourceRef}' as SoftwareTeam spec: ${(err as Error).message}`);
    }
  }

  private autoDetect(sourceRef: string): RouteResult {
    // Check for gzip (binary bundle)
    try {
      const head = this.fs.readHead(sourceRef, 2);
      if (head.length >= 2 && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1]) {
        return { sourceKind: "software_team_bundle", sourceRef };
      }
    } catch {
      // Can't read head — try as text
    }

    // Try parsing as YAML and validating as softwareTeam spec (canonical first, then legacy)
    try {
      const content = this.fs.readFile(sourceRef);

      // OPR.0.4.4.11 (guard G-1): extensionless PATH-form sources gain the
      // top-level `softwareTeams:` list sniff → topology. Only reachable for path
      // forms — a no-slash extensionless source classified software_team_name above
      // and never reaches autoDetect (documented precedence).
      if (yamlTextHasTopLevelSoftwareTeamsList(content)) {
        return { sourceKind: "topology", sourceRef };
      }

      // Try canonical pod-aware
      const podRaw = PodCodec.parse(content);
      const podVal = PodSchema.validate(podRaw);
      if (podVal.valid) {
        return { sourceKind: "software_team_spec", sourceRef };
      }
      if (podSchemaOwnsDiagnostics(podRaw)) {
        throw new Error(`Source is YAML but not a valid SoftwareTeam spec: ${podVal.errors[0] ?? "unknown error"}. Use .yaml for SoftwareTeam specs or .softwareteambundle for bundles.`);
      }

      // Try legacy
      const raw = LegacyCodec.parse(content);
      const validation = LegacySchema.validate(raw);
      if (validation.valid) {
        return { sourceKind: "software_team_spec", sourceRef };
      }

      // Valid YAML but not a softwareTeam spec — provide helpful message
      const obj = raw as Record<string, unknown> | null;
      if (obj && typeof obj === "object") {
        if ("packages" in obj && "integrity" in obj) {
          throw new Error(`Source appears to be a bundle manifest (bundle.yaml), not a SoftwareTeam spec. Use 'SoftwareTeam bundle install' instead.`);
        }
        if ("exports" in obj || "compatibility" in obj) {
          throw new Error(`Source appears to be a package manifest (package.yaml), not a SoftwareTeam spec. Use 'SoftwareTeam package install' instead.`);
        }
      }

      throw new Error(`Source is YAML but not a valid SoftwareTeam spec: ${validation.errors[0] ?? "unknown error"}. Use .yaml for SoftwareTeam specs or .softwareteambundle for bundles.`);
    } catch (err) {
      if ((err as Error).message.includes("Source appears") || (err as Error).message.includes("Source is YAML")) {
        throw err; // Re-throw our helpful messages
      }
      throw new Error(`Unable to determine source type for '${sourceRef}'. Use .yaml for SoftwareTeam specs or .softwareteambundle for bundles.`);
    }
  }
}
