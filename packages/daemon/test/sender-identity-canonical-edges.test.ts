// #131 follow-up (tests carried from #137 by Yi-111-a): the canonicalizer against its producer, its
// shape edges, and the provenance rules it must not disturb.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { canonicalSenderSession, requireSenderIdentity, resolveActorWithDeferral } from "../src/routes/require-sender-identity.js";
import { setSelfHostId, getSelfHostId } from "../src/domain/hosts/fanout-contract.js";
import { stampSelfHostSuffix } from "../src/domain/queue-repository.js";

const SELF = "host-7fe0ae96";

describe("canonicalSenderSession round-trips with the stampSelfHostSuffix producer", () => {
  let prior: string | null;
  beforeEach(() => { prior = getSelfHostId(); setSelfHostId(SELF); });
  afterEach(() => setSelfHostId(prior));

  it("undoes exactly what this host's stamp produces", () => {
    const bare = "orch@software-team-a";
    expect(stampSelfHostSuffix(bare)).toBe(`orch@software-team-a@${SELF}`);
    expect(canonicalSenderSession(stampSelfHostSuffix(bare))).toBe(bare);
  });
});

describe("canonicalSenderSession shape edges", () => {
  it("passes a 4-segment name through, even when it ends in the self id", () => {
    expect(canonicalSenderSession(`a@software-team@sub@${SELF}`, SELF)).toBe(`a@software-team@sub@${SELF}`);
  });
  it("does not treat @local or a near-miss host id as this host", () => {
    expect(canonicalSenderSession("qa@hc@local", SELF)).toBe("qa@hc@local");
    expect(canonicalSenderSession(`qa@hc@${SELF}-2`, SELF)).toBe(`qa@hc@${SELF}-2`);
  });
  it("leaves legacy flat names and virtual refs untouched", () => {
    expect(canonicalSenderSession("r01-legacy-flat", SELF)).toBe("r01-legacy-flat");
    expect(canonicalSenderSession("mike@external", SELF)).toBe("mike@external");
    expect(canonicalSenderSession("human@kernel", SELF)).toBe("human@kernel");
  });
});

describe("sender identity helpers keep provenance rules after canonicalization", () => {
  let prior: string | null;
  beforeEach(() => { prior = getSelfHostId(); setSelfHostId(SELF); });
  afterEach(() => setSelfHostId(prior));

  async function derive(
    helper: typeof requireSenderIdentity | typeof resolveActorWithDeferral,
    headers: Record<string, string>,
    bodyClaim?: string,
  ) {
    const app = new Hono();
    app.get("/", c => {
      const r = helper(c, { bodyClaim });
      return c.json(r.ok ? { session: r.session, provenance: r.provenance } : { error: true });
    });
    return (await app.request("/", { headers })).json();
  }

  for (const helper of [requireSenderIdentity, resolveActorWithDeferral]) {
    it(`${helper.name}: the origin-unknown marker survives the strip`, async () => {
      expect(await derive(helper, { "X-SoftwareTeam-Session": `qa@hc@${SELF}`, "X-SoftwareTeam-Origin-Unknown": "true" }))
        .toEqual({ session: "qa@hc", provenance: "origin-unknown:v1" });
    });

    it(`${helper.name}: the wire identity still supersedes a disagreeing body claim (P18)`, async () => {
      expect(await derive(helper, { "X-SoftwareTeam-Session": `qa@hc@${SELF}` }, "somebody-else@software-team"))
        .toEqual({ session: "qa@hc", provenance: "transport:v1" });
    });
  }
});
