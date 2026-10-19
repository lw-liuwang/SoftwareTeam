import { describe, it, expect } from "vitest";
import { scopeForTarget } from "../src/domain/session-transport.js";

// Send/broadcast header (ruling 03c35295) — TargetSpec → EnvelopeScope mapping. The transport fan-out
// knows the target shape + the resolved recipient set, so it builds the honest scale scope daemon-side
// (a recipient tells DM vs multi vs software-team-broadcast vs topology from the header alone — the anti-storm teeth).

describe("scopeForTarget — TargetSpec → EnvelopeScope (daemon-side scale truth)", () => {
  it("{session} → dm", () => {
    expect(scopeForTarget({ session: "a@r" }, ["a@r"])).toEqual({ kind: "dm" });
  });
  it("{sessions} → multi with the full recipient list", () => {
    expect(scopeForTarget({ sessions: ["a@r", "b@r"] }, ["a@r", "b@r"])).toEqual({ kind: "multi", recipients: ["a@r", "b@r"] });
  });
  it("{softwareTeam} → software-team-broadcast with the seat count (the anti-storm scale)", () => {
    expect(scopeForTarget({ softwareTeam: "softwareteam-pm" }, ["a@pm", "b@pm", "c@pm"])).toEqual({ kind: "software-team-broadcast", softwareTeam: "softwareteam-pm", seats: 3 });
  });
  it("{pod, softwareTeam} → a scoped broadcast labeled <softwareTeam>/<pod>", () => {
    expect(scopeForTarget({ pod: "dev", softwareTeam: "pm" }, ["a@pm", "b@pm"])).toEqual({ kind: "software-team-broadcast", softwareTeam: "pm/dev", seats: 2 });
  });
  it("{global} → topology", () => {
    expect(scopeForTarget({ global: true }, ["a@r", "b@x"])).toEqual({ kind: "topology" });
  });
});
