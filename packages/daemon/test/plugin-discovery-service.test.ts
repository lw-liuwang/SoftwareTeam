// Phase 3a slice 3.3 — plugin-discovery-service tests (TDD red→green).
//
// SC-29 EXCEPTION #8 declared verbatim:
// "Slice 3.3 (UI plugin surface) requires daemon-side plugin-discovery-service
// + 3 HTTP routes (GET /api/plugins, GET /api/plugins/:id, GET /api/plugins/:id/used-by)
// as backing API. No additional state, no SQL migration, no mutation routes.
// Read-only discovery surface aggregating filesystem-scan unions per
// DESIGN.md §5.4. Per IMPL-PRD §3.3 'Code touches' this allocation is explicit;
// documenting in compliance with banked SC-29 verbatim-declaration rule."
//
// Discovery service contract:
//   - listPlugins({ runtimeFilter?, sourceFilter?, agentRefFilter? })
//     → PluginEntry[] union of:
//       * ~/.softwareteam/plugins/* (vendored)
//       * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ (claude-cache)
//       * ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/ (codex-cache)
//       * agent-ref discoveries (plugins referenced inline in agent.yaml resources.plugins[])
//   - getPlugin(id) → PluginManifest with full manifest content + tree summary
//   - findUsedBy(id) → AgentReference[] (which agent.yamls reference this plugin id)
//
// Branch-merge-friendly: this service operates on filesystem reads + raw YAML
// string matching for used-by; doesn't depend on batch 1's PluginResource type
// from plugin-primitive-v0 branch. After convergence into plugin-primitive-v0,
// the service continues to work with the shipped PluginResource types.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginDiscoveryService } from "../src/domain/plugin-discovery-service.js";

interface TempDirs {
  root: string;
  softwareteamPluginsDir: string;
  claudeCacheDir: string;
  codexCacheDir: string;
  specLibraryDir: string;
}

function setupTempDirs(): TempDirs {
  const root = mkdtempSync(join(tmpdir(), "plugin-discovery-test-"));
  const softwareteamPluginsDir = join(root, "softwareteam-plugins");
  const claudeCacheDir = join(root, "claude-cache");
  const codexCacheDir = join(root, "codex-cache");
  const specLibraryDir = join(root, "specs", "agents");
  mkdirSync(softwareteamPluginsDir, { recursive: true });
  mkdirSync(claudeCacheDir, { recursive: true });
  mkdirSync(codexCacheDir, { recursive: true });
  mkdirSync(specLibraryDir, { recursive: true });
  return { root, softwareteamPluginsDir, claudeCacheDir, codexCacheDir, specLibraryDir };
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

function writeHookManifest(pluginDir: string, runtime: "claude" | "codex", event: string, command: string): void {
  writeHookRegistry(pluginDir, runtime, {
    [event]: [{ hooks: [{ type: "command", command }] }],
  });
}

function writeHookRegistry(
  pluginDir: string,
  runtime: "claude" | "codex",
  hooks: Record<string, unknown>,
): void {
  const hooksDir = join(pluginDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, `${runtime}.json`), JSON.stringify({
    hooks,
  }));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("PluginDiscoveryService", () => {
  let dirs: TempDirs;

  beforeEach(() => {
    dirs = setupTempDirs();
  });

  afterEach(() => {
    rmSync(dirs.root, { recursive: true, force: true });
  });

  describe("listPlugins", () => {
    it("returns empty list when no plugin sources contain plugins", () => {
      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.listPlugins()).toEqual([]);
    });

    it("retires historical softwareteam-lab refocus registrations before duplicate validation", () => {
      const core = join(dirs.softwareteamPluginsDir, "softwareteam-core");
      const lab = join(dirs.softwareteamPluginsDir, "softwareteam-lab");
      writeClaudePluginManifest(core, { name: "softwareteam-core", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeCodexPluginManifest(core, { name: "softwareteam-core", version: "0.1.0", hooks: "./hooks/codex.json" });
      writeClaudePluginManifest(lab, { name: "softwareteam-lab", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeCodexPluginManifest(lab, { name: "softwareteam-lab", version: "0.1.0", hooks: "./hooks/codex.json" });
      writeHookRegistry(core, "claude", Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "PostCompact", "Stop"].map((event) => [
          event,
          [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"' }] }],
        ]),
      ));
      writeHookRegistry(core, "codex", Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "Stop"].map((event) => [
          event,
          [{ hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/hooks/scripts/refocus.cjs"' }] }],
        ]),
      ));
      // Exact obsolete event sets preserved in the release-boundary ops archive.
      writeHookRegistry(lab, "claude", Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "Stop", "PostCompact"].map((event) => [
          event,
          [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"', timeout: 5 }] }],
        ]),
      ));
      writeHookRegistry(lab, "codex", Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "Stop"].map((event) => [
          event,
          [{ hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/hooks/scripts/refocus.cjs"', timeout: 5 }] }],
        ]),
      ));

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });

      expect(service.listPlugins().map((plugin) => plugin.id).sort()).toEqual(["softwareteam-core", "softwareteam-lab"]);
      expect(readJson(join(lab, ".claude-plugin", "plugin.json"))).not.toHaveProperty("hooks");
      expect(readJson(join(lab, ".codex-plugin", "plugin.json"))).not.toHaveProperty("hooks");
      expect(readJson(join(lab, "hooks", "claude.json"))).toEqual({ hooks: {} });
      expect(readJson(join(lab, "hooks", "codex.json"))).toEqual({ hooks: {} });
      expect(readJson(join(core, ".claude-plugin", "plugin.json"))).toHaveProperty("hooks", "./hooks/claude.json");
      expect(readJson(join(core, ".codex-plugin", "plugin.json"))).toHaveProperty("hooks", "./hooks/codex.json");
    });

    it("removes only obsolete refocus commands from softwareteam-lab", () => {
      const core = join(dirs.softwareteamPluginsDir, "softwareteam-core");
      const lab = join(dirs.softwareteamPluginsDir, "softwareteam-lab");
      writeClaudePluginManifest(core, { name: "softwareteam-core", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeClaudePluginManifest(lab, { name: "softwareteam-lab", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeHookManifest(core, "claude", "Stop", 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"');
      writeHookRegistry(lab, "claude", {
        Stop: [{ hooks: [
          { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"', timeout: 5 },
          { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 },
        ] }],
      });

      expect(() => new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      })).not.toThrow();

      expect(readJson(join(lab, ".claude-plugin", "plugin.json"))).toHaveProperty("hooks", "./hooks/claude.json");
      expect(readJson(join(lab, "hooks", "claude.json"))).toEqual({
        hooks: {
          Stop: [{ hooks: [
            { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 },
          ] }],
        },
      });
    });

    it("fails loud with both Claude manifest paths when unknown vendored plugins duplicate a hook identity", () => {
      const core = join(dirs.softwareteamPluginsDir, "softwareteam-core");
      const rogue = join(dirs.softwareteamPluginsDir, "softwareteam-rogue");
      writeClaudePluginManifest(core, { name: "softwareteam-core", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeClaudePluginManifest(rogue, { name: "softwareteam-rogue", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeHookManifest(core, "claude", "Stop", 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"');
      writeHookManifest(rogue, "claude", "Stop", 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"');

      expect(() => new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      })).toThrow(new RegExp(`${core}/hooks/claude\\.json.*${rogue}/hooks/claude\\.json`));
    });

    it("fails loud with both Codex manifest paths when unknown vendored plugins duplicate a hook identity", () => {
      const core = join(dirs.softwareteamPluginsDir, "softwareteam-core");
      const rogue = join(dirs.softwareteamPluginsDir, "softwareteam-rogue");
      writeCodexPluginManifest(core, { name: "softwareteam-core", version: "0.1.0", hooks: "./hooks/codex.json" });
      writeCodexPluginManifest(rogue, { name: "softwareteam-rogue", version: "0.1.0", hooks: "./hooks/codex.json" });
      writeHookManifest(core, "codex", "Stop", 'node "${PLUGIN_ROOT}/hooks/scripts/refocus.cjs"');
      writeHookManifest(rogue, "codex", "Stop", 'node "${PLUGIN_ROOT}/hooks/scripts/refocus.cjs"');

      expect(() => new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      })).toThrow(new RegExp(`${core}/hooks/codex\\.json.*${rogue}/hooks/codex\\.json`));
    });

    it("discovers a vendored SoftwareTeam plugin (dual-manifest)", () => {
      const corePluginDir = join(dirs.softwareteamPluginsDir, "softwareteam-core");
      writeClaudePluginManifest(corePluginDir, {
        name: "softwareteam-core",
        version: "0.1.0",
        description: "SoftwareTeam canonical skills and hooks",
      });
      writeCodexPluginManifest(corePluginDir, {
        name: "softwareteam-core",
        version: "0.1.0",
        description: "SoftwareTeam canonical skills and hooks",
      });

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        id: "softwareteam-core",
        name: "softwareteam-core",
        version: "0.1.0",
        source: "vendored",
        sourceLabel: "vendored:softwareteam-core",
        runtimes: ["claude", "codex"],
      });
    });

    it("discovers a Claude cache plugin (claude-only manifest)", () => {
      const claudePluginPath = join(dirs.claudeCacheDir, "anthropics", "github", "1.0.0");
      writeClaudePluginManifest(claudePluginPath, {
        name: "github",
        version: "1.0.0",
        description: "GitHub integration",
      });

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        name: "github",
        version: "1.0.0",
        source: "claude-cache",
        sourceLabel: "claude-cache:anthropics/github/1.0.0",
        runtimes: ["claude"],
      });
    });

    it("discovers a Codex cache plugin (codex-only manifest)", () => {
      const codexPluginPath = join(dirs.codexCacheDir, "openai", "tools", "0.5.0");
      writeCodexPluginManifest(codexPluginPath, {
        name: "tools",
        version: "0.5.0",
        description: "Codex tools",
      });

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        name: "tools",
        version: "0.5.0",
        source: "codex-cache",
        sourceLabel: "codex-cache:openai/tools/0.5.0",
        runtimes: ["codex"],
      });
    });

    it("aggregates discoveries across all 3 source roots with distinct source labels", () => {
      // Drift-discriminator regression check per banked feedback_poc_regression_must_discriminate.
      // Three sources × distinct values per source so layer discrimination is
      // observable.
      writeClaudePluginManifest(join(dirs.softwareteamPluginsDir, "softwareteam-core"), {
        name: "softwareteam-core",
        version: "0.1.0",
        description: "vendored",
      });
      writeClaudePluginManifest(join(dirs.claudeCacheDir, "anthropics", "github", "1.0.0"), {
        name: "github",
        version: "1.0.0",
        description: "claude-cache",
      });
      writeCodexPluginManifest(join(dirs.codexCacheDir, "openai", "tools", "0.5.0"), {
        name: "tools",
        version: "0.5.0",
        description: "codex-cache",
      });

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(3);
      // Distinct source labels per layer.
      const sources = plugins.map((p) => p.source).sort();
      expect(sources).toEqual(["claude-cache", "codex-cache", "vendored"]);
    });

    it("ignores directories without plugin manifests", () => {
      mkdirSync(join(dirs.softwareteamPluginsDir, "not-a-plugin"), { recursive: true });
      writeFileSync(
        join(dirs.softwareteamPluginsDir, "not-a-plugin", "README.md"),
        "Not a plugin",
      );

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.listPlugins()).toEqual([]);
    });

    it("slice 3.3 fix-C — scans software-team-bundled cwd plugin roots when cwdScanRoots provided", () => {
      // velocity-qa VM verify failure #3 — DESIGN §5.4 union-of-sources
      // must include software-team-bundled <cwd>/.claude/plugins/* and
      // <cwd>/.codex/plugins/* (the projection target from IMPL-PRD §1.2).
      // Implementation: PluginDiscoveryService accepts optional
      // cwdScanRoots (constructor + per-call); each scanned cwd contributes
      // discoveries with `software-team-cwd:` source label.
      const softwareTeamCwd = join(dirs.root, "software-team-cwd-1");
      const claudeBundleDir = join(softwareTeamCwd, ".claude", "plugins");
      const codexBundleDir = join(softwareTeamCwd, ".codex", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      mkdirSync(codexBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "software-team-tool"), {
        name: "software-team-tool",
        version: "1.0.0",
        description: "SoftwareTeam-bundled tool",
      });
      writeCodexPluginManifest(join(codexBundleDir, "software-team-codex-tool"), {
        name: "software-team-codex-tool",
        version: "1.0.0",
        description: "SoftwareTeam-bundled codex tool",
      });

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
        cwdScanRoots: [softwareTeamCwd],
      });
      const plugins = service.listPlugins();
      // Two plugins: one claude-side, one codex-side; both labeled software-team-cwd.
      const cwdPlugins = plugins.filter((p) => p.source === "software-team-cwd");
      expect(cwdPlugins).toHaveLength(2);
      const names = cwdPlugins.map((p) => p.name).sort();
      expect(names).toEqual(["software-team-codex-tool", "software-team-tool"]);
      // Source labels embed the softwareTeam cwd tail for disambiguation;
      // each plugin's label contains its name (order-independent).
      const labels = cwdPlugins.map((p) => p.sourceLabel);
      expect(labels.some((l) => /^software-team-cwd:.*software-team-tool$/.test(l))).toBe(true);
      expect(labels.some((l) => /^software-team-cwd:.*software-team-codex-tool$/.test(l))).toBe(true);
    });

    it("slice 3.3 fix-C — per-call cwdScanRoots overrides constructor option", () => {
      // Allows the API layer to pass ?cwd=<path> dynamically without
      // mutating the service singleton.
      const softwareTeamCwd = join(dirs.root, "software-team-cwd-dyn");
      const claudeBundleDir = join(softwareTeamCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "ephemeral-tool"), {
        name: "ephemeral-tool",
        version: "0.1.0",
        description: "dynamic",
      });

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      // No cwds at construction.
      expect(service.listPlugins().filter((p) => p.source === "software-team-cwd")).toEqual([]);
      // Per-call cwd surfaces the bundled plugin.
      const withCwd = service.listPlugins({ cwdScanRoots: [softwareTeamCwd] });
      expect(withCwd.filter((p) => p.source === "software-team-cwd")).toHaveLength(1);
      expect(withCwd.find((p) => p.name === "ephemeral-tool")).toBeDefined();
    });

    it("filters by runtime when requested", () => {
      writeClaudePluginManifest(join(dirs.softwareteamPluginsDir, "claude-only"), {
        name: "claude-only",
        version: "1.0.0",
        description: "x",
      });
      writeCodexPluginManifest(join(dirs.softwareteamPluginsDir, "codex-only"), {
        name: "codex-only",
        version: "1.0.0",
        description: "x",
      });

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const claudeOnly = service.listPlugins({ runtimeFilter: "claude" });
      expect(claudeOnly).toHaveLength(1);
      expect(claudeOnly[0]?.name).toBe("claude-only");
      const codexOnly = service.listPlugins({ runtimeFilter: "codex" });
      expect(codexOnly).toHaveLength(1);
      expect(codexOnly[0]?.name).toBe("codex-only");
    });
  });

  describe("getPlugin", () => {
    it("returns null when plugin not found", () => {
      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.getPlugin("nonexistent")).toBeNull();
    });

    it("returns MCP server summaries from manifest mcpServers field (slice 3.3 fix-A)", () => {
      // velocity-qa VM verify failure #1: PluginViewer needs an MCP section
      // per DESIGN §5.7 + IMPL-PRD §3.2. Manifest's mcpServers field is
      // an object keyed by server-name → server-config. Discovery returns
      // one PluginMcpServerSummary per key (best-effort; we surface name +
      // declared command/transport metadata if present).
      const corePluginDir = join(dirs.softwareteamPluginsDir, "softwareteam-mcp");
      writeClaudePluginManifest(corePluginDir, {
        name: "softwareteam-mcp",
        version: "0.1.0",
        description: "MCP-bearing plugin",
        mcpServers: {
          "github-mcp": { command: "node", args: ["server.js"], transport: "stdio" },
          "linear-mcp": { command: "linear-mcp", transport: "http" },
        },
      });
      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const result = service.getPlugin("softwareteam-mcp");
      expect(result).not.toBeNull();
      expect(result?.mcpServers).toHaveLength(2);
      const serverNames = result?.mcpServers.map((s) => s.name).sort();
      expect(serverNames).toEqual(["github-mcp", "linear-mcp"]);
      expect(result?.mcpServers.find((s) => s.name === "github-mcp")?.runtime).toBe("claude");
    });

    it("returns empty mcpServers when manifest has no mcpServers field", () => {
      const corePluginDir = join(dirs.softwareteamPluginsDir, "softwareteam-no-mcp");
      writeClaudePluginManifest(corePluginDir, {
        name: "softwareteam-no-mcp",
        version: "0.1.0",
        description: "no mcp",
      });
      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.getPlugin("softwareteam-no-mcp")?.mcpServers).toEqual([]);
    });

    it("slice 3.3 fix-iteration — getPlugin self-resolves software-team-cwd: IDs (claude side) without external cwd state", () => {
      // redo-guard-2 BLOCK item 1: /api/plugins?cwd=... lists software-team-cwd
      // plugins but /api/plugins/:id detail call 404s because listPlugins()
      // without cwdScanRoots doesn't re-scan the cwd, so getPlugin can't
      // find the entry by id. Fix: parse the cwd out of the software-team-cwd: id
      // prefix, re-scan that cwd, resolve the entry. ID format:
      //   software-team-cwd:<cwd>/.claude/plugins/<plugin>
      //   software-team-cwd:<cwd>/.codex/plugins/<plugin>
      const softwareTeamCwd = join(dirs.root, "software-team-cwd-self-resolve");
      const claudeBundleDir = join(softwareTeamCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "software-team-tool"), {
        name: "software-team-tool",
        version: "1.0.0",
        description: "software-team-bundled tool",
      });
      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const listed = service.listPlugins({ cwdScanRoots: [softwareTeamCwd] });
      const softwareTeamToolEntry = listed.find((p) => p.source === "software-team-cwd");
      expect(softwareTeamToolEntry).toBeDefined();
      const softwareTeamToolId = softwareTeamToolEntry!.id;
      // Call getPlugin with that id directly (no cwd opts) — must resolve.
      const detail = service.getPlugin(softwareTeamToolId);
      expect(detail).not.toBeNull();
      expect(detail?.entry.name).toBe("software-team-tool");
      expect(detail?.entry.source).toBe("software-team-cwd");
    });

    it("slice 3.3 fix-iteration — getPlugin self-resolves software-team-cwd: codex IDs too", () => {
      const softwareTeamCwd = join(dirs.root, "software-team-cwd-self-resolve-codex");
      const codexBundleDir = join(softwareTeamCwd, ".codex", "plugins");
      mkdirSync(codexBundleDir, { recursive: true });
      writeCodexPluginManifest(join(codexBundleDir, "codex-tool"), {
        name: "codex-tool",
        version: "2.0.0",
        description: "software-team-bundled codex tool",
      });
      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const listed = service.listPlugins({ cwdScanRoots: [softwareTeamCwd] });
      const codexToolEntry = listed.find((p) => p.name === "codex-tool");
      expect(codexToolEntry).toBeDefined();
      const detail = service.getPlugin(codexToolEntry!.id);
      expect(detail).not.toBeNull();
      expect(detail?.entry.name).toBe("codex-tool");
    });

    it("slice 3.3 fix-iteration — getPlugin returns null for malformed software-team-cwd: ids", () => {
      // Negative: garbled prefix or unresolvable cwd → null (not throw).
      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.getPlugin("software-team-cwd:notapath")).toBeNull();
      expect(service.getPlugin("software-team-cwd:/nonexistent/.claude/plugins/x")).toBeNull();
    });

    it("returns full manifest + tree summary for a discovered plugin", () => {
      const corePluginDir = join(dirs.softwareteamPluginsDir, "softwareteam-core");
      writeClaudePluginManifest(corePluginDir, {
        name: "softwareteam-core",
        version: "0.1.0",
        description: "Canonical SoftwareTeam content",
        author: { name: "SoftwareTeam" },
        skills: "./skills",
        hooks: "./hooks/claude.json",
      });
      // Add a skill folder + hook config so tree summary has content.
      mkdirSync(join(corePluginDir, "skills", "softwareteam-user"), { recursive: true });
      writeFileSync(
        join(corePluginDir, "skills", "softwareteam-user", "SKILL.md"),
        "---\nname: softwareteam-user\ndescription: User skill\n---\n",
      );
      mkdirSync(join(corePluginDir, "hooks"), { recursive: true });
      writeFileSync(join(corePluginDir, "hooks", "claude.json"), JSON.stringify({
        hooks: { SessionStart: [{ type: "command", command: "echo hi" }] },
      }));

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const result = service.getPlugin("softwareteam-core");
      expect(result).not.toBeNull();
      expect(result?.entry.name).toBe("softwareteam-core");
      expect(result?.claudeManifest).toMatchObject({
        name: "softwareteam-core",
        version: "0.1.0",
        description: "Canonical SoftwareTeam content",
      });
      expect(result?.skills).toContainEqual(
        expect.objectContaining({ name: "softwareteam-user" }),
      );
      expect(result?.hooks).toContainEqual(
        expect.objectContaining({ runtime: "claude" }),
      );
    });
  });

  describe("findUsedBy", () => {
    it("returns empty list when no agent specs reference the plugin", () => {
      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.findUsedBy("softwareteam-core")).toEqual([]);
    });

    it("finds agents whose resources.plugins[] references the plugin id", () => {
      const advisorDir = join(dirs.specLibraryDir, "advisor");
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
        - superpowers
resources:
  plugins:
    - id: softwareteam-core
      source:
        kind: local
        path: ~/.softwareteam/plugins/softwareteam-core
    - id: superpowers
      source:
        kind: local
        path: ~/.claude/plugins/cache/anthropics/superpowers/5.1.0
  skills: []
startup:
  files: []
  actions: []
`,
      );
      const driverDir = join(dirs.specLibraryDir, "driver");
      mkdirSync(driverDir, { recursive: true });
      writeFileSync(
        join(driverDir, "agent.yaml"),
        `name: velocity-driver
version: "1.0"
defaults:
  runtime: claude-code
profiles:
  default:
    uses:
      plugins:
        - softwareteam-core
resources:
  plugins:
    - id: softwareteam-core
      source:
        kind: local
        path: ~/.softwareteam/plugins/softwareteam-core
  skills: []
startup:
  files: []
  actions: []
`,
      );

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const usedBy = service.findUsedBy("softwareteam-core");
      expect(usedBy).toHaveLength(2);
      expect(usedBy.map((u) => u.agentName).sort()).toEqual(["advisor-lead", "velocity-driver"]);
      const superpowersUsedBy = service.findUsedBy("superpowers");
      expect(superpowersUsedBy).toHaveLength(1);
      expect(superpowersUsedBy[0]?.agentName).toBe("advisor-lead");
    });

    it("does NOT match plugin ids that appear only in comments or non-resource fields", () => {
      const agentDir = join(dirs.specLibraryDir, "false-positive-test");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "agent.yaml"),
        `name: false-positive-test
version: "1.0"
defaults:
  runtime: claude-code
# Note: this agent does NOT use softwareteam-core (just a comment mention).
profiles:
  default:
    uses:
      plugins: []
resources:
  plugins: []
  skills:
    - id: my-skill
      # related to softwareteam-core skill set but not using the plugin
      path: ./skills/my-skill.md
startup:
  files: []
  actions: []
`,
      );

      const service = new PluginDiscoveryService({
        softwareteamPluginsDir: dirs.softwareteamPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      // Comment + skill description mention softwareteam-core but resources.plugins is empty.
      // The implementation parses YAML and walks resources.plugins[].id — comments
      // and unrelated string positions are ignored.
      expect(service.findUsedBy("softwareteam-core")).toEqual([]);
    });
  });
});
