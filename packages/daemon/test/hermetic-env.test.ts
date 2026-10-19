import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DAEMON_TARGET_ENV_VARS,
  detectForeignDaemonTarget,
  assertNoForeignDaemon,
  HermeticEnvError,
} from "./helpers/hermetic-env.js";

// Slice 51-02 — the hermetic env-discipline helper's FAIL-CLOSED guard (proof item 4,
// the safety keystone). If a live-daemon TARGET the helper did not create is present in
// the ambient env, the runner must REFUSE with a hard error naming the foreign target and
// send ZERO traffic to it — never a silent fallback to the ambient daemon.
describe("hermetic-env fail-closed guard", () => {
  it("refuses with a named HermeticEnvError when an ambient SOFTWARETEAM_URL is present", () => {
    const env = { SOFTWARETEAM_URL: "http://foreign-daemon:9999" };
    expect(() => assertNoForeignDaemon(env)).toThrow(HermeticEnvError);
    let msg = "";
    try {
      assertNoForeignDaemon(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    // The error must NAME the foreign target (var + value) so the operator can see it.
    expect(msg).toContain("SOFTWARETEAM_URL");
    expect(msg).toContain("http://foreign-daemon:9999");
  });

  it("names every inherited daemon-target var as a foreign target", () => {
    for (const v of DAEMON_TARGET_ENV_VARS) {
      const hit = detectForeignDaemonTarget({ [v]: "some-value" });
      expect(hit).not.toBeNull();
      expect(hit!.name).toBe(v);
      expect(() => assertNoForeignDaemon({ [v]: "some-value" })).toThrow(
        new RegExp(v),
      );
    }
  });

  it("reports the FIRST foreign target found (deterministic, ordered)", () => {
    const env = { SOFTWARETEAM_PORT: "7434", SOFTWARETEAM_URL: "http://x:1" };
    const hit = detectForeignDaemonTarget(env);
    // DAEMON_TARGET_ENV_VARS ordering is the detection order — URL precedes PORT.
    expect(hit!.name).toBe("SOFTWARETEAM_URL");
  });

  it("passes for a clean env with no foreign daemon target", () => {
    expect(detectForeignDaemonTarget({ HOME: "/x", PATH: "/y" })).toBeNull();
    expect(() => assertNoForeignDaemon({ HOME: "/x", PATH: "/y" })).not.toThrow();
  });

  it("ignores empty-string daemon-target vars (unset-equivalent)", () => {
    // An exported-but-empty var does not point at a daemon; treat it as absent.
    expect(detectForeignDaemonTarget({ SOFTWARETEAM_URL: "" })).toBeNull();
    expect(() => assertNoForeignDaemon({ SOFTWARETEAM_URL: "" })).not.toThrow();
  });
});

// The shared setup (test/hermetic-env.setup.ts) gives compaction packets a folder inside the fixture home, so a test
// that sets no root of its own never writes to the /tmp/claude-compaction-restore real seats use.
describe("hermetic-env setup: compaction packet folder", () => {
  it("defaults SOFTWARETEAM_COMPACTION_OUT_ROOT to a folder under the fixture-scoped home", () => {
    const home = process.env["SOFTWARETEAM_HOME"]!;
    const outRoot = process.env["SOFTWARETEAM_COMPACTION_OUT_ROOT"]!;
    expect(fs.existsSync(path.join(home, ".softwareteam-fixture"))).toBe(true);
    expect(outRoot).toBe(path.join(home, "compaction-packets"));
    expect(outRoot.startsWith("/tmp/claude-compaction-restore")).toBe(false);
  });
});
