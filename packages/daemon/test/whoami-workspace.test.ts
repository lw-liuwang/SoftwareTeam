// PL-007 Workspace Primitive v0 — whoami workspace block tests.
//
// Pins:
//   - whoami returns workspace block populated when softwareTeam has workspace
//     declared via setSoftwareTeamWorkspace
//   - whoami returns workspace=null when softwareTeam has no workspace
//   - back-compat: legacy fixture without migration 038 returns null
//   - per-node workspace.activeRepo resolves from cwd against repos[]

import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { workspacePrimitiveSchema } from "../src/db/migrations/038_workspace_primitive.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";

let db: Database.Database;
let softwareTeamRepo: SoftwareTeamRepository;
let whoami: WhoamiService;

function makeFixture(withWorkspaceMigration: boolean): void {
  db = createDb();
  const migs = [
    coreSchema,
    bindingsSessionsSchema,
    eventsSchema,
    snapshotsSchema,
    checkpointsSchema,
    resumeMetadataSchema,
    nodeSpecFieldsSchema,
    agentspecRebootSchema,
    podNamespaceSchema,
    externalCliAttachmentSchema,
  ];
  if (withWorkspaceMigration) migs.push(workspacePrimitiveSchema);
  migrate(db, migs);
  softwareTeamRepo = new SoftwareTeamRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const transcriptStore = new TranscriptStore({ enabled: false, baseDir: "/tmp" });
  whoami = new WhoamiService({ db, softwareTeamRepo, sessionRegistry, transcriptStore });
}

beforeEach(() => makeFixture(true));

describe("whoami workspace block (PL-007)", () => {
  it("returns workspace block when SoftwareTeam has workspace declared", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("alpha-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code", cwd: "/Users/op/hub/main/sub" });
    softwareTeamRepo.setSoftwareTeamWorkspace(softwareTeam.id, {
      workspaceRoot: "/Users/op/hub",
      repos: [
        { name: "main", path: "/Users/op/hub/main", kind: "project" },
      ],
      defaultRepo: "main",
      knowledgeRoot: "/Users/op/knowledge",
    });

    const result = whoami.resolve({ nodeId: node.id });
    expect(result).not.toBeNull();
    expect(result?.workspace).toBeDefined();
    expect(result?.workspace?.workspaceRoot).toBe("/Users/op/hub");
    expect(result?.workspace?.activeRepo).toBe("main");
    expect(result?.workspace?.knowledgeKind).toBe("knowledge");
  });

  it("honors caller-supplied target repo override for CLI-scoped whoami", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("alpha-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code", cwd: "/Users/op/hub/main/sub" });
    softwareTeamRepo.setSoftwareTeamWorkspace(softwareTeam.id, {
      workspaceRoot: "/Users/op/hub",
      repos: [
        { name: "main", path: "/Users/op/hub/main", kind: "project" },
        { name: "internal", path: "/Users/op/hub/internal", kind: "project" },
      ],
      defaultRepo: "main",
    });

    const result = whoami.resolve({ nodeId: node.id, targetRepoOverride: "internal" });
    expect(result?.workspace?.activeRepo).toBe("internal");
  });

  it("returns workspace=null when SoftwareTeam has no workspace declared", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("plain-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code", cwd: "/x" });

    const result = whoami.resolve({ nodeId: node.id });
    expect(result?.workspace).toBeNull();
  });

  it("back-compat: legacy fixture without migration 038 surfaces workspace=null (no throws)", () => {
    makeFixture(false);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("legacy-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code", cwd: "/x" });
    // setSoftwareTeamWorkspace is a no-op when column absent
    softwareTeamRepo.setSoftwareTeamWorkspace(softwareTeam.id, {
      workspaceRoot: "/Users/op/hub",
      repos: [{ name: "main", path: "/Users/op/hub/main", kind: "project" }],
    });

    const result = whoami.resolve({ nodeId: node.id });
    expect(result?.workspace).toBeNull();
  });
});
