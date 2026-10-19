import fs from "node:fs";
import { Hono } from "hono";
import type { Context } from "hono";
import type { SoftwareTeamSpecExporter } from "../domain/software-team-spec-exporter.js";
import type { SoftwareTeamInstantiator, PodSoftwareTeamInstantiator } from "../domain/software-team-spec-instantiator.js";
import type { SoftwareTeamSpecPreflight } from "../domain/software-team-spec-preflight.js";
import type { SoftwareTeamRepository } from "../domain/software-team-repository.js";
import { LegacySoftwareTeamSpecCodec } from "../domain/software-team-spec-codec.js";
import { SoftwareTeamSpecCodec } from "../domain/software-team-spec-codec.js";
import { LegacySoftwareTeamSpecSchema } from "../domain/software-team-spec-schema.js";
import { SoftwareTeamSpecSchema } from "../domain/software-team-spec-schema.js";
import { softwareTeamPreflight } from "../domain/software-team-spec-preflight.js";
import { SoftwareTeamNotFoundError } from "../domain/errors.js";
import { runSyncSite } from "../domain/sync-site-wrap.js";
import { runtimeVersionProbeCwd } from "../adapters/preflight-exec.js";
import { SoftwareTeamSpecParseError, validateSoftwareTeamSpecImport } from "../domain/spec-validation-service.js";

export const softwareTeamSpecImportRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    exporter: c.get("softwareTeamSpecExporter" as never) as SoftwareTeamSpecExporter,
    instantiator: c.get("softwareTeamInstantiator" as never) as SoftwareTeamInstantiator,
    preflight: c.get("softwareTeamSpecPreflight" as never) as SoftwareTeamSpecPreflight,
    podInstantiator: c.get("podInstantiator" as never) as PodSoftwareTeamInstantiator,
    softwareTeamRepo: c.get("softwareTeamRepo" as never) as SoftwareTeamRepository,
  };
}

// GET /api/software-teams/:softwareTeamId/spec -> YAML
export function handleExportYaml(c: Context): Response {
  const softwareTeamId = c.req.param("softwareTeamId")!;
  const { exporter } = getDeps(c);

  try {
    const spec = exporter.exportSoftwareTeam(softwareTeamId);
    // Detect format: pod-aware SoftwareTeamSpec has `pods`, legacy has `schemaVersion`
    const isPodAware = "pods" in spec;
    const yaml = isPodAware
      ? SoftwareTeamSpecCodec.serialize(spec as import("../domain/types.js").SoftwareTeamSpec)
      : LegacySoftwareTeamSpecCodec.serialize(spec as import("../domain/types.js").LegacySoftwareTeamSpec);
    return new Response(yaml, {
      status: 200,
      headers: { "Content-Type": "text/yaml" },
    });
  } catch (err) {
    if (err instanceof SoftwareTeamNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "Export failed" }, 500);
  }
}

// GET /api/software-teams/:softwareTeamId/spec.json -> JSON
export function handleExportJson(c: Context): Response {
  const softwareTeamId = c.req.param("softwareTeamId")!;
  const { exporter } = getDeps(c);

  try {
    const spec = exporter.exportSoftwareTeam(softwareTeamId);
    return c.json(spec);
  } catch (err) {
    if (err instanceof SoftwareTeamNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "Export failed" }, 500);
  }
}

// POST /api/software-teams/import -> instantiate from YAML
softwareTeamSpecImportRoutes.post("/", async (c) => {
  const { instantiator, podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = SoftwareTeamSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);

  if (isPodAware) {
    const softwareTeamRoot = c.req.header("X-Software-Team-Root");
    if (!softwareTeamRoot) return c.json({ error: "X-Software-Team-Root header required for pod-aware specs", code: "missing_software_team_root" }, 400);
    const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;

    const outcome = await podInstantiator.instantiate(body, softwareTeamRoot, { cwdOverride });
    if (!outcome.ok) {
      const status = outcome.code === "validation_failed" ? 400
        : outcome.code === "preflight_failed" ? 409
        : outcome.code === "cycle_error" ? 400
        // S5b final-fix F1: the running-name guard refusal is a conflict on the
        // direct instantiation route too — never a 500 (map consistency).
        : outcome.code === "software_team_name_running" ? 409
        // #141: an import refused because a same-name softwareTeam could not be confirmed stopped.
        : outcome.code === "generation_unconfirmed" ? 409
        // A Compose project conflict is an actionable request conflict, not a server failure.
        : outcome.code === "compose_project_conflict" ? 409
        : 500;
      const body = outcome.code === "software_team_name_running" || outcome.code === "generation_unconfirmed" || outcome.code === "compose_project_conflict"
        ? { ...outcome, error: outcome.message }
        : outcome;
      return c.json(body, status);
    }
    return c.json(outcome.result, 201);
  }

  // Legacy path
  let spec;
  try {
    spec = LegacySoftwareTeamSpecSchema.normalize(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const outcome = await instantiator.instantiate(spec);
  if (!outcome.ok) {
    const status = outcome.code === "validation_failed" ? 400
      : outcome.code === "preflight_failed" ? 409
      : outcome.code === "software_team_name_running" ? 409
      : 500;
    const body = outcome.code === "software_team_name_running"
      ? { ...outcome, error: outcome.message }
      : outcome;
    return c.json(body, status);
  }
  return c.json(outcome.result, 201);
});

// POST /api/software-teams/import/workspace -> apply only a validated workspace declaration
softwareTeamSpecImportRoutes.post("/workspace", async (c) => {
  const { softwareTeamRepo } = getDeps(c);
  const targetSoftwareTeamId = c.req.header("X-Target-software-team-Id");
  if (!targetSoftwareTeamId) {
    return c.json({ ok: false, code: "target_software_team_required", error: "X-Target-software-team-Id header required for workspace-only apply" }, 400);
  }

  const body = await c.req.text();
  let raw: unknown;
  try {
    raw = SoftwareTeamSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, code: "validation_failed", errors: [message] }, 400);
  }

  const workspace = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)["workspace"]
    : undefined;
  if (workspace === undefined || workspace === null) {
    return c.json({ ok: false, code: "workspace_required", errors: ["workspace: required for workspace-only apply"] }, 400);
  }

  const validation = SoftwareTeamSpecSchema.validateWorkspace(workspace);
  if (!validation.valid) {
    return c.json({ ok: false, code: "validation_failed", errors: validation.errors }, 400);
  }

  const normalizedWorkspace = SoftwareTeamSpecSchema.normalizeWorkspace(workspace)!;
  if (!softwareTeamRepo.getSoftwareTeam(targetSoftwareTeamId)) {
    return c.json({ ok: false, code: "target_software_team_not_found", error: `SoftwareTeam not found: ${targetSoftwareTeamId}` }, 404);
  }

  const current = softwareTeamRepo.getSoftwareTeamWorkspace(targetSoftwareTeamId);
  const changed = JSON.stringify(current) !== JSON.stringify(normalizedWorkspace);
  if (changed) softwareTeamRepo.setSoftwareTeamWorkspace(targetSoftwareTeamId, normalizedWorkspace);

  return c.json({ softwareTeamId: targetSoftwareTeamId, changed, workspace: normalizedWorkspace });
});

// POST /api/software-teams/import/materialize -> create softwareTeam topology without launching
softwareTeamSpecImportRoutes.post("/materialize", async (c) => {
  const { podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = SoftwareTeamSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  if (!isPodAware) {
    return c.json({ error: "materialize-only requires a pod-aware SoftwareTeamSpec", code: "pod_aware_required" }, 400);
  }

  const softwareTeamRoot = c.req.header("X-Software-Team-Root");
  if (!softwareTeamRoot) return c.json({ error: "X-Software-Team-Root header required for pod-aware specs", code: "missing_software_team_root" }, 400);

  const targetSoftwareTeamId = c.req.header("X-Target-software-team-Id") ?? undefined;
  const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;
  const outcome = await podInstantiator.materialize(body, softwareTeamRoot, { targetSoftwareTeamId, cwdOverride });
  if (!outcome.ok) {
    const status = outcome.code === "validation_failed" ? 400
      : outcome.code === "preflight_failed" ? 409
      : outcome.code === "target_software_team_not_found" ? 404
      : outcome.code === "materialize_conflict" ? 409
      : outcome.code === "software_team_name_running" ? 409
      : 500;
    const body = outcome.code === "software_team_name_running"
      ? { ...outcome, error: outcome.message }
      : outcome;
    return c.json(body, status);
  }
  return c.json(outcome.result, 201);
});

// POST /api/software-teams/import/validate -> validate only (auto-detects format)
softwareTeamSpecImportRoutes.post("/validate", async (c) => {
  const body = await c.req.text();
  try {
    return c.json(validateSoftwareTeamSpecImport(body));
  } catch (err) {
    if (!(err instanceof SoftwareTeamSpecParseError)) throw err;
    return c.json({ valid: false, errors: [err.message] }, 400);
  }
});

// POST /api/software-teams/import/preflight -> validate + preflight (auto-detects format)
softwareTeamSpecImportRoutes.post("/preflight", async (c) => {
  const { preflight, podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = SoftwareTeamSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  if (isPodAware) {
    const softwareTeamRoot = c.req.header("X-Software-Team-Root");
    if (!softwareTeamRoot) return c.json({ ready: false, errors: ["X-Software-Team-Root header required for pod-aware specs"], warnings: [] }, 400);
    const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;
    const fsOps = { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) };
    const { execSync } = await import("node:child_process");
    const exec = async (cmd: string) => runSyncSite("software-team-spec.import.preflight", () =>
      execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000, cwd: runtimeVersionProbeCwd(cmd) })
    );
    const result = await softwareTeamPreflight({
      softwareTeamSpecYaml: body,
      softwareTeamRoot,
      cwdOverride,
      fsOps,
      skillsRoot: podInstantiator.resolveSkillsRoot?.(),
      exec,
    });
    return c.json(result);
  }

  // Legacy
  let spec;
  try {
    spec = LegacySoftwareTeamSpecSchema.normalize(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const result = await preflight.check(spec);
  return c.json(result);
});
