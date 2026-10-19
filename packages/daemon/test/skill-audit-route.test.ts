// #802: GET /api/skills/audit on a clean-install fixture. The bundled softwareteam-skills copies are projected
// into ~/.claude/skills and ~/.agents/skills from the installed softwareteam-core plugin, and the mirror check
// sees the installed-package layout instead of a source checkout.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsRoutes } from "../src/routes/skills.js";

const SKILL = "---\nname: softwareteam-skills\ndescription: index\nmetadata:\n  softwareteam:\n    stage: shipped\n---\n\n# index\n";

interface AuditBody {
  ok: boolean;
  totalFindings: number;
  mirrorDriftError?: string;
  mirrorDriftSkipped?: string;
  entries: Array<{ path: string; sourceKind: string; shadowed: boolean; bundledFrom: { plugin: string; version: string } | null; findings: unknown[] }>;
}

describe("GET /api/skills/audit on a clean-install fixture (#802)", () => {
  let root: string;
  let home: string;
  let pluginsDir: string;
  let installedPackageRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-audit-route-"));
    home = join(root, "home");
    pluginsDir = join(root, "softwareteam-home/plugins");
    // node_modules/@softwareteam/ as the published daemon resolves it: no scripts/mirror-skills.mjs.
    installedPackageRoot = join(root, "node_modules/@softwareteam");
    mkdirSync(join(installedPackageRoot, "cli/daemon/specs/agents/shared/skills"), { recursive: true });

    const plugin = join(pluginsDir, "softwareteam-core");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "softwareteam-core", version: "0.1.4" }));
    mkdirSync(join(plugin, "skills/softwareteam-skills"), { recursive: true });
    writeFileSync(join(plugin, "skills/softwareteam-skills/SKILL.md"), SKILL);
    for (const runtimeDir of [".claude", ".agents"]) {
      const copy = join(home, runtimeDir, "skills/softwareteam-skills");
      mkdirSync(copy, { recursive: true });
      writeFileSync(join(copy, "SKILL.md"), SKILL);
      writeFileSync(join(copy, ".softwareteam-vendor-version"), "0.1.4\n");
    }
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  async function audit(): Promise<AuditBody> {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("skillLibraryDiscoveryService" as never, {} as never);
      c.set("homedir" as never, home as never);
      // The report's daemon ran from $HOME, so its projected copies were discovered as software_team_bundled.
      c.set("cwd" as never, home as never);
      c.set("pluginsDir" as never, pluginsDir as never);
      c.set("mirrorRepoRoot" as never, installedPackageRoot as never);
      await next();
    });
    app.route("/api/skills", skillsRoutes());
    const res = await app.request("/api/skills/audit");
    expect(res.status).toBe(200);
    return await res.json() as AuditBody;
  }

  it("reports no findings and no mirror error for SoftwareTeam's own bundled copies", async () => {
    const body = await audit();
    expect(body.totalFindings).toBe(0);
    expect(body.mirrorDriftError).toBeUndefined();
    expect(body.mirrorDriftSkipped).toContain("source checkout");
    // With cwd = $HOME the Claude root is scanned twice; the second sighting is reported as shadowed.
    expect(body.entries.filter((e) => !e.shadowed).map((e) => e.path).sort()).toEqual([
      join(home, ".agents/skills/softwareteam-skills"),
      join(home, ".claude/skills/softwareteam-skills"),
    ]);
    for (const entry of body.entries) {
      expect(entry.sourceKind).toBe("software_team_bundled");
      expect(entry.bundledFrom).toEqual({ plugin: "softwareteam-core", version: "0.1.4" });
      expect(entry.findings).toEqual([]);
    }
  });

  it("still reports findings for a copy edited locally", async () => {
    appendFileSync(join(home, ".claude/skills/softwareteam-skills/SKILL.md"), "\nLocal note.\n");
    const body = await audit();
    expect(body.totalFindings).toBe(3);
    const edited = body.entries.find((e) => e.path.includes("/.claude/"));
    expect(edited?.bundledFrom).toBeNull();
    expect(edited?.findings).toHaveLength(3);
  });
});
