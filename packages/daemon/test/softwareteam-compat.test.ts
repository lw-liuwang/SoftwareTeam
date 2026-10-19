import { afterEach, describe, expect, it, vi } from "vitest";

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
