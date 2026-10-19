import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { SoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import { SoftwareTeamSpecCodec } from "../src/domain/software-team-spec-codec.js";
import { SoftwareTeamSpecExporter } from "../src/domain/software-team-spec-exporter.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import type { SoftwareTeamSpec } from "../src/domain/types.js";
import {
  mergeSeatEnv,
  parseSeatEnvAssignment,
  seatEnvLaunchVars,
  SEAT_ENV_KEYS_VAR,
} from "../src/domain/seat-env.js";
import { createFullTestDb } from "./helpers/test-app.js";

function softwareTeamWith(overrides: { softwareTeam?: Record<string, unknown>; member?: Record<string, unknown> }) {
  return {
    version: "0.2",
    name: "env-software-team",
    ...overrides.softwareTeam,
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", ...overrides.member }],
      edges: [],
    }],
    edges: [],
  };
}

describe("env: in software-team.yaml", () => {
  it("accepts env at SoftwareTeam level and member level and normalizes both", () => {
    const raw = softwareTeamWith({ softwareTeam: { env: { SOFTWARE_TEAM_FLAG: "1" } }, member: { env: { MEMBER_FLAG: "two", SOFTWARE_TEAM_FLAG: "member-wins" } } });
    expect(SoftwareTeamSpecSchema.validate(raw)).toMatchObject({ valid: true });
    const spec = SoftwareTeamSpecSchema.normalize(raw as Record<string, unknown>);
    expect(spec.env).toEqual({ SOFTWARE_TEAM_FLAG: "1" });
    expect(spec.pods[0]!.members[0]!.env).toEqual({ MEMBER_FLAG: "two", SOFTWARE_TEAM_FLAG: "member-wins" });
  });

  it("leaves env undefined when none is declared", () => {
    const spec = SoftwareTeamSpecSchema.normalize(softwareTeamWith({}) as Record<string, unknown>);
    expect(spec.env).toBeUndefined();
    expect(spec.pods[0]!.members[0]!.env).toBeUndefined();
  });

  it.each([
    ["a lowercase name", { env: { lower: "x" } }, 'env.lower'],
    ["a name starting with a digit", { env: { "1BAD": "x" } }, 'env.1BAD'],
    ["a name with a dash", { env: { "BAD-NAME": "x" } }, 'env.BAD-NAME'],
    ["a reserved SOFTWARETEAM_ name", { env: { SOFTWARETEAM_URL: "http://elsewhere" } }, "reserved"],
    ["a number value", { env: { COUNT: 3 } }, "must be a string"],
    ["a boolean value", { env: { FLAG: true } }, "must be a string"],
    ["an empty value", { env: { EMPTY: "" } }, "must not be empty"],
    ["a list", { env: ["A=1"] }, "must be a mapping"],
    ["null", { env: null }, "must be a mapping"],
  ])("refuses %s at SoftwareTeam level", (_label, softwareTeam, fragment) => {
    const result = SoftwareTeamSpecSchema.validate(softwareTeamWith({ softwareTeam }));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(fragment);
  });

  it("refuses the same mistakes at member level and names the member path", () => {
    const result = SoftwareTeamSpecSchema.validate(softwareTeamWith({ member: { env: { SOFTWARETEAM_NODE_ID: "x", ok: "y" } } }));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("pods[0].members[0].env.SOFTWARETEAM_NODE_ID");
    expect(result.errors.join("\n")).toContain("pods[0].members[0].env.ok");
  });

  it("round-trips through serialize and parse", () => {
    const spec = SoftwareTeamSpecSchema.normalize(softwareTeamWith({ softwareTeam: { env: { A: "1" } }, member: { env: { B: "2" } } }) as Record<string, unknown>) as SoftwareTeamSpec;
    const parsed = SoftwareTeamSpecCodec.parse(SoftwareTeamSpecCodec.serialize(spec));
    expect(SoftwareTeamSpecSchema.validate(parsed).valid).toBe(true);
    const again = SoftwareTeamSpecSchema.normalize(parsed as Record<string, unknown>);
    expect(again.env).toEqual({ A: "1" });
    expect(again.pods[0]!.members[0]!.env).toEqual({ B: "2" });
  });
});

describe("--env KEY=VALUE", () => {
  it("splits at the first equals sign so a value can contain one", () => {
    expect(parseSeatEnvAssignment("URL=http://x/?a=b")).toEqual({ ok: true, name: "URL", value: "http://x/?a=b" });
  });

  it.each(["NOEQUALS", "=value", "lower=x", "SOFTWARETEAM_HOME=/x", "EMPTY="])("refuses %s", (text) => {
    expect(parseSeatEnvAssignment(text).ok).toBe(false);
  });
});

describe("merging", () => {
  it("applies softwareTeam, then member, then a one-off override", () => {
    expect(mergeSeatEnv({ A: "softwareTeam", B: "softwareTeam" }, { B: "member", C: "member" }, { C: "override" }))
      .toEqual({ A: "softwareTeam", B: "member", C: "override" });
  });

  it("lists the declared names for the managed Claude launch, and nothing when none are declared", () => {
    expect(seatEnvLaunchVars({ A: "1", B: "2" })).toEqual({ A: "1", B: "2", [SEAT_ENV_KEYS_VAR]: "A,B" });
    expect(seatEnvLaunchVars({})).toEqual({});
  });
});

describe("persisted env", () => {
  let db: Database.Database;
  afterEach(() => db.close());

  it("stores SoftwareTeam env and member env apart, reads them merged, and exports both", () => {
    db = createFullTestDb();
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const podRepo = new PodRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("env-software-team");
    const pod = podRepo.createPod(softwareTeam.id, "dev", "Dev");
    const impl = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code", podId: pod.id, agentRef: "local:a", profile: "p", cwd: ".", env: { SHARED: "member", ONLY_MEMBER: "m" } });
    const plain = softwareTeamRepo.addNode(softwareTeam.id, "dev.plain", { runtime: "codex", podId: pod.id, agentRef: "local:b", profile: "p", cwd: "." });
    softwareTeamRepo.setSoftwareTeamEnv(softwareTeam.id, { SHARED: "softwareTeam", ONLY_SOFTWARE_TEAM: "r" });

    expect(softwareTeamRepo.getEffectiveSeatEnv(impl.id)).toEqual({ SHARED: "member", ONLY_MEMBER: "m", ONLY_SOFTWARE_TEAM: "r" });
    expect(softwareTeamRepo.getEffectiveSeatEnv(plain.id)).toEqual({ SHARED: "softwareTeam", ONLY_SOFTWARE_TEAM: "r" });

    const exported = new SoftwareTeamSpecExporter({ softwareTeamRepo, sessionRegistry: new SessionRegistry(db), podRepo }).exportSoftwareTeam(softwareTeam.id) as SoftwareTeamSpec;
    expect(exported.env).toEqual({ SHARED: "softwareTeam", ONLY_SOFTWARE_TEAM: "r" });
    const members = exported.pods[0]!.members;
    expect(members.find((m) => m.id === "impl")!.env).toEqual({ SHARED: "member", ONLY_MEMBER: "m" });
    expect(members.find((m) => m.id === "plain")!.env).toBeUndefined();
  });
});
