import { parseAgentSpec, validateAgentSpec } from "./agent-manifest.js";
import { SoftwareTeamSpecCodec } from "./software-team-spec-codec.js";
import { LegacySoftwareTeamSpecSchema, SoftwareTeamSpecSchema } from "./software-team-spec-schema.js";
import type { ValidationResult } from "./types.js";

/** Only parser failures are client input errors; validator exceptions remain internal failures. */
export class SoftwareTeamSpecParseError extends Error {}

/** Shared CLI/import validation with a distinct parser-error boundary. */
export function validateSoftwareTeamSpecImport(yaml: string): ValidationResult {
  let raw: unknown;
  try {
    raw = SoftwareTeamSpecCodec.parse(yaml);
  } catch (err) {
    throw new SoftwareTeamSpecParseError(err instanceof Error ? err.message : String(err), { cause: err });
  }
  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  return isPodAware ? SoftwareTeamSpecSchema.validate(raw) : LegacySoftwareTeamSpecSchema.validate(raw);
}

/**
 * Validate an AgentSpec from raw YAML text.
 * No filesystem access, no side effects.
 * @param yaml - raw agent.yaml content
 * @returns validation result
 */
export function validateAgentSpecFromYaml(yaml: string): { valid: boolean; errors: string[] } {
  try {
    const raw = parseAgentSpec(yaml);
    return validateAgentSpec(raw);
  } catch (err) {
    return { valid: false, errors: [`Parse error: ${(err as Error).message}`] };
  }
}

/**
 * Validate a pod-aware SoftwareTeamSpec from raw YAML text.
 * No filesystem access, no side effects.
 * @param yaml - raw software-team.yaml content
 * @returns validation result
 */
export function validateSoftwareTeamSpecFromYaml(yaml: string): { valid: boolean; errors: string[] } {
  try {
    const raw = SoftwareTeamSpecCodec.parse(yaml);
    return SoftwareTeamSpecSchema.validate(raw);
  } catch (err) {
    return { valid: false, errors: [`Parse error: ${(err as Error).message}`] };
  }
}
