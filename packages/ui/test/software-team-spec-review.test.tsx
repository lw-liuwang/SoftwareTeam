import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { SoftwareTeamSpecReview } from "../src/components/SoftwareTeamSpecReview.js";
import { SpecsWorkspaceProvider, SPECS_WORKSPACE_STORAGE_KEYS } from "../src/components/SpecsWorkspace.js";

function renderReview() {
  return render(
    createAppTestRouter({
      routes: [
        { path: "/specs/softwareTeam", component: SoftwareTeamSpecReview },
        { path: "/import", component: () => <div data-testid="import-route">import</div> },
        { path: "/bootstrap", component: () => <div data-testid="bootstrap-route">bootstrap</div> },
      ],
      initialPath: "/specs/softwareTeam",
      rootComponent: ({ children }) => <SpecsWorkspaceProvider>{children}</SpecsWorkspaceProvider>,
    }),
  );
}

describe("SoftwareTeamSpecReview", () => {
  afterEach(() => {
    window.localStorage.clear();
    cleanup();
  });

  it("renders an empty review state when no SoftwareTeam draft exists", async () => {
    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId("software-team-spec-review-empty")).toBeDefined();
    });

    expect(screen.getByText("No SoftwareTeamSpec Selected")).toBeDefined();
  });

  it("renders a read-only summary and yaml preview for the current SoftwareTeam draft", async () => {
    window.localStorage.setItem(SPECS_WORKSPACE_STORAGE_KEYS.currentSoftwareTeamDraft, JSON.stringify({
      id: "software-team-demo",
      kind: "softwareTeam",
      label: "demo-software-team",
      yaml: [
        'version: "0.2"',
        "name: demo-software-team",
        "pods:",
        "  - id: orch",
        "    members:",
        '      - id: lead',
        '        agent_ref: "local:agents/lead"',
        "    edges: []",
        "  - id: dev",
        "    members:",
        '      - id: impl',
        '        agent_ref: "local:agents/impl"',
        "edges:",
        "  - kind: delegates_to",
      ].join("\n"),
      updatedAt: Date.now(),
    }));

    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId("software-team-spec-review")).toBeDefined();
    });

    // Draft label shows immediately (before daemon review loads)
    expect(screen.getByText("demo-software-team")).toBeDefined();
    // Tabs should be present
    expect(screen.getByTestId("tab-topology")).toBeDefined();
    expect(screen.getByTestId("tab-configuration")).toBeDefined();
    expect(screen.getByTestId("tab-yaml")).toBeDefined();
    // YAML tab shows raw content
    fireEvent.click(screen.getByTestId("tab-yaml"));
    await waitFor(() => {
      expect(screen.getByTestId("software-team-spec-yaml").textContent).toContain('agent_ref: "local:agents/lead"');
    });
  });

  it("draft review of a service-backed SoftwareTeam does not show environment tab", async () => {
    window.localStorage.setItem(SPECS_WORKSPACE_STORAGE_KEYS.currentSoftwareTeamDraft, JSON.stringify({
      id: "software-team-svc",
      kind: "softwareTeam",
      label: "svc-software-team",
      yaml: [
        'version: "0.2"',
        "name: svc-software-team",
        "services:",
        "  kind: compose",
        "  compose_file: svc.compose.yaml",
        "  wait_for:",
        '    - url: http://127.0.0.1:8200/health',
        "pods:",
        "  - id: dev",
        "    members:",
        '      - id: impl',
        '        agent_ref: "local:agents/impl"',
        "    edges: []",
      ].join("\n"),
      updatedAt: Date.now(),
    }));

    renderReview();

    await waitFor(() => {
      expect(screen.getByTestId("software-team-spec-review")).toBeDefined();
    });

    // Standard tabs present
    expect(screen.getByTestId("tab-topology")).toBeDefined();
    expect(screen.getByTestId("tab-configuration")).toBeDefined();
    expect(screen.getByTestId("tab-yaml")).toBeDefined();
    // Environment tab must NOT appear in draft/open-file review
    expect(screen.queryByTestId("tab-environment")).toBeNull();
  });

  it("links the review surface back into import and bootstrap flows", async () => {
    window.localStorage.setItem(SPECS_WORKSPACE_STORAGE_KEYS.currentSoftwareTeamDraft, JSON.stringify({
      id: "software-team-demo",
      kind: "softwareTeam",
      label: "demo-software-team",
      yaml: "name: demo-software-team\npods: []\n",
      updatedAt: Date.now(),
    }));

    renderReview();

    await waitFor(() => {
      expect(screen.getByText("Open In Import")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Open In Import"));

    await waitFor(() => {
      expect(screen.getByTestId("import-route")).toBeDefined();
    });
  });
});
