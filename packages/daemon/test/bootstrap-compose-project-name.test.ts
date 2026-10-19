import { describe, expect, it, vi } from "vitest";
import { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { deriveComposeProjectName } from "../src/domain/compose-project-name.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";

type PrelaunchHook = (softwareTeamId: string, replacedSoftwareTeamIds?: readonly string[]) => Promise<{ ok: boolean; code?: string; message?: string }>;
type ServiceHookAccess = {
  buildServicePrelaunchHook(
    yaml: string, root: string, stages: unknown[], errors: string[],
  ): Promise<PrelaunchHook | undefined>;
};

describe("bootstrap Compose project identity", () => {
  it.each(["success", "failure", "explicit", "ambiguous"])("uses exact predecessors and protects retained projects (%s)", async (scenario) => {
    const db = createFullTestDb();
    try {
      const softwareTeamRepo = new SoftwareTeamRepository(db);
      const commands: string[] = [];
      const adapter = new ComposeServicesAdapter(async cmd => {
        commands.push(cmd);
        if (scenario === "failure" && cmd.includes("up -d")) throw new Error("test boot failure");
        return "";
      });
      const serviceOrchestrator = new ServiceOrchestrator({ softwareTeamRepo, composeAdapter: adapter });
      const dbHandle = { db };
      const orchestrator = new BootstrapOrchestrator({
        db, softwareTeamRepo, serviceOrchestrator, bootstrapRepo: dbHandle,
        runtimeVerifier: dbHandle, installExecutor: dbHandle, packageInstallService: dbHandle,
      } as ConstructorParameters<typeof BootstrapOrchestrator>[0]);
      const store = (id: string, projectName: string) => softwareTeamRepo.setServicesRecord(id, {
        kind: "compose", specJson: JSON.stringify({ kind: "compose", composeFile: "compose.yaml", projectName }),
        softwareTeamRoot: process.cwd(), composeFile: "compose.yaml", projectName,
      });
      const historical = softwareTeamRepo.createSoftwareTeam("demo-software-team");
      store(historical.id, "unrelated-old-project");
      softwareTeamRepo.archiveSoftwareTeam(historical.id);
      const predecessor = softwareTeamRepo.createSoftwareTeam("demo-software-team");
      store(predecessor.id, "legacy-project");
      softwareTeamRepo.archiveSoftwareTeam(predecessor.id);
      const replaced = [predecessor.id];
      if (scenario === "ambiguous") {
        const other = softwareTeamRepo.createSoftwareTeam("demo-software-team");
        store(other.id, "another-project");
        softwareTeamRepo.archiveSoftwareTeam(other.id);
        replaced.push(other.id);
      }
      const current = softwareTeamRepo.createSoftwareTeam("demo-software-team");
      const yaml = `version: "0.2"
name: demo-software-team
services:
  kind: compose
  compose_file: compose.yaml
${scenario === "explicit" ? "  project_name: requested-project\n" : ""}pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        runtime: claude-code
        profile: default
        cwd: .
    edges: []
edges: []
`;
      const hook = await (orchestrator as unknown as ServiceHookAccess).buildServicePrelaunchHook(yaml, process.cwd(), [], []);
      const result = await hook!(current.id, replaced);
      expect(result.ok).toBe(scenario !== "failure" && scenario !== "ambiguous");
      if (scenario === "ambiguous") {
        expect(result.code).toBe("compose_project_conflict");
        for (const id of replaced) {
          expect(result.message).toContain(`${id}: ${softwareTeamRepo.getServicesRecord(id)!.projectName}`);
        }
        expect(result.message).toContain("Set services.project_name in the SoftwareTeam spec YAML");
        expect(result.message).toContain("re-run the same command");
        expect(result.message).toContain("No services were started");
        expect(commands).toEqual([]);
        expect(softwareTeamRepo.getServicesRecord(current.id)).toBeNull();
      } else {
        const expected = scenario === "explicit" ? "requested-project" : "legacy-project";
        expect(softwareTeamRepo.getServicesRecord(current.id)!.projectName).toBe(expected);
        expect(commands.some(cmd => cmd.includes(`-p '${expected}'`) && cmd.includes("up -d"))).toBe(true);
        expect(commands.some(cmd => cmd.includes("down"))).toBe(false);
        if (scenario === "success") {
          // Even explicit volume cleanup on the archived generation cannot destroy the live project.
          commands.length = 0;
          const teardown = await serviceOrchestrator.teardown(predecessor.id, { policyOverride: "down_and_volumes" });
          expect(teardown).toEqual({ ok: true, kept: `kept project legacy-project: still used by SoftwareTeam demo-software-team (${current.id})` });
          expect(commands).toEqual([]);
          await serviceOrchestrator.teardown(current.id);
          expect(commands.some(cmd => cmd.includes("-p 'legacy-project'") && cmd.includes("down"))).toBe(true);
        }
      }
    } finally {
      db.close();
    }
  });

  it.each(["unrelated", "unarchived"])("tears down both live owners sharing an explicit project (%s)", async (scenario) => {
    const db = createFullTestDb();
    try {
      const softwareTeamRepo = new SoftwareTeamRepository(db);
      const commands: string[] = [];
      const adapter = new ComposeServicesAdapter(async cmd => { commands.push(cmd); return ""; });
      const orchestrator = new ServiceOrchestrator({ softwareTeamRepo, composeAdapter: adapter });
      const first = softwareTeamRepo.createSoftwareTeam("first");
      if (scenario === "unarchived") softwareTeamRepo.archiveSoftwareTeam(first.id);
      const second = softwareTeamRepo.createSoftwareTeam(scenario === "unarchived" ? "first" : "second");
      if (scenario === "unarchived") softwareTeamRepo.unarchiveSoftwareTeam(first.id);
      for (const softwareTeam of [first, second]) {
        softwareTeamRepo.setServicesRecord(softwareTeam.id, {
          kind: "compose", specJson: JSON.stringify({ kind: "compose", composeFile: "compose.yaml", projectName: "shared" }),
          softwareTeamRoot: process.cwd(), composeFile: "compose.yaml", projectName: "shared", latestReceiptJson: "{}",
        });
      }
      for (const softwareTeam of [first, second]) {
        expect(await orchestrator.teardown(softwareTeam.id)).toEqual({ ok: true });
        expect(softwareTeamRepo.getServicesRecord(softwareTeam.id)!.latestReceiptJson).toBeNull();
      }
      expect(commands).toHaveLength(2);
      expect(commands.every(cmd => cmd.includes("-p 'shared'") && cmd.includes("down"))).toBe(true);
    } finally { db.close(); }
  });

  it.each([undefined, "explicit-project"])("persists the actual project in both record and spec (%s)", async (explicit) => {
    const db = createFullTestDb();
    try {
      const softwareTeamRepo = new SoftwareTeamRepository(db);
      const serviceOrchestrator = { boot: vi.fn(async () => ({ ok: true, receipt: {}, health: [] })) };
      // Other stages only participate in constructor DB-handle checks here.
      const dbHandle = { db };
      const orchestrator = new BootstrapOrchestrator({
        db, softwareTeamRepo, serviceOrchestrator, bootstrapRepo: dbHandle,
        runtimeVerifier: dbHandle, installExecutor: dbHandle, packageInstallService: dbHandle,
      } as
        ConstructorParameters<typeof BootstrapOrchestrator>[0]);
      const hookAccess = orchestrator as unknown as ServiceHookAccess;
      const yaml = `version: "0.2"
name: demo-software-team
services:
  kind: compose
  compose_file: compose.yaml
${explicit ? `  project_name: ${explicit}\n` : ""}pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        runtime: claude-code
        profile: default
        cwd: .
    edges: []
edges: []
`;
      const hook = await hookAccess.buildServicePrelaunchHook(yaml, process.cwd(), [], []);
      expect(hook).toBeDefined();
      const first = softwareTeamRepo.createSoftwareTeam("demo-software-team");
      const second = softwareTeamRepo.createSoftwareTeam("demo-software-team-2");
      for (const softwareTeam of [first, second]) {
        expect(await hook!(softwareTeam.id)).toMatchObject({ ok: true });
        const stored = softwareTeamRepo.getServicesRecord(softwareTeam.id)!;
        const expected = explicit ?? deriveComposeProjectName(softwareTeam.id);
        expect(stored.projectName).toBe(expected);
        expect(JSON.parse(stored.specJson).projectName).toBe(expected);
        expect(serviceOrchestrator.boot).toHaveBeenCalledWith(softwareTeam.id);
      }
      if (!explicit) {
        expect(softwareTeamRepo.getServicesRecord(first.id)!.projectName)
          .not.toBe(softwareTeamRepo.getServicesRecord(second.id)!.projectName);
      }
    } finally {
      db.close();
    }
  });
});
