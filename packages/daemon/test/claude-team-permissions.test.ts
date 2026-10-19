import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KERNEL_CLAUDE_ALLOW, TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK, operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

const asset = fileURLToPath(new URL("../assets/claude-team-permissions.cjs", import.meta.url));
const { decide } = createRequire(import.meta.url)(asset);
const policy = { allow: TEAM_CLAUDE_ALLOW, ask: TEAM_CLAUDE_ASK };
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, existsSync: vi.fn(original.existsSync) };
});

describe("Claude kernel inspection permissions", () => {
  // Exercise the actual session hook emitted by the launcher. These are inert
  // hook inputs: no command, network request, provider or softwareTeam is executed.
  it.each([
    "curl -fsSL https://example.com/software-teams/demo -o /tmp/page.html",
    "/usr/bin/grep -o title /tmp/page.html", "sort -u /tmp/links", "wc -c /tmp/page.html",
    "python3 -I -c 'import sys; print(open(sys.argv[1]).read())' /tmp/page.html",
    "'/opt/my tools/python3' -I -c 'print(1)'", "command -v codex", "/usr/bin/command -v claude",
    "claude auth status", "'/opt/my tools/claude' auth status", "/opt/tools/codex login status",
    "cd /project", "echo ---", "printf '%s\\n' ready",
    "git -C /project status --porcelain", "SoftwareTeam up demo --cwd /project --target /software-teams/demo --plan",
    "'/opt/my tools/SoftwareTeam' up demo --plan", "env SOFTWARETEAM_PORT=7434 /opt/tools/SoftwareTeam ps --json",
  ])("allows a routine inspection command: %s", command => {
    const settings = JSON.parse(operationalLaunchArgs("claude-code", { kernelAuthority: true })[1]);
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    const result = spawnSync("/bin/sh", ["-c", hook.command], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, permission_mode: "acceptEdits" }), encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "allow",
    } });
  });

  it("keeps kernel lifecycle authority distinct from team asks, with no blanket shell grant", () => {
    const kernel = { allow: KERNEL_CLAUDE_ALLOW, ask: [] };
    expect(decide("SoftwareTeam down demo", kernel)).toBe("allow");
    expect(decide("SoftwareTeam down demo", policy)).toBe("ask");
    for (const command of ["claude auth login", "codex login", "command -v codex", "python3 -I -c 'print(1)'"])
      expect(decide(command, policy)).toBeUndefined();
    for (const command of ["claude auth login", "codex login", "sudo SoftwareTeam status", "./SoftwareTeam status",
      "PATH=/tmp SoftwareTeam status", "curl https://example.com | unknown-command", "SoftwareTeam status > /tmp/result"])
      expect(decide(command, kernel)).toBeUndefined();
  });

  it("keeps native kernel allowances when the optional hook is absent", () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    expect(JSON.parse(operationalLaunchArgs("claude-code", { kernelAuthority: true })[1]))
      .toEqual({ permissions: { allow: KERNEL_CLAUDE_ALLOW } });
  });
});

describe("Claude team command permissions", () => {
  for (const rule of TEAM_CLAUDE_ASK) {
    const command = rule.slice(5, -3);
    it(`${command}: real action asks, help does not`, () => {
      expect(decide(`${command} example`, policy)).toBe("ask");
      for (const flag of ["--help", "-h"]) {
        expect(decide(`${command} ${flag}`, policy)).toBe("allow");
        expect(decide(`${command} example ${flag}`, policy)).toBe("allow");
        expect(decide(`${command} ${flag} example`, policy)).toBe("allow");
      }
    });
  }
  it.each([
    "SoftwareTeam whoami --json", "SoftwareTeam status # note", "SoftwareTeam queue claim example", "SoftwareTeam queue unclaim example",
    "SoftwareTeam queue handoff example --to worker@team", "SoftwareTeam help down",
    "/opt/tools/SoftwareTeam status", "'/opt/my tools/SoftwareTeam' queue list", '"/opt/my tools/SoftwareTeam" down --help',
    "Soft\\wareTeam down -h", "env SOFTWARETEAM_PORT=7434 /opt/tools/SoftwareTeam status", "A=value SoftwareTeam status",
    "command -- /opt/tools/SoftwareTeam status", "/usr/bin/env -- command SoftwareTeam down --help",
    "exec /opt/tools/SoftwareTeam status", "SoftwareTeam --host remote down --help", "SoftwareTeam --host=remote down -h",
    "npm test", "/opt/tools/npm test", "'/project/node_modules/.bin/vitest' run test/unit.test.ts",
    "/private/tmp/project/node_modules/.bin/jest test/unit.test.ts", "python3 -m pytest",
    "SoftwareTeam send worker 'literal SoftwareTeam down text'", "SoftwareTeam send worker 'multiline\nSoftwareTeam down example'",
  ])("allows existing allowance spelling: %s", command => expect(decide(command, policy)).toBe("allow"));

  it.each([
    "/opt/tools/SoftwareTeam down example", "'/opt/my tools/SoftwareTeam' down example", "command SoftwareTeam down example",
    "env A=x SoftwareTeam up example", "SoftwareTeam --host remote down example", "SoftwareTeam --host=remote down example",
    "SoftwareTeam down -- --help", "SoftwareTeam down --cwd --help", 'SoftwareTeam down "$TEAM"', "SoftwareTeam down $(echo --help)",
    "SoftwareTeam down example && SoftwareTeam down --help", "SoftwareTeam status; /opt/tools/SoftwareTeam down example", "SoftwareTeam down example | cat",
    'echo "$(SoftwareTeam down example)"', "echo `SoftwareTeam up example`", "cat <<EOF\n$(SoftwareTeam down example)\nEOF",
    'git commit -m "multiline\nquoted" <<EOF\n$(SoftwareTeam down example)\nEOF',
    "timeout 30 SoftwareTeam down example", "time SoftwareTeam down example", "nice -n 5 SoftwareTeam down example",
    "nohup SoftwareTeam down example", "stdbuf -oL SoftwareTeam down example", "noglob SoftwareTeam down example",
    "xargs SoftwareTeam down", "if true; then SoftwareTeam down example; fi",
    "for s in example; do SoftwareTeam down $s; done", "{ SoftwareTeam down example; }", "! SoftwareTeam down example",
    "SoftwareTeam -- down example", "SoftwareTeam seat -- stop example@demo --reason maintenance",
    "SoftwareTeam -- down --help", "SoftwareTeam -- down -h", "SoftwareTeam -- down --help example", "SoftwareTeam seat -- stop --help example@demo",
    "ls # <<pwd\nSoftwareTeam down example\npwd", "ls # ' <<pwd\nSoftwareTeam down example\npwd",
    "echo $((1 <<value))\nSoftwareTeam down example\nvalue", "((1 <<value))\nSoftwareTeam down example\nvalue",
    "echo $((\n1 <<value))\nSoftwareTeam down example\nvalue",
    "PATH=/inert SoftwareTeam down example", "NODE_OPTIONS=--no-warnings SoftwareTeam down example", "./SoftwareTeam down example",
    "ls `pwd # x`; SoftwareTeam down example", "ls `pwd # x` && SoftwareTeam down example",
    "ls ${x:-a #b}; SoftwareTeam down example", "echo safe # $(SoftwareTeam down example)",
  ])("retains lifecycle confirmation: %s", command => expect(decide(command, policy)).toBe("ask"));

  it.each([
    "echo 'SoftwareTeam down example'", 'echo "SoftwareTeam down example"', "cat <<'EOF'\nSoftwareTeam down example\nEOF",
    'git commit -m "multi\nline" <<\'EOF\'\n$(SoftwareTeam down example)\nEOF',
    "SoftwareTeam status | python3 -c 'print(1)'", "SoftwareTeam status > result.txt", "SoftwareTeam status && npm test",
    "SoftwareTeam send worker $(cat message.txt)", 'SoftwareTeam send worker "$MESSAGE"',
    "sudo SoftwareTeam status", "env -i SoftwareTeam status", "command -v SoftwareTeam", "node arbitrary.js", "npm install",
    "'/opt/tools/SoftwareTeam down' example", "'A=value' SoftwareTeam status", "not-software-team down example", "", "'unterminated",
    "PATH=/inert SoftwareTeam status", "LD_PRELOAD=/inert SoftwareTeam status", "DYLD_INSERT_LIBRARIES=/inert SoftwareTeam status",
    "env NODE_OPTIONS=--no-warnings SoftwareTeam status", "BASH_ENV=/inert SoftwareTeam status", "ENV=/inert SoftwareTeam status", "./SoftwareTeam status",
    "cat <<'EOF' # <<OTHER\nSoftwareTeam down example\nEOF\nOTHER",
  ])("leaves unrelated/data/complex forms to native checks: %s", command => expect(decide(command, policy)).toBeUndefined());

  it("falls back to native lifecycle asks when the launch asset is absent", () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true });
    expect(JSON.parse(args[1])).toEqual({ permissions: { allow: TEAM_CLAUDE_ALLOW, ask: TEAM_CLAUDE_ASK } });
    expect(operationalLaunchArgs("claude-code", { teamPermissionDefault: true, permissionMode: "plan" })).toEqual([]);
  });

  it("executes the launch-provided hook via stdin without changing its input or settings", () => {
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true });
    const settings = JSON.parse(args[1]);
    expect(settings.permissions).toEqual({ allow: TEAM_CLAUDE_ALLOW });
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    expect(hook).toMatchObject({ type: "command", timeout: 5 });
    for (const [command, expected] of [["SoftwareTeam down --help", "allow"], ["/opt/tools/SoftwareTeam down example", "ask"]]) {
      const result = spawnSync("/bin/sh", ["-c", hook.command], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, permission_mode: "acceptEdits" }), encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: expected,
      } });
      expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toBeUndefined();
    }
    for (const input of ["invalid", JSON.stringify({ tool_name: "Read" }), JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install" } })]) {
      const result = spawnSync("/bin/sh", ["-c", hook.command], { input, encoding: "utf8" });
      expect(result.status).toBe(0); expect(result.stdout).toBe("");
    }
  });

  it("is self-contained under an install path with spaces and quotes", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hook 'path "));
    try {
      const copy = join(dir, "hook.cjs"); copyFileSync(asset, copy);
      const encoded = Buffer.from(JSON.stringify(policy)).toString("base64");
      const result = spawnSync("/bin/sh", ["-c", [process.execPath, copy, encoded].map(shellQuote).join(" ")], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "SoftwareTeam down --help" } }), encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
      expect(readFileSync(copy)).toEqual(readFileSync(asset));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
