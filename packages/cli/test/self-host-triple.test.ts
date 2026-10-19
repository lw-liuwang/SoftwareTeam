// SUPERSEDED CONTRACT FLIPPED (founder root invariant 2026-08-27, was 51-09 always-suffix):
// wrapSendBody renders the sender EXACTLY AS RECEIVED. The origin triple is constructed only
// at the cross-host forwarding boundary (send.ts runHttpHostSend / the ssh executor's
// SOFTWARETEAM_SESSION_NAME), never inside the wrapper. Byte-parity anchor with the daemon twin
// (daemon/test/self-host-envelope-triple.test.ts holds the same literal).
import { describe, it, expect } from "vitest";
import { wrapSendBody } from "../src/commands/send.js";

const SENDER = "dev50-driver@v-softwareteam-build";

describe("wrapSendBody — bare-as-received sender", () => {
  it("renders the BARE local sender in BOTH From: and the reply hint (byte-identical to the daemon twin)", () => {
    const out = wrapSendBody(SENDER, "guard@my-software-team", "hi");
    expect(out).toBe(
      'From: dev50-driver@v-softwareteam-build\nTo: guard@my-software-team\n---\nhi\n---\n\u21a9 Reply: SoftwareTeam send dev50-driver@v-softwareteam-build "..."',
    );
  });

  it("a boundary-constructed ORIGIN triple renders verbatim", () => {
    const out = wrapSendBody(`${SENDER}@mm2-softwareteam1`, "guard@my-software-team", "hi");
    expect(out).toContain(`From: ${SENDER}@mm2-softwareteam1`);
    expect(out).toContain(`\u21a9 Reply: SoftwareTeam send ${SENDER}@mm2-softwareteam1 "..."`);
  });

  it("the unknown-sender fallback is never suffixed", () => {
    const out = wrapSendBody(undefined, "guard@my-software-team", "hi");
    expect(out).toContain("From: <unknown sender>");
    expect(out).toContain('\u21a9 Reply: SoftwareTeam send <unknown sender> "..."');
  });
});
