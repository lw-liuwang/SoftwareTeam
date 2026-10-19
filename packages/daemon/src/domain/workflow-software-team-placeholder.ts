import type { WorkflowSpec } from "./workflow-types.js";

/**
 * A role's `preferred_targets` entry may end in `@{softwareTeam}`, as `member@{softwareTeam}`.
 * `{softwareTeam}` stands for the instance's bound softwareTeam (`--software-team`), so one reusable spec
 * addresses the same member on whichever softwareTeam it is run against.
 *
 * Only a trailing `@{softwareTeam}` is the form. Braces in the member part or inside a
 * longer softwareTeam name (`ops-{softwareTeam}@software-team-a`, `ops-watcher@prefix-{softwareTeam}`) stay literal.
 *
 * The cached spec keeps the literal `{softwareTeam}`; the expansion is computed from
 * the instance's stored `bound_software_team` wherever that instance's spec is read,
 * so projection, resume, recovery and exception routing all see one target.
 * With no bound softwareTeam the target stays literal and is handled like any other
 * unknown destination, at the hop that selects it.
 */
export const SOFTWARE_TEAM_PLACEHOLDER = "{softwareTeam}";
const SOFTWARE_TEAM_SUFFIX = `@${SOFTWARE_TEAM_PLACEHOLDER}`;

/** True when `target` is written `member@{softwareTeam}`. */
export function isSoftwareTeamRelativeTarget(target: string): boolean {
  return target.endsWith(SOFTWARE_TEAM_SUFFIX);
}

/** `member@{softwareTeam}` as `member@<boundSoftwareTeam>`; any other target, or no bound softwareTeam, is returned as is. */
export function expandSoftwareTeamRelativeTarget(target: string, boundSoftwareTeam: string | null): string {
  if (boundSoftwareTeam === null || !isSoftwareTeamRelativeTarget(target)) return target;
  return target.slice(0, target.length - SOFTWARE_TEAM_PLACEHOLDER.length) + boundSoftwareTeam;
}

/** The spec with each `member@{softwareTeam}` target resolved against `boundSoftwareTeam`. Returns
 *  `spec` itself when `boundSoftwareTeam` is null or no target uses the form. */
export function bindSpecToSoftwareTeam(spec: WorkflowSpec, boundSoftwareTeam: string | null): WorkflowSpec {
  if (boundSoftwareTeam === null) return spec;
  const uses = Object.values(spec.roles ?? {}).some((role) => (role?.preferred_targets ?? []).some(isSoftwareTeamRelativeTarget));
  if (!uses) return spec;
  const roles: NonNullable<WorkflowSpec["roles"]> = {};
  for (const [name, role] of Object.entries(spec.roles ?? {})) {
    roles[name] = role?.preferred_targets
      ? { ...role, preferred_targets: role.preferred_targets.map((t) => expandSoftwareTeamRelativeTarget(t, boundSoftwareTeam)) }
      : role;
  }
  return { ...spec, roles };
}
