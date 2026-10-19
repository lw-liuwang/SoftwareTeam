import type { SoftwareTeamRepository } from "./software-team-repository.js";
import type { ComposeServicesAdapter } from "../adapters/compose-services-adapter.js";
import type { SoftwareTeamServicesSpec, SoftwareTeamServicesRecord, EnvReceipt } from "./types.js";
import { evaluateWaitTargets, deriveEnvHealth } from "./services-readiness.js";

export type ServiceBootResult =
  | { ok: true; receipt: EnvReceipt; health: "healthy" | "degraded" }
  | { ok: false; code: string; error: string; receipt?: EnvReceipt };

export type ServiceTeardownResult =
  | { ok: true; kept?: string }
  | { ok: false; code: string; error: string };

interface ServiceOrchestratorDeps {
  softwareTeamRepo: SoftwareTeamRepository;
  composeAdapter: ComposeServicesAdapter;
}

/**
 * Leaf service called by existing orchestrators (bootstrap, teardown, restore).
 * Does NOT independently manage boot/teardown timing — callers decide when.
 */
export class ServiceOrchestrator {
  private softwareTeamRepo: SoftwareTeamRepository;
  private composeAdapter: ComposeServicesAdapter;

  constructor(deps: ServiceOrchestratorDeps) {
    this.softwareTeamRepo = deps.softwareTeamRepo;
    this.composeAdapter = deps.composeAdapter;
  }

  /**
   * Boot services for a softwareTeam. Called by bootstrap orchestrator as a stage before agent launch.
   * 1. Load persisted services record
   * 2. Run docker compose up
   * 3. Evaluate wait targets
   * 4. Persist receipt
   */
  async boot(softwareTeamId: string, opts?: { waitTimeoutMs?: number; waitPollIntervalMs?: number }): Promise<ServiceBootResult> {
    const record = this.softwareTeamRepo.getServicesRecord(softwareTeamId);
    if (!record) {
      return { ok: false, code: "no_services", error: "No services record found for this softwareTeam" };
    }

    const spec = this.parseSpec(record);
    if (!spec) {
      return { ok: false, code: "invalid_spec", error: "Could not parse persisted services spec" };
    }

    // 1. Launch compose services
    const upResult = await this.composeAdapter.up({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec.profiles,
    });

    if (!upResult.ok) {
      return { ok: false, code: upResult.code, error: upResult.message };
    }

    // 2. Evaluate wait targets with polling
    const waitTargets = spec.waitFor ?? [];
    if (waitTargets.length > 0) {
      const timeoutMs = opts?.waitTimeoutMs ?? 60_000;
      const pollMs = opts?.waitPollIntervalMs ?? 3_000;
      const start = Date.now();

      while (true) {
        // Get current compose status for condition:healthy targets
        const statusResult = await this.composeAdapter.status({
          composeFile: record.composeFile,
          projectName: record.projectName,
          profiles: spec.profiles,
        });

        if (!statusResult.ok) {
          const elapsed = Date.now() - start;
          if (elapsed + pollMs > timeoutMs) {
            return {
              ok: false,
              code: "compose_status_failed",
              error: statusResult.error ?? "Failed to read docker compose status",
            };
          }

          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }

        const waitResults = await evaluateWaitTargets(
          waitTargets,
          this.composeAdapter,
          statusResult.services,
        );

        const health = deriveEnvHealth(waitResults);
        if (health === "healthy") {
          // All targets healthy — capture receipt and return
          const receipt = this.buildReceipt(record, statusResult.services, waitResults);
          this.softwareTeamRepo.updateServicesReceipt(softwareTeamId, JSON.stringify(receipt));
          return { ok: true, receipt, health: "healthy" };
        }

        const elapsed = Date.now() - start;
        if (elapsed + pollMs > timeoutMs) {
          // Timeout — persist partial receipt honestly
          const receipt = this.buildReceipt(record, statusResult.services, waitResults);
          this.softwareTeamRepo.updateServicesReceipt(softwareTeamId, JSON.stringify(receipt));
          const failedTargets = waitResults.filter((r) => r.status !== "healthy");
          const failedNames = failedTargets.map((r) => r.detail ?? JSON.stringify(r.target)).join("; ");
          return { ok: false, code: "wait_timeout", error: `Service wait targets not healthy after ${Math.round(timeoutMs / 1000)}s: ${failedNames}`, receipt };
        }

        await new Promise((r) => setTimeout(r, pollMs));
      }
    }

    // No wait targets — just capture receipt
    const statusResult = await this.composeAdapter.status({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec.profiles,
    });
    if (!statusResult.ok) {
      return {
        ok: false,
        code: "compose_status_failed",
        error: statusResult.error ?? "Failed to read docker compose status",
      };
    }
    const receipt = this.buildReceipt(record, statusResult.services, []);
    this.softwareTeamRepo.updateServicesReceipt(softwareTeamId, JSON.stringify(receipt));
    return { ok: true, receipt, health: "healthy" };
  }

  /**
   * Tear down services for a softwareTeam. Called by teardown orchestrator during SoftwareTeam down.
   * Honors down_policy from the persisted spec.
   */
  async teardown(softwareTeamId: string, opts?: { policyOverride?: "down" | "down_and_volumes" | "leave_running" }): Promise<ServiceTeardownResult> {
    const record = this.softwareTeamRepo.getServicesRecord(softwareTeamId);
    if (!record) {
      return { ok: true }; // No services — nothing to tear down
    }
    const successor = this.softwareTeamRepo.getLiveServicesSuccessor(softwareTeamId, record.projectName);
    if (successor) {
      return { ok: true, kept: `kept project ${record.projectName}: still used by softwareTeam ${successor.name} (${successor.id})` };
    }

    const spec = this.parseSpec(record);
    const policy = opts?.policyOverride ?? spec?.downPolicy ?? "down";

    const result = await this.composeAdapter.down({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec?.profiles,
      policy,
    });

    if (!result.ok) {
      return { ok: false, code: result.code, error: result.message };
    }

    // Update receipt to reflect teardown
    this.softwareTeamRepo.updateServicesReceipt(softwareTeamId, null);
    return { ok: true };
  }

  /**
   * Capture a fresh receipt from current compose state. Called by snapshot capture.
   */
  async captureReceipt(softwareTeamId: string): Promise<EnvReceipt | null> {
    const record = this.softwareTeamRepo.getServicesRecord(softwareTeamId);
    if (!record) return null;

    const spec = this.parseSpec(record);
    const statusResult = await this.composeAdapter.status({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec?.profiles,
    });
    if (!statusResult.ok) {
      throw new Error(statusResult.error ?? "Failed to read docker compose status");
    }

    const waitTargets = spec?.waitFor ?? [];
    const waitResults = waitTargets.length > 0
      ? await evaluateWaitTargets(waitTargets, this.composeAdapter, statusResult.services)
      : [];

    const receipt = this.buildReceipt(record, statusResult.services, waitResults);
    this.softwareTeamRepo.updateServicesReceipt(softwareTeamId, JSON.stringify(receipt));
    return receipt;
  }

  // -- Private helpers --

  private parseSpec(record: SoftwareTeamServicesRecord): SoftwareTeamServicesSpec | null {
    try {
      return JSON.parse(record.specJson) as SoftwareTeamServicesSpec;
    } catch {
      return null;
    }
  }

  private buildReceipt(
    record: SoftwareTeamServicesRecord,
    services: Array<{ name: string; state: string; status: string; health: string | null }>,
    waitResults: Array<{ target: import("./types.js").SoftwareTeamServicesWaitTarget; status: string; detail: string | null }>,
  ): EnvReceipt {
    return {
      kind: "compose",
      composeFile: record.composeFile,
      projectName: record.projectName,
      services: services.map((s) => ({ name: s.name, status: s.state, health: s.health })),
      waitFor: waitResults.map((r) => ({
        target: r.target,
        status: r.status as "healthy" | "unhealthy" | "pending",
        detail: r.detail,
      })),
      capturedAt: new Date().toISOString(),
    };
  }
}
