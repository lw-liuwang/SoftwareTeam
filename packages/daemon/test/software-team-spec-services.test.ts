import { describe, it, expect } from "vitest";
import path from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { SoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { deriveComposeProjectName } from "../src/domain/compose-project-name.js";
import { migrate } from "../src/db/migrate.js";
import { softwareTeamServicesSchema } from "../src/db/migrations/020_software_team_services.js";
import type { SoftwareTeamSpec, SoftwareTeamServicesRecordInput } from "../src/domain/types.js";

const VALID_SOFTWARE_TEAM_WITH_SERVICES = {
  version: "0.2",
  name: "services-software-team",
  pods: [
    {
      id: "dev",
      label: "Development",
      members: [
        {
          id: "impl",
          agent_ref: "local:agents/development/implementer",
          profile: "default",
          runtime: "claude-code",
          cwd: ".",
        },
      ],
      edges: [],
    },
  ],
  edges: [],
  services: {
    kind: "compose",
    compose_file: "./compose.yaml",
    project_name: "services-software-team",
    profiles: ["core"],
    down_policy: "down",
    wait_for: [
      { service: "vault", condition: "healthy" },
      { url: "http://127.0.0.1:3000/healthz" },
      { tcp: "127.0.0.1:5432" },
    ],
    surfaces: {
      urls: [{ name: "app", url: "http://127.0.0.1:3000" }],
      commands: [{ name: "psql", command: "psql postgresql://app:dev@127.0.0.1:5432/app" }],
    },
    checkpoints: [
      {
        id: "vault",
        export: "docker compose exec -T vault vault status",
        import: "docker compose exec -T vault vault status",
      },
    ],
  },
};

function createServicesDb() {
  const db = createFullTestDb();
  migrate(db, [softwareTeamServicesSchema]);
  return db;
}

describe("SoftwareTeamSpec services contract", () => {
  it("rejects non-compose services kinds", () => {
    const softwareTeam = structuredClone(VALID_SOFTWARE_TEAM_WITH_SERVICES) as Record<string, unknown>;
    (softwareTeam.services as Record<string, unknown>).kind = "kubernetes";

    const result = SoftwareTeamSpecSchema.validate(softwareTeam);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("services.kind") && e.includes("compose"))).toBe(true);
  });

  it("normalize preserves the services block", () => {
    const normalized = SoftwareTeamSpecSchema.normalize(structuredClone(VALID_SOFTWARE_TEAM_WITH_SERVICES) as Record<string, unknown>);

    expect(normalized.services).toBeDefined();
    expect(normalized.services.kind).toBe("compose");
    expect(normalized.services.composeFile).toBe("./compose.yaml");
    expect(normalized.services.projectName).toBe("services-software-team");
    expect(normalized.services.downPolicy).toBe("down");
    expect(normalized.services.waitFor).toHaveLength(3);
    expect(normalized.services.waitFor[2].tcp).toBe("127.0.0.1:5432");
    expect(normalized.services.surfaces.urls[0].name).toBe("app");
    expect(normalized.services.checkpoints[0].id).toBe("vault");
  });

  it("defaults project_name deterministically from the SoftwareTeam name when omitted", () => {
    const softwareTeam = structuredClone(VALID_SOFTWARE_TEAM_WITH_SERVICES) as Record<string, unknown>;
    delete (softwareTeam.services as Record<string, unknown>).project_name;
    softwareTeam.name = "Demo SoftwareTeam / V1";

    const validated = SoftwareTeamSpecSchema.validate(softwareTeam);
    expect(validated.valid).toBe(true);

    const normalized = SoftwareTeamSpecSchema.normalize(softwareTeam) as SoftwareTeamSpec;
    expect(normalized.services.projectName).toBe("demo-softwareteam-v1");
  });

  it("rejects invalid explicit project_name values", () => {
    const softwareTeam = structuredClone(VALID_SOFTWARE_TEAM_WITH_SERVICES) as Record<string, unknown>;
    (softwareTeam.services as Record<string, unknown>).project_name = "Bad Project Name!";

    const result = SoftwareTeamSpecSchema.validate(softwareTeam);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("services.project_name") && e.includes("match"))).toBe(true);
  });

  it("SoftwareTeamRepository persists and updates a services record", () => {
    const db = createServicesDb();
    const repo = new SoftwareTeamRepository(db);
    const softwareTeam = repo.createSoftwareTeam("services-software-team");

    const initial: SoftwareTeamServicesRecordInput = {
      kind: "compose" as const,
      specJson: JSON.stringify(VALID_SOFTWARE_TEAM_WITH_SERVICES.services),
      softwareTeamRoot: "/tmp/services-software-team",
      composeFile: "/tmp/services-software-team/compose.yaml",
      latestReceiptJson: null,
    };

    const stored = repo.setServicesRecord(softwareTeam.id, initial);
    expect(stored.softwareTeamId).toBe(softwareTeam.id);
    expect(stored.composeFile).toBe(path.resolve("/tmp/services-software-team/compose.yaml"));
    expect(stored.projectName).toBe(deriveComposeProjectName(softwareTeam.id));

    const fetched = repo.getServicesRecord(softwareTeam.id);
    expect(fetched).not.toBeNull();
    if (!fetched) throw new Error("expected services record");
    expect(fetched.softwareTeamId).toBe(softwareTeam.id);
    expect(fetched.specJson).toContain('"compose"');

    const updated = repo.updateServicesReceipt(softwareTeam.id, JSON.stringify({ status: "healthy" }));
    expect(updated).not.toBeNull();
    if (!updated) throw new Error("expected updated services record");
    expect(updated.latestReceiptJson).toContain("healthy");

    const fetchedAgain = repo.getServicesRecord(softwareTeam.id);
    expect(fetchedAgain).not.toBeNull();
    if (!fetchedAgain) throw new Error("expected fetched services record");
    expect(fetchedAgain.latestReceiptJson).toContain("healthy");

    db.close();
  });

  it("keeps omitted defaults distinct for names that sanitize to the same slug", () => {
    const db = createServicesDb();
    try {
      const repo = new SoftwareTeamRepository(db);
      const first = repo.createSoftwareTeam("Demo / SoftwareTeam");
      const second = repo.createSoftwareTeam("Demo - SoftwareTeam");
      const input = {
        kind: "compose" as const,
        specJson: "{}",
        softwareTeamRoot: "/tmp/services-software-team",
        composeFile: "/tmp/services-software-team/compose.yaml",
      };
      expect(deriveComposeProjectName(first.name)).toBe(deriveComposeProjectName(second.name));
      const a = repo.setServicesRecord(first.id, input);
      const b = repo.setServicesRecord(second.id, input);
      expect(a.projectName).not.toBe(b.projectName);
      expect(repo.setServicesRecord(first.id, input).projectName).toBe(a.projectName);
      expect(repo.setServicesRecord(second.id, { ...input, projectName: "explicit-project" }).projectName)
        .toBe("explicit-project");
    } finally {
      db.close();
    }
  });

  it("preserves a legacy project's identity when updating without a project name", () => {
    const db = createServicesDb();
    try {
      const repo = new SoftwareTeamRepository(db);
      const softwareTeam = repo.createSoftwareTeam("services-software-team");
      const input = { kind: "compose" as const, specJson: "{}", softwareTeamRoot: "/tmp/services-software-team", composeFile: "compose.yaml" };
      repo.setServicesRecord(softwareTeam.id, { ...input, projectName: "legacy-name-derived-project" });
      expect(repo.setServicesRecord(softwareTeam.id, { ...input, latestReceiptJson: "{}" }).projectName)
        .toBe("legacy-name-derived-project");
      expect(repo.setServicesRecord(softwareTeam.id, { ...input, projectName: "replacement" }).projectName).toBe("replacement");
    } finally { db.close(); }
  });

  it("createDaemon wires the software_team_services migration", async () => {
    const { createDaemon } = await import("../src/startup.js");
    const { db } = await createDaemon({ dbPath: ":memory:" });

    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toContain("software_team_services");
    } finally {
      db.close();
    }
  });
});
