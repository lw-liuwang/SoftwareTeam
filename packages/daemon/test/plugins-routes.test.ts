// Phase 3a slice 3.3 — plugins HTTP routes (TDD red→green).
//
// SC-29 EXCEPTION #8 declared verbatim:
// "Slice 3.3 (UI plugin surface) requires daemon-side plugin-discovery-service
// + 3 HTTP routes (GET /api/plugins, GET /api/plugins/:id, GET /api/plugins/:id/used-by)
// as backing API. No additional state, no SQL migration, no mutation routes.
// Read-only discovery surface aggregating filesystem-scan unions per
// DESIGN.md §5.4. Per IMPL-PRD §3.3 'Code touches' this allocation is explicit;
// documenting in compliance with banked SC-29 verbatim-declaration rule."

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PluginDiscoveryService } from "../src/domain/plugin-discovery-service.js";
import { pluginsRoutes } from "../src/routes/plugins.js";

interface TestEnv {
  root: string;
  service: PluginDiscoveryService;
  softwareteamPluginsDir: string;
  claudeCacheDir: string;
  codexCacheDir: string;
  specLibraryDir: string;
}

function setup(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "plugins-routes-"));
  const softwareteamPluginsDir = join(root, "softwareteam-plugins");
  const claudeCacheDir = join(root, "claude-cache");
  const codexCacheDir = join(root, "codex-cache");
  const specLibraryDir = join(root, "specs");
  mkdirSync(softwareteamPluginsDir, { recursive: true });
  mkdirSync(claudeCacheDir, { recursive: true });
  mkdirSync(codexCacheDir, { recursive: true });
  mkdirSync(specLibraryDir, { recursive: true });
  const service = new PluginDiscoveryService({
    softwareteamPluginsDir,
    claudeCacheDir,
    codexCacheDir,
    specLibraryDir,
  });
  return { root, service, softwareteamPluginsDir, claudeCacheDir, codexCacheDir, specLibraryDir };
}

function writeClaudePluginManifest(pluginDir: string, manifest: Record<string, unknown>): void {
  const manifestDir = join(pluginDir, ".claude-plugin");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

function writeCodexPluginManifest(pluginDir: string, manifest: Record<string, unknown>): void {
  const manifestDir = join(pluginDir, ".codex-plugin");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

function createApp(service: PluginDiscoveryService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("pluginDiscoveryService" as never, service);
    await next();
  });
  app.route("/api/plugins", pluginsRoutes());
  return app;
}

describe("plugins HTTP routes", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(env.root, { recursive: true, force: true });
  });

  describe("GET /api/plugins", () => {
    it("returns empty array when no plugins discovered", async () => {
      const res = await createApp(env.service).request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(body).toEqual([]);
    });

    it("returns aggregated plugin list", async () => {
      writeClaudePluginManifest(join(env.softwareteamPluginsDir, "softwareteam-core"), {
        name: "softwareteam-core",
        version: "0.1.0",
        description: "vendored",
      });
      writeCodexPluginManifest(join(env.softwareteamPluginsDir, "softwareteam-core"), {
        name: "softwareteam-core",
        version: "0.1.0",
        description: "vendored",
      });
      writeClaudePluginManifest(join(env.claudeCacheDir, "anthropics", "github", "1.0.0"), {
        name: "github",
        version: "1.0.0",
        description: "claude-cache",
      });

      const res = await createApp(env.service).request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ name: string; source: string; runtimes: string[] }>;
      expect(body).toHaveLength(2);
      const names = body.map((p) => p.name).sort();
      expect(names).toEqual(["github", "softwareteam-core"]);
    });

    it("supports runtime filter via query string", async () => {
      writeClaudePluginManifest(join(env.softwareteamPluginsDir, "claude-only"), {
        name: "claude-only",
        version: "1.0.0",
        description: "x",
      });
      writeCodexPluginManifest(join(env.softwareteamPluginsDir, "codex-only"), {
        name: "codex-only",
        version: "1.0.0",
        description: "x",
      });

      const claudeRes = await createApp(env.service).request("/api/plugins?runtime=claude");
      expect(claudeRes.status).toBe(200);
      const claudeBody = await claudeRes.json() as Array<{ name: string }>;
      expect(claudeBody.map((p) => p.name)).toEqual(["claude-only"]);

      const codexRes = await createApp(env.service).request("/api/plugins?runtime=codex");
      expect(codexRes.status).toBe(200);
      const codexBody = await codexRes.json() as Array<{ name: string }>;
      expect(codexBody.map((p) => p.name)).toEqual(["codex-only"]);
    });

    it("slice 3.3 fix-C — supports software-team-cwd discovery via ?cwd=<path> query param", async () => {
      // velocity-qa VM verify failure #3 — DESIGN §5.4 union 4th category
      // (software-team-bundled cwd plugin roots). API exposes the per-call cwd scan
      // via ?cwd=<path>; service emits discoveries with software-team-cwd source.
      const softwareTeamCwd = join(env.root, "software-team-cwd-api");
      const claudeBundleDir = join(softwareTeamCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "software-team-tool"), {
        name: "software-team-tool",
        version: "1.0.0",
        description: "software-team-bundled tool",
      });

      // Without ?cwd — no software-team-cwd discoveries.
      const baseRes = await createApp(env.service).request("/api/plugins");
      const base = await baseRes.json() as Array<{ source: string }>;
      expect(base.some((p) => p.source === "software-team-cwd")).toBe(false);

      // With ?cwd=<path> — software-team-tool surfaces.
      const cwdRes = await createApp(env.service).request(
        `/api/plugins?cwd=${encodeURIComponent(softwareTeamCwd)}`,
      );
      const cwdPlugins = await cwdRes.json() as Array<{ name: string; source: string }>;
      const softwareTeamCwdSubset = cwdPlugins.filter((p) => p.source === "software-team-cwd");
      expect(softwareTeamCwdSubset).toHaveLength(1);
      expect(softwareTeamCwdSubset[0]?.name).toBe("software-team-tool");
    });

    it("slice 3.3 fix-iteration — list ?cwd= + detail roundtrip for software-team-cwd plugin (no 404)", async () => {
      // redo-guard-2 BLOCK item 1: /api/plugins?cwd= lists;
      // /api/plugins/<encoded-software-team-cwd-id> must 200 not 404. Fix lands in
      // PluginDiscoveryService.getPlugin via self-resolve from id prefix.
      const softwareTeamCwd = join(env.root, "software-team-cwd-roundtrip");
      const claudeBundleDir = join(softwareTeamCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "roundtrip-tool"), {
        name: "roundtrip-tool",
        version: "1.0.0",
        description: "roundtrip",
      });

      // Step 1: list with ?cwd= — captures id.
      const listRes = await createApp(env.service).request(
        `/api/plugins?cwd=${encodeURIComponent(softwareTeamCwd)}`,
      );
      expect(listRes.status).toBe(200);
      const list = await listRes.json() as Array<{ id: string; source: string }>;
      const softwareTeamCwdEntry = list.find((p) => p.source === "software-team-cwd");
      expect(softwareTeamCwdEntry).toBeDefined();
      const softwareTeamCwdId = softwareTeamCwdEntry!.id;

      // Step 2: detail call with that id — must 200 (was 404 pre-fix).
      const detailRes = await createApp(env.service).request(
        `/api/plugins/${encodeURIComponent(softwareTeamCwdId)}`,
      );
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json() as { entry: { name: string; source: string } };
      expect(detail.entry.name).toBe("roundtrip-tool");
      expect(detail.entry.source).toBe("software-team-cwd");
    });

    it("supports source filter via query string", async () => {
      writeClaudePluginManifest(join(env.softwareteamPluginsDir, "vended"), {
        name: "vended",
        version: "0.1.0",
        description: "x",
      });
      writeClaudePluginManifest(join(env.claudeCacheDir, "anthropics", "cached", "1.0.0"), {
        name: "cached",
        version: "1.0.0",
        description: "x",
      });

      const vendoredRes = await createApp(env.service).request("/api/plugins?source=vendored");
      const vendored = await vendoredRes.json() as Array<{ name: string }>;
      expect(vendored.map((p) => p.name)).toEqual(["vended"]);

      const cacheRes = await createApp(env.service).request("/api/plugins?source=claude-cache");
      const cache = await cacheRes.json() as Array<{ name: string }>;
      expect(cache.map((p) => p.name)).toEqual(["cached"]);
    });

    it("returns 503 when service is not provisioned", async () => {
      const app = new Hono();
      app.route("/api/plugins", pluginsRoutes());
      const res = await app.request("/api/plugins");
      expect(res.status).toBe(503);
    });
  });

  describe("GET /api/plugins/:id", () => {
    it("returns 404 for unknown plugin id", async () => {
      const res = await createApp(env.service).request("/api/plugins/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns plugin detail with manifest + skills + hooks", async () => {
      const corePluginDir = join(env.softwareteamPluginsDir, "softwareteam-core");
      writeClaudePluginManifest(corePluginDir, {
        name: "softwareteam-core",
        version: "0.1.0",
        description: "Canonical SoftwareTeam content",
      });
      mkdirSync(join(corePluginDir, "skills", "softwareteam-user"), { recursive: true });
      writeFileSync(
        join(corePluginDir, "skills", "softwareteam-user", "SKILL.md"),
        "---\nname: softwareteam-user\n---\n",
      );
      mkdirSync(join(corePluginDir, "hooks"), { recursive: true });
      writeFileSync(
        join(corePluginDir, "hooks", "claude.json"),
        JSON.stringify({
          hooks: { SessionStart: [{ type: "command", command: "echo hi" }] },
        }),
      );

      const res = await createApp(env.service).request("/api/plugins/softwareteam-core");
      expect(res.status).toBe(200);
      const body = await res.json() as {
        entry: { name: string };
        claudeManifest: { name: string };
        skills: Array<{ name: string }>;
        hooks: Array<{ runtime: string; events: string[] }>;
      };
      expect(body.entry.name).toBe("softwareteam-core");
      expect(body.claudeManifest?.name).toBe("softwareteam-core");
      expect(body.skills.map((s) => s.name)).toEqual(["softwareteam-user"]);
      expect(body.hooks).toHaveLength(1);
      expect(body.hooks[0]?.runtime).toBe("claude");
      expect(body.hooks[0]?.events).toContain("SessionStart");
    });
  });

  describe("GET /api/plugins/:id/used-by", () => {
    it("distinguishes an unknown plugin from an unused installed plugin", async () => {
      const res = await createApp(env.service).request("/api/plugins/no-such-plugin/used-by");
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "plugin_not_found", message: expect.stringContaining("no-such-plugin") });
    });

    it("returns references to an uninstalled plugin", async () => {
      const dir = join(env.specLibraryDir, "missing-plugin-user");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "agent.yaml"), [
        "name: missing-plugin-user", "resources:", "  plugins:", "    - id: acme-not-installed",
        "profiles:", "  default:", "    uses:", "      plugins: [acme-not-installed]",
      ].join("\n"));
      expect(env.service.getPlugin("acme-not-installed")).toBeNull();
      const res = await createApp(env.service).request("/api/plugins/acme-not-installed/used-by");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([expect.objectContaining({
        agentName: "missing-plugin-user", profiles: ["default"], kind: "consumer",
      })]);
    });

    it("counts bare and shared profile references without local plugin declarations", async () => {
      for (const [name, plugin] of [["bare-user", "softwareteam-core"], ["shared-user", "shared:softwareteam-core"],
        ["other-user", "other:softwareteam-core"], ["similar-user", "shared:softwareteam-core-extra"]]) {
        const dir = join(env.specLibraryDir, name!);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "agent.yaml"), [
          `name: ${name}`, "profiles:", "  default:", "    uses:", `      plugins: [${plugin}]`,
        ].join("\n"));
      }
      const res = await createApp(env.service).request("/api/plugins/softwareteam-core/used-by");
      expect(res.status).toBe(200);
      const refs = await res.json() as Array<{ agentName: string; profiles: string[]; kind: string }>;
      expect(refs.map(ref => ref.agentName).sort()).toEqual(["bare-user", "shared-user"]);
      expect(refs.every(ref => ref.kind === "consumer" && ref.profiles.join() === "default")).toBe(true);
    });

    it("ignores cold legacy references while activating the selected user specs root", async () => {
      vi.stubEnv("HOME", env.root);
      vi.stubEnv("SOFTWARETEAM_HOME", join(env.root, "primary"));
      const legacySpecs = join(env.root, ".openrig/specs");
      const primarySpecs = join(env.root, "primary/specs");
      const seedAgent = (root: string, name: string) => {
        const dir = join(root, "agents", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "agent.yaml"), [
          `name: ${name}`, 'version: "1.0"', "resources:", "  skills: []",
          "  plugins:", "    - id: softwareteam-core", "      source:", "        kind: local",
          "        path: ~/.softwareteam/plugins/softwareteam-core", "profiles:", "  default:",
          "    uses:", "      plugins: [softwareteam-core]",
        ].join("\n"));
      };
      seedAgent(legacySpecs, "legacy-only-agent");
      expect(existsSync(primarySpecs)).toBe(false);
      const { createDaemon } = await import("../src/startup.js");
      const { app, db } = await createDaemon({ dbPath: ":memory:" });
      try {
        expect(existsSync(primarySpecs)).toBe(true);
        expect(existsSync(legacySpecs)).toBe(true);
        const libraryRes = await app.request("/api/specs/library?kind=agent");
        expect(libraryRes.status).toBe(200);
        const library = await libraryRes.json() as Array<{ name: string; sourcePath: string }>;
        expect(library).not.toContainEqual(expect.objectContaining({
          name: "legacy-only-agent", sourcePath: join(legacySpecs, "agents/legacy-only-agent/agent.yaml"),
        }));
        seedAgent(primarySpecs, "primary-agent");
        const res = await app.request("/api/plugins/softwareteam-core/used-by");
        expect(res.status).toBe(200);
        const refs = await res.json() as Array<{ agentName: string; sourcePath: string }>;
        expect(refs).not.toContainEqual(expect.objectContaining({
          agentName: "legacy-only-agent", sourcePath: join(legacySpecs, "agents/legacy-only-agent/agent.yaml"),
        }));
        expect(refs).toContainEqual(expect.objectContaining({
          agentName: "primary-agent", sourcePath: join(primarySpecs, "agents/primary-agent/agent.yaml"),
        }));
      } finally {
        db.close();
      }
    });

    it("wires built-in reverse usage through the real daemon startup", async () => {
      vi.stubEnv("SOFTWARETEAM_HOME", join(env.root, "home"));
      const { createDaemon } = await import("../src/startup.js");
      const { app, db } = await createDaemon({ dbPath: ":memory:" });
      try {
        const res = await app.request("/api/plugins/softwareteam-core/used-by");
        expect(res.status).toBe(200);
        const refs = await res.json() as Array<{ agentName: string; profiles: string[]; kind: string }>;
        expect(refs).toContainEqual(expect.objectContaining({ agentName: "conveyor-lead", profiles: ["default"], kind: "consumer" }));
        expect(refs).toContainEqual(expect.objectContaining({ agentName: "shared", profiles: [], kind: "definition" }));
      } finally {
        db.close();
      }
    });

    it("includes shipped built-in agents even when the user library is empty", async () => {
      writeClaudePluginManifest(join(env.softwareteamPluginsDir, "softwareteam-core"), { name: "softwareteam-core", version: "0.1.0" });
      const builtinSpecs = fileURLToPath(new URL("../specs", import.meta.url));
      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: env.softwareteamPluginsDir, claudeCacheDir: env.claudeCacheDir,
        codexCacheDir: env.codexCacheDir, specLibraryDir: env.specLibraryDir,
        additionalSpecLibraryDirs: [builtinSpecs, builtinSpecs],
      });
      const res = await createApp(service).request("/api/plugins/softwareteam-core/used-by");
      expect(res.status).toBe(200);
      const refs = await res.json() as Array<{ agentName: string; sourcePath: string; profiles: string[]; kind: string }>;
      const shared = refs.filter((ref) => ref.sourcePath === join(builtinSpecs, "agents/shared/agent.yaml"));
      expect(shared).toHaveLength(1);
      expect(shared[0]?.agentName).toBe("shared");
      expect(shared[0]?.kind).toBe("definition");
      expect(shared[0]?.profiles).toEqual([]);
      expect(refs).toContainEqual(expect.objectContaining({ agentName: "conveyor-lead",
        sourcePath: join(builtinSpecs, "agents/conveyor/lead/agent.yaml"), profiles: ["default"], kind: "consumer" }));
    });

    it("returns empty list when plugin not used by any agent", async () => {
      writeClaudePluginManifest(join(env.softwareteamPluginsDir, "softwareteam-core"), { name: "softwareteam-core", version: "0.1.0" });
      const res = await createApp(env.service).request("/api/plugins/softwareteam-core/used-by");
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(body).toEqual([]);
    });

    it("returns agent references with profile names", async () => {
      writeClaudePluginManifest(join(env.softwareteamPluginsDir, "softwareteam-core"), { name: "softwareteam-core", version: "0.1.0" });
      const advisorDir = join(env.specLibraryDir, "advisor");
      mkdirSync(advisorDir, { recursive: true });
      writeFileSync(
        join(advisorDir, "agent.yaml"),
        `name: advisor-lead
version: "1.0"
defaults:
  runtime: claude-code
profiles:
  default:
    uses:
      plugins:
        - softwareteam-core
  review:
    uses:
      plugins:
        - softwareteam-core
        - reviewer-tools
resources:
  plugins:
    - id: softwareteam-core
      source:
        kind: local
        path: ~/.softwareteam/plugins/softwareteam-core
    - id: reviewer-tools
      source:
        kind: local
        path: ~/.softwareteam/plugins/reviewer-tools
  skills: []
startup:
  files: []
  actions: []
`,
      );

      const res = await createApp(env.service).request("/api/plugins/softwareteam-core/used-by");
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ agentName: string; profiles: string[] }>;
      expect(body).toHaveLength(1);
      expect(body[0]?.agentName).toBe("advisor-lead");
      expect(body[0]?.profiles.sort()).toEqual(["default", "review"]);
    });
  });

  describe("drift-discriminator regression coverage", () => {
    it("each route shape is observably distinct (per banked feedback_poc_regression_must_discriminate)", async () => {
      // Place 3 plugins in 3 source roots so the list endpoint must aggregate
      // across all 3; verify response distinguishes them.
      writeClaudePluginManifest(join(env.softwareteamPluginsDir, "vended"), {
        name: "vended", version: "0.1.0", description: "v",
      });
      writeClaudePluginManifest(join(env.claudeCacheDir, "anthropics", "claude-tool", "2.0.0"), {
        name: "claude-tool", version: "2.0.0", description: "c",
      });
      writeCodexPluginManifest(join(env.codexCacheDir, "openai", "codex-tool", "3.0.0"), {
        name: "codex-tool", version: "3.0.0", description: "x",
      });

      const listRes = await createApp(env.service).request("/api/plugins");
      const list = await listRes.json() as Array<{ source: string }>;
      const sources = list.map((p) => p.source).sort();
      expect(sources).toEqual(["claude-cache", "codex-cache", "vendored"]);
    });
  });
});
