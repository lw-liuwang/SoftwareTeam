// The person-facing `softwareTeams` skill lives at skills/softwareTeams, where skills.sh finds it. The package carries one copy at
// packages/daemon/assets/skills/softwareTeams, which the daemon installs globally under SoftwareTeam's own version. It isn't an
// softwareteam-core plugin skill, so it stays out of seat loadouts and the softwareteam-skills index.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { createDaemon } from "../src/startup.js";
import { getDaemonVersion } from "../src/domain/daemon-version.js";
import { PluginVendorService } from "../src/domain/plugin-vendor-service.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SOURCE = join(REPO_ROOT, "skills/software-teams");
const PACKAGED = resolve(import.meta.dirname, "../assets/skills/software-teams");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const files = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
  .sort();

describe("the softwareTeams skill installed globally", () => {
  it("ships one packaged copy, byte-identical to skills/software-teams", () => {
    expect(files(PACKAGED)).toEqual(files(SOURCE));
    for (const name of files(SOURCE)) {
      expect(readFileSync(join(PACKAGED, name)), `copy ${name} from skills/softwareTeams to packages/daemon/assets/skills/software-teams`)
        .toEqual(readFileSync(join(SOURCE, name)));
    }
  });

  it("is not an softwareteam-core plugin skill", () => {
    expect(existsSync(resolve(import.meta.dirname, "../assets/plugins/softwareteam-core/skills/software-teams"))).toBe(false);
  });

  it("startup installs it for both harnesses under SoftwareTeam's version, and leaves a skills.sh copy alone", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "software-teams-global-"));
    roots.push(root);
    const skillsSh = join(root, ".agents/skills/software-teams");
    mkdirSync(skillsSh, { recursive: true });
    writeFileSync(join(skillsSh, "SKILL.md"), "# softwareTeams, installed by skills.sh\n");
    vi.stubEnv("SOFTWARETEAM_HOME", root);
    vi.stubEnv("SOFTWARETEAM_NO_KERNEL", "1");
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.spyOn(PluginVendorService.prototype, "attemptAutoFetch").mockResolvedValue();

    const { db } = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "", cmuxFactory: async () => { throw new Error("inert fixture"); } });
    try {
      const claude = join(root, ".claude/skills/software-teams");
      expect(readFileSync(join(claude, "SKILL.md"))).toEqual(readFileSync(join(PACKAGED, "SKILL.md")));
      expect(readFileSync(join(claude, ".softwareteam-vendor-version"), "utf8")).toBe(`${getDaemonVersion()}\n`);
      expect(readFileSync(join(skillsSh, "SKILL.md"), "utf8")).toBe("# softwareTeams, installed by skills.sh\n");
      expect(existsSync(join(skillsSh, ".softwareteam-vendor-version"))).toBe(false);
    } finally { db.close(); }
  });
});
