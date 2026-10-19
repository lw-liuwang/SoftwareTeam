import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const original = { SOFTWARETEAM_HOME: process.env.SOFTWARETEAM_HOME, OPENRIG_HOME: process.env.OPENRIG_HOME, RIGGED_HOME: process.env.RIGGED_HOME };

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  vi.resetModules();
  vi.restoreAllMocks();
});

describe("softwareteam-compat", () => {
  it("getSoftwareTeamHome prefers SOFTWARETEAM_HOME when set", async () => {
    process.env.SOFTWARETEAM_HOME = "/tmp/custom-softwareteam-home";

    const mod = await import("../src/softwareteam-compat.js");

    expect(mod.getSoftwareTeamHome()).toBe("/tmp/custom-softwareteam-home");
    expect(mod.getDefaultSoftwareTeamPath("daemon.json")).toBe("/tmp/custom-softwareteam-home/daemon.json");
  });

  it("ignores legacy selectors and uses a fresh default without warnings", async () => {
    delete process.env.SOFTWARETEAM_HOME;
    process.env.OPENRIG_HOME = "/tmp/legacy-openrig-home";
    process.env.RIGGED_HOME = "/tmp/legacy-rigged-home";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await import("../src/softwareteam-compat.js");

    expect(mod.getSoftwareTeamHome()).toMatch(/[/\\]\.softwareteam$/);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("OPR.0.4.3.12 — isFixtureScopedHome (path-only predicate)", () => {
  const created: string[] = [];
  afterEach(() => {
    while (created.length) {
      const dir = created.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true for a home containing the .softwareteam-fixture sentinel marker", async () => {
    const { isFixtureScopedHome, FIXTURE_HOME_MARKER } = await import("../src/softwareteam-compat.js");
    // A marker in an ARBITRARY (non-temp-convention) dir still counts — the
    // explicit sentinel is the most-honest signal and is location-independent.
    const dir = mkdtempSync(join(homedir(), ".softwareteam-compat-test-"));
    created.push(dir);
    writeFileSync(join(dir, FIXTURE_HOME_MARKER), "");
    expect(isFixtureScopedHome(dir)).toBe(true);
  });

  it("true for an softwareteam-qa* home under a temp root (no marker needed)", async () => {
    const { isFixtureScopedHome } = await import("../src/softwareteam-compat.js");
    expect(isFixtureScopedHome(join(tmpdir(), "softwareteam-qa-abc123-home"))).toBe(true);
    expect(isFixtureScopedHome("/tmp/softwareteam-qa-run-xyz")).toBe(true);
  });

  it("false for the real default home (~/.softwareteam)", async () => {
    const { isFixtureScopedHome } = await import("../src/softwareteam-compat.js");
    expect(isFixtureScopedHome(join(homedir(), ".softwareteam"))).toBe(false);
  });

  it("false for a plain temp home that is not an softwareteam-qa fixture and has no marker", async () => {
    const { isFixtureScopedHome } = await import("../src/softwareteam-compat.js");
    const dir = mkdtempSync(join(tmpdir(), "plain-home-"));
    created.push(dir);
    expect(isFixtureScopedHome(dir)).toBe(false);
  });

  it("false for an softwareteam-qa-named path OUTSIDE any temp root (no marker)", async () => {
    const { isFixtureScopedHome } = await import("../src/softwareteam-compat.js");
    // Name alone is not enough — must be under a temp root OR carry the marker.
    // HOME may itself be an isolated temp directory; this negative path must not be.
    expect(isFixtureScopedHome("/home/test-user/softwareteam-qa-not-a-fixture")).toBe(false);
  });

  it("false for an empty string", async () => {
    const { isFixtureScopedHome } = await import("../src/softwareteam-compat.js");
    expect(isFixtureScopedHome("")).toBe(false);
  });
});
