// OPR.0.4.3.28 B1+B3 — the relay resolves the ingest URL + token without the
// operator seeding SOFTWARETEAM_URL/SOFTWARETEAM_ACTIVITY_HOOK_TOKEN into the shell.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/softwareteam-core/hooks/scripts/activity-relay.cjs") as {
  resolveEndpoint: (env: Record<string, string | undefined>) => { baseUrl?: string; token?: string };
  buildSoftwareTeamPayload: (
    providerPayload: Record<string, unknown>,
    env: Record<string, string | undefined>,
    now?: () => Date,
  ) => Record<string, unknown> | null;
};

describe("activity-relay resolveEndpoint (OPR.0.4.3.28 B1+B3)", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "softwareteam-relay-")); });
  afterEach(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("fast path: env SOFTWARETEAM_URL + token are used verbatim", () => {
    const r = relay.resolveEndpoint({ SOFTWARETEAM_URL: "http://d:9999", SOFTWARETEAM_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r).toEqual({ baseUrl: "http://d:9999", token: "tok" });
  });

  it("B1: synthesizes the base URL from SOFTWARETEAM_HOST + SOFTWARETEAM_PORT when URL is absent", () => {
    const r = relay.resolveEndpoint({ SOFTWARETEAM_HOST: "10.0.0.5", SOFTWARETEAM_PORT: "7434", SOFTWARETEAM_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r.baseUrl).toBe("http://10.0.0.5:7434");
    expect(r.token).toBe("tok");
  });

  it("B1: defaults host to 127.0.0.1 when only PORT is present", () => {
    const r = relay.resolveEndpoint({ SOFTWARETEAM_PORT: "7434", SOFTWARETEAM_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r.baseUrl).toBe("http://127.0.0.1:7434");
  });

  it("B3: file-discovery supplies url+token for a reconcile/restored seat (no env vars)", () => {
    fs.writeFileSync(nodePath.join(home, "activity-endpoint.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:7434", token: "filetok" }));
    // Frozen env has only SOFTWARETEAM_HOME (inherited), no url/token.
    const r = relay.resolveEndpoint({ SOFTWARETEAM_HOME: home });
    expect(r.baseUrl).toBe("http://127.0.0.1:7434");
    expect(r.token).toBe("filetok");
  });

  it("B3: file-discovery fills only the MISSING piece (env token wins, file supplies url)", () => {
    fs.writeFileSync(nodePath.join(home, "activity-endpoint.json"), JSON.stringify({ baseUrl: "http://file:1", token: "filetok" }));
    const r = relay.resolveEndpoint({ SOFTWARETEAM_HOME: home, SOFTWARETEAM_ACTIVITY_HOOK_TOKEN: "envtok" });
    expect(r.token).toBe("envtok"); // env token not overwritten
    expect(r.baseUrl).toBe("http://file:1");
  });

  it("safe no-op: nothing in env and no discoverable file → undefined url/token", () => {
    const r = relay.resolveEndpoint({ SOFTWARETEAM_HOME: home }); // home has no endpoint.json
    expect(r.baseUrl).toBeFalsy();
    expect(r.token).toBeFalsy();
  });
});

describe("activity-relay occupant generation carry (W2a producer)", () => {
  const identity = {
    SOFTWARETEAM_SESSION_NAME: "dev-qa@producer-software-team",
    SOFTWARETEAM_NODE_ID: "node-1",
    SOFTWARETEAM_RUNTIME: "codex",
  };

  it("carries the exact launch generation", () => {
    const payload = relay.buildSoftwareTeamPayload(
      { hookEvent: "Stop" },
      { ...identity, SOFTWARETEAM_OCCUPANT_GENERATION: "generation-A" },
      () => new Date("2026-08-09T00:00:00.000Z"),
    );
    expect(payload).toMatchObject({ generation: "generation-A" });
  });

  it("emits explicit null when the launch generation is absent", () => {
    const payload = relay.buildSoftwareTeamPayload(
      { hookEvent: "Stop" },
      identity,
      () => new Date("2026-08-09T00:00:00.000Z"),
    );
    expect(payload).toHaveProperty("generation", null);
  });
});
