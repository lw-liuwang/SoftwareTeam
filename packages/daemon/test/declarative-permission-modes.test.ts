import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { SoftwareTeamSpecCodec } from "../src/domain/software-team-spec-codec.js";
import { SoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import { SoftwareTeamSpecExporter } from "../src/domain/software-team-spec-exporter.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SoftwareTeamSpec } from "../src/domain/types.js";

const opened: Database.Database[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) {
    if (db.open) db.close();
  }
  vi.unstubAllEnvs();
});

function createTestDb() {
  const db = new Database(":memory:");
  opened.push(db);
  db.pragma("foreign_keys = ON");
  migrate(db, ALL_MIGRATIONS);
  return db;
}

function binding(nodeId: string): NodeBinding {
  return { nodeId, runtime: "claude-code", sessionName: "seat", cwd: "/inert" };
}

describe("Issue #611 Declarative Permission Policy Precedence & Cascade", () => {
  it("Level 1: explicit per-seat selection overrides member, softwareTeam, and system defaults", () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:auto");
    softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code", permissionPolicy: "builtin:locked" });
    softwareTeamRepo.setNodePolicyProvenance(node.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/locked.policy.md",
      declaringDir: null,
      launchPosture: "floor",
    });

    const store = new NativePermissionStore(db);

    // Before explicit selection, member-level policy wins over softwareTeam
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "acceptEdits",
      source: "member_spec",
      launchPosture: "floor",
    });

    // Record explicit seat selection
    store.write(node.id, { runtime: "claude-code", mode: "full_bypass" }, "admin", "test elevation");

    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "full_bypass",
      source: "explicit",
      launchPosture: "full_bypass",
    });

    // Record explicit auto selection
    store.write(node.id, { runtime: "claude-code", mode: "auto" }, "admin", "auto mode");
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "auto",
      source: "explicit",
      permissionMode: "auto",
    });

    // Clearing explicit selection reverts to member_spec
    store.write(node.id, null, "admin", "clear");
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "acceptEdits",
      source: "member_spec",
      launchPosture: "floor",
    });
  });

  it("Level 2: member-level permission_policy resolves with member_spec source", () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code", permissionPolicy: "builtin:auto" });
    softwareTeamRepo.setNodePolicyProvenance(node.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const store = new NativePermissionStore(db);
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "auto",
      source: "member_spec",
      launchPosture: "auto",
      permissionMode: "auto",
    });
  });

  it("Precedence: member's own permission_policy is NEVER silently outranked by a software-team-wide default", () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:auto");
    softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    // Member declares builtin:locked
    const lockedNode = softwareTeamRepo.addNode(softwareTeam.id, "locked-worker", { runtime: "claude-code", permissionPolicy: "builtin:locked" });
    softwareTeamRepo.setNodePolicyProvenance(lockedNode.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/locked.policy.md",
      declaringDir: null,
      launchPosture: "floor",
    });

    // Member declares none
    const noneNode = softwareTeamRepo.addNode(softwareTeam.id, "none-worker", { runtime: "claude-code", permissionPolicy: "none" });
    softwareTeamRepo.setNodePolicyProvenance(noneNode.id, {
      origin: "deliberate_none",
      resolvedTarget: null,
      declaringDir: null,
      launchPosture: "floor",
    });

    // Member declares builtin:yolo
    const yoloNode = softwareTeamRepo.addNode(softwareTeam.id, "yolo-worker", { runtime: "claude-code", permissionPolicy: "builtin:yolo" });
    softwareTeamRepo.setNodePolicyProvenance(yoloNode.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/yolo.policy.md",
      declaringDir: null,
      launchPosture: "full_bypass",
    });

    const store = new NativePermissionStore(db);

    // Locked member retains floor acceptEdits despite softwareTeam being builtin:auto
    expect(store.resolve(lockedNode.id, "claude-code")).toEqual({
      effectiveMode: "acceptEdits",
      source: "member_spec",
      launchPosture: "floor",
    });

    // None member retains floor acceptEdits despite softwareTeam being builtin:auto
    expect(store.resolve(noneNode.id, "claude-code")).toEqual({
      effectiveMode: "acceptEdits",
      source: "member_spec",
      launchPosture: "floor",
    });

    // Yolo member retains full_bypass
    expect(store.resolve(yoloNode.id, "claude-code")).toEqual({
      effectiveMode: "full_bypass",
      source: "member_spec",
      launchPosture: "full_bypass",
    });
  });

  it("Level 3: software-team-level permission_policy: builtin:auto cascades to seats without member policy", () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:auto");
    softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const node = softwareTeamRepo.addNode(softwareTeam.id, "unspecified-worker", { runtime: "claude-code" });

    const store = new NativePermissionStore(db);
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "auto",
      source: "software_team_spec",
      launchPosture: "auto",
      permissionMode: "auto",
    });
  });

  it("Heterogeneous SoftwareTeam safety: Codex seats safely fall back to floor on a builtin:auto softwareTeam", () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("hetero-software-team");
    softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:auto");
    softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const claudeNode = softwareTeamRepo.addNode(softwareTeam.id, "claude-lead", { runtime: "claude-code" });
    const codexNode = softwareTeamRepo.addNode(softwareTeam.id, "codex-dev", { runtime: "codex" });
    const codexExplicitAuto = softwareTeamRepo.addNode(softwareTeam.id, "codex-auto", { runtime: "codex", permissionPolicy: "builtin:auto" });

    const store = new NativePermissionStore(db);

    // Claude seat gets auto
    expect(store.resolve(claudeNode.id, "claude-code")).toEqual({
      effectiveMode: "auto",
      source: "software_team_spec",
      launchPosture: "auto",
      permissionMode: "auto",
    });

    // Codex seat falls back to floor because Codex does not support --permission-mode auto
    expect(store.resolve(codexNode.id, "codex")).toEqual({
      effectiveMode: "floor",
      source: "software_team_spec",
      launchPosture: "floor",
      fallbackReason: "Codex has no auto mode and launches at the floor",
    });

    // Even if Codex member declared builtin:auto, it safely falls back to floor
    expect(store.resolve(codexExplicitAuto.id, "codex")).toEqual({
      effectiveMode: "floor",
      source: "member_spec",
      launchPosture: "floor",
      fallbackReason: "Codex has no auto mode and launches at the floor",
    });
  });

  it("Heterogeneous SoftwareTeam safety: Pi seats safely fall back to floor on a builtin:auto softwareTeam", () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("pi-hetero-software-team");
    softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:auto");
    softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const piNode = softwareTeamRepo.addNode(softwareTeam.id, "pi-dev", { runtime: "pi" });
    const piExplicitAuto = softwareTeamRepo.addNode(softwareTeam.id, "pi-auto", { runtime: "pi", permissionPolicy: "builtin:auto" });

    const store = new NativePermissionStore(db);

    expect(store.resolve(piNode.id, "pi")).toEqual({
      effectiveMode: "floor",
      source: "software_team_spec",
      launchPosture: "floor",
      fallbackReason: "Pi has no auto mode and launches at the floor",
    });

    expect(store.resolve(piExplicitAuto.id, "pi")).toEqual({
      effectiveMode: "floor",
      source: "member_spec",
      launchPosture: "floor",
      fallbackReason: "Pi has no auto mode and launches at the floor",
    });
  });

  it("Level 4: system default floor applies when neither member nor SoftwareTeam declares a policy", () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("default-software-team");
    const claudeNode = softwareTeamRepo.addNode(softwareTeam.id, "claude-seat", { runtime: "claude-code" });
    const codexNode = softwareTeamRepo.addNode(softwareTeam.id, "codex-seat", { runtime: "codex" });

    const store = new NativePermissionStore(db);

    expect(store.resolve(claudeNode.id, "claude-code")).toEqual({
      effectiveMode: "acceptEdits",
      source: "system_default",
      launchPosture: "floor",
    });

    expect(store.resolve(codexNode.id, "codex")).toEqual({
      effectiveMode: "floor",
      source: "system_default",
      launchPosture: "floor",
    });
  });

  it("Custom flag policy: policy with launch_posture: auto resolves correctly", () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("custom-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "custom-seat", { runtime: "claude-code", permissionPolicy: "policies/my-auto.policy.md" });
    softwareTeamRepo.setNodePolicyProvenance(node.id, {
      origin: "custom",
      resolvedTarget: "/workspace/policies/my-auto.policy.md",
      declaringDir: "/workspace",
      launchPosture: "auto",
    });

    const store = new NativePermissionStore(db);
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "auto",
      source: "member_spec",
      launchPosture: "auto",
      permissionMode: "auto",
    });
  });
});

describe("SoftwareTeamSpec Schema, Codec & Validation for permission_policy", () => {
  it("parses, validates and serializes permission_policy: builtin:auto in software-team.yaml", () => {
    const yaml = `
version: "0.2"
name: test-software-team
permission_policy: builtin:auto
pods:
  - id: team
    label: Team
    members:
      - id: lead
        agent_ref: local:agents/lead
        profile: default
        runtime: claude-code
        cwd: .
        permission_policy: builtin:locked
      - id: dev
        agent_ref: local:agents/dev
        profile: default
        runtime: claude-code
        cwd: .
        permission_policy: builtin:auto
    edges: []
edges: []
`;
    const parsed = SoftwareTeamSpecCodec.parse(yaml);
    const validation = SoftwareTeamSpecSchema.validate(parsed);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    const spec = SoftwareTeamSpecSchema.normalize(parsed);
    expect(spec.permissionPolicy).toBe("builtin:auto");
    expect(spec.pods[0]?.members[0]?.permissionPolicy).toBe("builtin:locked");
    expect(spec.pods[0]?.members[1]?.permissionPolicy).toBe("builtin:auto");

    const serialized = SoftwareTeamSpecCodec.serialize(spec);
    expect(serialized).toContain("permission_policy: builtin:auto");
    expect(serialized).toContain("permission_policy: builtin:locked");
  });

  it("rejects unknown built-in policies and bare un-prefixed names", () => {
    const unknownYaml = `
version: "0.2"
name: test-software-team
permission_policy: builtin:nonexistent
pods: []
edges: []
`;
    const unknownParsed = SoftwareTeamSpecCodec.parse(unknownYaml);
    const unknownValidation = SoftwareTeamSpecSchema.validate(unknownParsed);
    expect(unknownValidation.valid).toBe(false);
    expect(unknownValidation.errors.some(e => e.includes("unknown built-in policy 'nonexistent'"))).toBe(true);

    const bareYaml = `
version: "0.2"
name: test-software-team
permission_policy: auto
pods: []
edges: []
`;
    const bareParsed = SoftwareTeamSpecCodec.parse(bareYaml);
    const bareValidation = SoftwareTeamSpecSchema.validate(bareParsed);
    expect(bareValidation.valid).toBe(false);
    expect(bareValidation.errors.some(e => e.includes("is a built-in policy name — use 'builtin:auto'"))).toBe(true);
  });

  it("roundtrips permission_policy through SoftwareTeamSpecExporter", () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);

    const softwareTeam = softwareTeamRepo.createSoftwareTeam("export-software-team");
    softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:auto");
    const pod = podRepo.createPod(softwareTeam.id, "default", "Default Team");
    const node1 = softwareTeamRepo.addNode(softwareTeam.id, "agent1", { runtime: "claude-code", permissionPolicy: "builtin:locked", podId: pod.id });
    const node2 = softwareTeamRepo.addNode(softwareTeam.id, "agent2", { runtime: "claude-code", podId: pod.id });

    const exporter = new SoftwareTeamSpecExporter({ softwareTeamRepo, podRepo, sessionRegistry });
    const exported = exporter.exportSoftwareTeam(softwareTeam.id) as SoftwareTeamSpec;
    expect(exported.permissionPolicy).toBe("builtin:auto");
    expect(exported.pods[0]?.members.find(m => m.id === "agent1")?.permissionPolicy).toBe("builtin:locked");
    expect(exported.pods[0]?.members.find(m => m.id === "agent2")?.permissionPolicy).toBeUndefined();
  });
});

describe("StartupOrchestrator Declarative Integration", () => {
  it("delivers declarative permission_policy: builtin:auto to launchHarness on fresh start", async () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const registry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("start-software-team");
    softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:auto");
    softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });
    const session = registry.registerSession(node.id, "worker@start-software-team");

    const launchHarness = vi.fn(async () => ({ ok: false as const, error: "offline stop" }));
    const adapter = {
      runtime: "claude-code",
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: [], failed: [] }),
      launchHarness,
    } as unknown as RuntimeAdapter;

    const orchestrator = new StartupOrchestrator({
      db,
      sessionRegistry: registry,
      eventBus,
      tmuxAdapter: {} as TmuxAdapter,
    });

    await orchestrator.startNode({
      softwareTeamId: softwareTeam.id,
      nodeId: node.id,
      sessionId: session.id,
      binding: { ...binding(node.id), launchPosture: "auto" },
      adapter,
      plan: { entries: [] } as never,
      resolvedStartupFiles: [],
      startupActions: [],
      isRestore: false,
    });

    expect(launchHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: "auto",
        launchPosture: "auto",
      }),
      expect.anything(),
    );
  });
});

describe("Restore & Handover Continuity", () => {
  it("RestoreOrchestrator.attemptResume passes declarative auto mode to Claude resume", async () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const registry = new SessionRegistry(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("restore-software-team");
    softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:auto");
    softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });

    const resume = vi.fn(async () => ({ ok: false, code: "offline", message: "stop" }));
    const ctx = {
      db,
      softwareTeamRepo,
      sessionRegistry: registry,
      appliedLaunchStore: new AppliedLaunchObservationStore(db),
      claudeResume: { canResume: () => true, resume },
      codexResume: { canResume: () => false, resume },
    };

    const resolvedPosture = (RestoreOrchestrator.prototype as any).resolveRestorePosture.call(
      ctx,
      node.id,
      softwareTeam.id,
    );
    expect(resolvedPosture).toBe("auto");

    await (RestoreOrchestrator.prototype as any).attemptResume.call(
      ctx,
      node.id,
      "seat",
      "claude_id",
      "original",
      "/inert",
      null,
      "model",
      resolvedPosture,
    );

    expect(resume).toHaveBeenCalledWith(
      "seat",
      "claude_id",
      "original",
      "/inert",
      "auto",
      "model",
      "auto",
      node.id,
    );
  });

  describe("Restore custom policy re-reading", () => {
    it("restore re-reads custom member policy changes: floor -> full_bypass", () => {
      const db = createTestDb();
      const softwareTeamRepo = new SoftwareTeamRepository(db);
      const registry = new SessionRegistry(db);
      const softwareTeam = softwareTeamRepo.createSoftwareTeam("restore-custom-software-team");

      const dir = mkdtempSync(join(tmpdir(), "softwareteam-policy-test-"));
      try {
        const policyPath = join(dir, "member.policy.md");
        writeFileSync(policyPath, `---
source: custom
name: member-policy
surface: flag
launch_posture: floor
policy_schema_version: 1
description: Custom member policy
---
`);

        const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code", permissionPolicy: "member.policy.md" });
        softwareTeamRepo.setNodePolicyProvenance(node.id, {
          origin: "custom",
          resolvedTarget: policyPath,
          declaringDir: dir,
          launchPosture: "floor",
        });

        const resume = vi.fn(async () => ({ ok: false, code: "offline", message: "stop" }));
        const ctx = {
          db,
          softwareTeamRepo,
          sessionRegistry: registry,
          appliedLaunchStore: new AppliedLaunchObservationStore(db),
          claudeResume: { canResume: () => true, resume },
          codexResume: { canResume: () => false, resume },
        };

        // Before edit: resolves floor
        const initialPosture = (RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id);
        expect(initialPosture).toBe("floor");

        // Edit on disk: floor -> full_bypass
        writeFileSync(policyPath, `---
source: custom
name: member-policy
surface: flag
launch_posture: full_bypass
policy_schema_version: 1
description: Custom member policy
---
`);

        // Re-read during restore resolves full_bypass
        const updatedPosture = (RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id);
        expect(updatedPosture).toBe("full_bypass");

        // attemptResume uses the re-read posture instead of launch DB columns
        (RestoreOrchestrator.prototype as any).attemptResume.call(
          ctx,
          node.id,
          "seat",
          "claude_id",
          "original",
          "/inert",
          null,
          "model",
          updatedPosture,
        );

        expect(resume).toHaveBeenCalledWith(
          "seat",
          "claude_id",
          "original",
          "/inert",
          "full_bypass",
          "model",
          undefined,
          node.id,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("restore re-reads custom member policy changes: full_bypass -> floor", () => {
      const db = createTestDb();
      const softwareTeamRepo = new SoftwareTeamRepository(db);
      const registry = new SessionRegistry(db);
      const softwareTeam = softwareTeamRepo.createSoftwareTeam("restore-custom-software-team");

      const dir = mkdtempSync(join(tmpdir(), "softwareteam-policy-test-"));
      try {
        const policyPath = join(dir, "member.policy.md");
        writeFileSync(policyPath, `---
source: custom
name: member-policy
surface: flag
launch_posture: full_bypass
policy_schema_version: 1
description: Custom member policy
---
`);

        const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code", permissionPolicy: "member.policy.md" });
        softwareTeamRepo.setNodePolicyProvenance(node.id, {
          origin: "custom",
          resolvedTarget: policyPath,
          declaringDir: dir,
          launchPosture: "full_bypass",
        });

        const resume = vi.fn(async () => ({ ok: false, code: "offline", message: "stop" }));
        const ctx = {
          db,
          softwareTeamRepo,
          sessionRegistry: registry,
          appliedLaunchStore: new AppliedLaunchObservationStore(db),
          claudeResume: { canResume: () => true, resume },
          codexResume: { canResume: () => false, resume },
        };

        // Before edit: resolves full_bypass
        const initialPosture = (RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id);
        expect(initialPosture).toBe("full_bypass");

        // Edit on disk: full_bypass -> floor
        writeFileSync(policyPath, `---
source: custom
name: member-policy
surface: flag
launch_posture: floor
policy_schema_version: 1
description: Custom member policy
---
`);

        // Re-read during restore resolves floor
        const updatedPosture = (RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id);
        expect(updatedPosture).toBe("floor");

        // attemptResume uses the re-read posture instead of launch DB columns
        (RestoreOrchestrator.prototype as any).attemptResume.call(
          ctx,
          node.id,
          "seat",
          "claude_id",
          "original",
          "/inert",
          null,
          "model",
          updatedPosture,
        );

        expect(resume).toHaveBeenCalledWith(
          "seat",
          "claude_id",
          "original",
          "/inert",
          "floor",
          "model",
          undefined,
          node.id,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("restore re-reads software-team-level custom policy changes", () => {
      const db = createTestDb();
      const softwareTeamRepo = new SoftwareTeamRepository(db);
      const registry = new SessionRegistry(db);
      const softwareTeam = softwareTeamRepo.createSoftwareTeam("restore-software-team-policy");

      const dir = mkdtempSync(join(tmpdir(), "softwareteam-policy-test-"));
      try {
        const policyPath = join(dir, "softwareTeam.policy.md");
        writeFileSync(policyPath, `---
source: custom
name: software-team-policy
surface: flag
launch_posture: floor
policy_schema_version: 1
description: Custom SoftwareTeam policy
---
`);

        softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "softwareTeam.policy.md");
        softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
          origin: "custom",
          resolvedTarget: policyPath,
          declaringDir: dir,
          launchPosture: "floor",
        });

        // Member without its own policy inherits from softwareTeam
        const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });

        const resume = vi.fn(async () => ({ ok: false, code: "offline", message: "stop" }));
        const ctx = {
          db,
          softwareTeamRepo,
          sessionRegistry: registry,
          appliedLaunchStore: new AppliedLaunchObservationStore(db),
          claudeResume: { canResume: () => true, resume },
          codexResume: { canResume: () => false, resume },
        };

        // Before edit: resolves floor
        const initialPosture = (RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id);
        expect(initialPosture).toBe("floor");

        // Edit on disk: floor -> full_bypass
        writeFileSync(policyPath, `---
source: custom
name: software-team-policy
surface: flag
launch_posture: full_bypass
policy_schema_version: 1
description: Custom SoftwareTeam policy
---
`);

        // Re-read during restore resolves full_bypass
        const updatedPosture = (RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id);
        expect(updatedPosture).toBe("full_bypass");

        (RestoreOrchestrator.prototype as any).attemptResume.call(
          ctx,
          node.id,
          "seat",
          "claude_id",
          "original",
          "/inert",
          null,
          "model",
          updatedPosture,
        );

        expect(resume).toHaveBeenCalledWith(
          "seat",
          "claude_id",
          "original",
          "/inert",
          "full_bypass",
          "model",
          undefined,
          node.id,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("pod-aware restore startNode preserves re-read member policy: floor -> full_bypass", async () => {
      const db = createTestDb();
      const softwareTeamRepo = new SoftwareTeamRepository(db);
      const registry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const softwareTeam = softwareTeamRepo.createSoftwareTeam("restore-custom-software-team");

      const dir = mkdtempSync(join(tmpdir(), "softwareteam-policy-test-"));
      try {
        const policyPath = join(dir, "member.policy.md");
        writeFileSync(policyPath, `---
source: custom
name: member-policy
surface: flag
launch_posture: floor
policy_schema_version: 1
description: Custom member policy
---
`);

        const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code", permissionPolicy: "member.policy.md" });
        softwareTeamRepo.setNodePolicyProvenance(node.id, {
          origin: "custom",
          resolvedTarget: policyPath,
          declaringDir: dir,
          launchPosture: "floor",
        });
        const session = registry.registerSession(node.id, "worker@restore-custom-software-team");

        const ctx = {
          db,
          softwareTeamRepo,
          sessionRegistry: registry,
          appliedLaunchStore: new AppliedLaunchObservationStore(db),
        };

        // Before edit: resolves floor
        expect((RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id)).toBe("floor");

        // Edit on disk: floor -> full_bypass
        writeFileSync(policyPath, `---
source: custom
name: member-policy
surface: flag
launch_posture: full_bypass
policy_schema_version: 1
description: Custom member policy
---
`);

        // Re-read during restore resolves full_bypass
        const updatedPosture = (RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id);
        expect(updatedPosture).toBe("full_bypass");

        // Pod-aware restore calls startNode with binding.launchPosture = updatedPosture
        const launchHarness = vi.fn(async () => ({ ok: false as const, error: "offline stop" }));
        const adapter = {
          runtime: "claude-code",
          project: async () => ({ projected: [], skipped: [], failed: [] }),
          deliverStartup: async () => ({ delivered: [], failed: [] }),
          launchHarness,
        } as unknown as RuntimeAdapter;

        const startupOrch = new StartupOrchestrator({
          db,
          sessionRegistry: registry,
          eventBus,
          tmuxAdapter: {} as TmuxAdapter,
        });

        await startupOrch.startNode({
          softwareTeamId: softwareTeam.id,
          nodeId: node.id,
          sessionId: session.id,
          binding: {
            ...binding(node.id),
            launchPosture: updatedPosture,
          },
          adapter,
          plan: { entries: [] } as never,
          resolvedStartupFiles: [],
          startupActions: [],
          isRestore: true,
        });

        // startNode's NativePermissionStore.apply() MUST preserve re-read launchPosture instead of replacing with initial launch DB column
        expect(launchHarness).toHaveBeenCalledWith(
          expect.objectContaining({
            launchPosture: "full_bypass",
          }),
          expect.anything(),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("pod-aware restore startNode preserves re-read member policy: full_bypass -> floor", async () => {
      const db = createTestDb();
      const softwareTeamRepo = new SoftwareTeamRepository(db);
      const registry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const softwareTeam = softwareTeamRepo.createSoftwareTeam("restore-custom-software-team");

      const dir = mkdtempSync(join(tmpdir(), "softwareteam-policy-test-"));
      try {
        const policyPath = join(dir, "member.policy.md");
        writeFileSync(policyPath, `---
source: custom
name: member-policy
surface: flag
launch_posture: full_bypass
policy_schema_version: 1
description: Custom member policy
---
`);

        const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code", permissionPolicy: "member.policy.md" });
        softwareTeamRepo.setNodePolicyProvenance(node.id, {
          origin: "custom",
          resolvedTarget: policyPath,
          declaringDir: dir,
          launchPosture: "full_bypass",
        });
        const session = registry.registerSession(node.id, "worker@restore-custom-software-team");

        const ctx = {
          db,
          softwareTeamRepo,
          sessionRegistry: registry,
          appliedLaunchStore: new AppliedLaunchObservationStore(db),
        };

        // Before edit: resolves full_bypass
        expect((RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id)).toBe("full_bypass");

        // Edit on disk: full_bypass -> floor
        writeFileSync(policyPath, `---
source: custom
name: member-policy
surface: flag
launch_posture: floor
policy_schema_version: 1
description: Custom member policy
---
`);

        // Re-read during restore resolves floor
        const updatedPosture = (RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id);
        expect(updatedPosture).toBe("floor");

        // Pod-aware restore calls startNode with binding.launchPosture = updatedPosture
        const launchHarness = vi.fn(async () => ({ ok: false as const, error: "offline stop" }));
        const adapter = {
          runtime: "claude-code",
          project: async () => ({ projected: [], skipped: [], failed: [] }),
          deliverStartup: async () => ({ delivered: [], failed: [] }),
          launchHarness,
        } as unknown as RuntimeAdapter;

        const startupOrch = new StartupOrchestrator({
          db,
          sessionRegistry: registry,
          eventBus,
          tmuxAdapter: {} as TmuxAdapter,
        });

        await startupOrch.startNode({
          softwareTeamId: softwareTeam.id,
          nodeId: node.id,
          sessionId: session.id,
          binding: {
            ...binding(node.id),
            launchPosture: updatedPosture,
          },
          adapter,
          plan: { entries: [] } as never,
          resolvedStartupFiles: [],
          startupActions: [],
          isRestore: true,
        });

        // startNode's NativePermissionStore.apply() MUST preserve re-read launchPosture
        expect(launchHarness).toHaveBeenCalledWith(
          expect.objectContaining({
            launchPosture: "floor",
          }),
          expect.anything(),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("pod-aware restore startNode preserves re-read software-team-level custom policy changes", async () => {
      const db = createTestDb();
      const softwareTeamRepo = new SoftwareTeamRepository(db);
      const registry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const softwareTeam = softwareTeamRepo.createSoftwareTeam("restore-software-team-policy");

      const dir = mkdtempSync(join(tmpdir(), "softwareteam-policy-test-"));
      try {
        const policyPath = join(dir, "softwareTeam.policy.md");
        writeFileSync(policyPath, `---
source: custom
name: software-team-policy
surface: flag
launch_posture: floor
policy_schema_version: 1
description: Custom SoftwareTeam policy
---
`);

        softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "softwareTeam.policy.md");
        softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
          origin: "custom",
          resolvedTarget: policyPath,
          declaringDir: dir,
          launchPosture: "floor",
        });

        // Member without its own policy inherits from softwareTeam
        const node = softwareTeamRepo.addNode(softwareTeam.id, "worker", { runtime: "claude-code" });
        const session = registry.registerSession(node.id, "worker@restore-software-team-policy");

        const ctx = {
          db,
          softwareTeamRepo,
          sessionRegistry: registry,
          appliedLaunchStore: new AppliedLaunchObservationStore(db),
        };

        // Before edit: resolves floor
        expect((RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id)).toBe("floor");

        // Edit on disk: floor -> full_bypass
        writeFileSync(policyPath, `---
source: custom
name: software-team-policy
surface: flag
launch_posture: full_bypass
policy_schema_version: 1
description: Custom SoftwareTeam policy
---
`);

        // Re-read during restore resolves full_bypass
        const updatedPosture = (RestoreOrchestrator.prototype as any).resolveRestorePosture.call(ctx, node.id, softwareTeam.id);
        expect(updatedPosture).toBe("full_bypass");

        const launchHarness = vi.fn(async () => ({ ok: false as const, error: "offline stop" }));
        const adapter = {
          runtime: "claude-code",
          project: async () => ({ projected: [], skipped: [], failed: [] }),
          deliverStartup: async () => ({ delivered: [], failed: [] }),
          launchHarness,
        } as unknown as RuntimeAdapter;

        const startupOrch = new StartupOrchestrator({
          db,
          sessionRegistry: registry,
          eventBus,
          tmuxAdapter: {} as TmuxAdapter,
        });

        await startupOrch.startNode({
          softwareTeamId: softwareTeam.id,
          nodeId: node.id,
          sessionId: session.id,
          binding: {
            ...binding(node.id),
            launchPosture: updatedPosture,
          },
          adapter,
          plan: { entries: [] } as never,
          resolvedStartupFiles: [],
          startupActions: [],
          isRestore: true,
        });

        expect(launchHarness).toHaveBeenCalledWith(
          expect.objectContaining({
            launchPosture: "full_bypass",
          }),
          expect.anything(),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("SeatHandoverService passes declarative auto mode to successor launcher", async () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const registry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const discoveryRepo = new DiscoveryRepository(db);

    const softwareTeam = softwareTeamRepo.createSoftwareTeam("handover-software-team");
    softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:auto");
    softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const node = softwareTeamRepo.addNode(softwareTeam.id, "incumbent-seat", { runtime: "claude-code", cwd: "/test" });
    const incumbentSession = registry.registerSession(node.id, "incumbent-seat@handover-software-team");

    const createSuccessor = vi.fn(async () => ({
      ok: false as const,
      code: "test_stop",
      step: "create_successor" as const,
      message: "test stop — only asserting call args",
      replacementStarted: false,
    }));

    const handoverService = new SeatHandoverService({
      db,
      softwareTeamRepo,
      sessionRegistry: registry,
      discoveryRepo,
      eventBus,
      successorLauncher: { createSuccessor } as any,
      tmuxAdapter: { capturePaneScreen: vi.fn(async () => "") } as any,
    });

    // Provide departing occupant
    softwareTeamRepo.recordHandoverResult?.(node.id, "resumed");

    const result = await handoverService.handover({
      seatRef: "incumbent-seat@handover-software-team",
      reason: "rotation",
      operator: "test",
      source: "fresh",
    });

    expect(createSuccessor).toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({
          launchPosture: "auto",
          permissionMode: "auto",
        }),
      }),
    );
  });
});

describe("SeatStatusService Provenance Reporting", () => {
  it("reports honest effective permission provenance across cascade levels", () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const registry = new SessionRegistry(db);

    const softwareTeam = softwareTeamRepo.createSoftwareTeam("provenance-software-team");
    softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:auto");
    softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const memberNode = softwareTeamRepo.addNode(softwareTeam.id, "member-seat", { runtime: "claude-code", permissionPolicy: "builtin:locked" });
    softwareTeamRepo.setNodePolicyProvenance(memberNode.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/locked.policy.md",
      declaringDir: null,
      launchPosture: "floor",
    });

    const softwareTeamNode = softwareTeamRepo.addNode(softwareTeam.id, "software-team-seat", { runtime: "claude-code" });
    registry.registerSession(memberNode.id, "member-seat@provenance-software-team");
    registry.registerSession(softwareTeamNode.id, "software-team-seat@provenance-software-team");

    const statusService = new SeatStatusService({ softwareTeamRepo });

    // Member-level provenance: member's own builtin:locked is NOT outranked by softwareTeam
    const memberStatus = statusService.getStatus("member-seat@provenance-software-team");
    expect(memberStatus).toMatchObject({
      ok: true,
      status: {
        permissions: {
          selectionState: "inherit",
          effective: {
            effectiveMode: "acceptEdits",
            source: "member_spec",
            launchPosture: "floor",
          },
        },
      },
    });

    // SoftwareTeam-level provenance: inherits auto from softwareTeam
    const softwareTeamStatus = statusService.getStatus("software-team-seat@provenance-software-team");
    expect(softwareTeamStatus).toMatchObject({
      ok: true,
      status: {
        permissions: {
          selectionState: "inherit",
          effective: {
            effectiveMode: "auto",
            source: "software_team_spec",
            launchPosture: "auto",
            permissionMode: "auto",
          },
        },
      },
    });

    // Explicit override provenance
    const store = new NativePermissionStore(db);
    store.write(softwareTeamNode.id, { runtime: "claude-code", mode: "full_bypass" }, "admin", "test");
    const explicitStatus = statusService.getStatus("software-team-seat@provenance-software-team");
    expect(explicitStatus).toMatchObject({
      ok: true,
      status: {
        permissions: {
          selectionState: "explicit",
          effective: {
            effectiveMode: "full_bypass",
            source: "explicit",
            launchPosture: "full_bypass",
          },
        },
      },
    });
  });

  it("reports fallbackReason for Codex and Pi seats inheriting or declaring builtin:auto", () => {
    const db = createTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const registry = new SessionRegistry(db);

    const softwareTeam = softwareTeamRepo.createSoftwareTeam("fallback-software-team");
    softwareTeamRepo.setSoftwareTeamPermissionPolicy(softwareTeam.id, "builtin:auto");
    softwareTeamRepo.setSoftwareTeamPolicyProvenance(softwareTeam.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const codexNode = softwareTeamRepo.addNode(softwareTeam.id, "codex-seat", { runtime: "codex" });
    const piNode = softwareTeamRepo.addNode(softwareTeam.id, "pi-seat", { runtime: "pi" });
    registry.registerSession(codexNode.id, "codex-seat@fallback-software-team");
    registry.registerSession(piNode.id, "pi-seat@fallback-software-team");

    const statusService = new SeatStatusService({ softwareTeamRepo });

    const codexStatus = statusService.getStatus("codex-seat@fallback-software-team");
    expect(codexStatus).toMatchObject({
      ok: true,
      status: {
        permissions: {
          selectionState: "inherit",
          effective: {
            effectiveMode: "floor",
            source: "software_team_spec",
            launchPosture: "floor",
            fallbackReason: "Codex has no auto mode and launches at the floor",
          },
        },
      },
    });

    const piStatus = statusService.getStatus("pi-seat@fallback-software-team");
    expect(piStatus).toMatchObject({
      ok: true,
      status: {
        permissions: {
          selectionState: "inherit",
          effective: {
            effectiveMode: "floor",
            source: "software_team_spec",
            launchPosture: "floor",
            fallbackReason: "Pi has no auto mode and launches at the floor",
          },
        },
      },
    });
  });
});
