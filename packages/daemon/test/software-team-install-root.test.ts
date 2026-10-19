import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { softwareTeamInstallRootSchema } from "../src/db/migrations/096_software_team_install_root.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";

describe("SoftwareTeam installation folder persistence", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  it("upgrades an existing database without inventing roots and survives reopen/archive/unarchive", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "software-team-install-root-")); roots.push(root);
    const file = path.join(root, "state.sqlite");
    let db = createDb(file);
    try {
      migrate(db, ALL_MIGRATIONS.filter(m => m.name !== softwareTeamInstallRootSchema.name));
      const old = new SoftwareTeamRepository(db).createSoftwareTeam("workshop");
      migrate(db, ALL_MIGRATIONS);
      migrate(db, ALL_MIGRATIONS);
      const repo = new SoftwareTeamRepository(db);
      expect(repo.getSoftwareTeamInstallRoot(old.id)).toBeNull();
      const installed = repo.createSoftwareTeam("workshop", root);
      repo.archiveSoftwareTeam(installed.id);
      db.close(); db = createDb(file);
      const reopened = new SoftwareTeamRepository(db);
      expect(reopened.getSoftwareTeamInstallRoot(old.id)).toBeNull();
      expect(reopened.getSoftwareTeamInstallRoot(installed.id)).toBe(root);
      reopened.unarchiveSoftwareTeam(installed.id);
      expect(reopened.getSoftwareTeamInstallRoot(installed.id)).toBe(root);
      expect(reopened.getSoftwareTeamInstallRoot(reopened.createSoftwareTeam("local-spec").id)).toBeNull();
    } finally { db.close(); }
  });
});
