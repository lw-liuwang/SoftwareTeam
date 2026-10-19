import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { infoRoutes } from "../src/routes/info.js";
import { getSoftwareTeamInstallRoot } from "../src/domain/cwd-resolution.js";

// OPR.0.3.2.22 Bug 3 — daemon-info surface for tactical CLI awareness
// paths. The CLI consumes /api/info to decide when path-form
// `SoftwareTeam up <spec>` lands inside the SoftwareTeam install (the case that
// trips getSoftwareTeamInstallCwdError at preflight unless --cwd is given).
describe("GET /api/info", () => {
  it("returns the daemon installRoot computed from cwd-resolution", async () => {
    const app = new Hono();
    app.route("/api/info", infoRoutes());

    const res = await app.request("/api/info");
    expect(res.status).toBe(200);
    const body = await res.json() as { installRoot: string };
    expect(body.installRoot).toBe(getSoftwareTeamInstallRoot());
    expect(typeof body.installRoot).toBe("string");
    expect(body.installRoot.length).toBeGreaterThan(0);
  });
});
