import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { useSoftwareTeamSpecReview } from "../hooks/useSpecReview.js";
import {
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";
import { SoftwareTeamSpecDisplay } from "./SoftwareTeamSpecDisplay.js";

export function SoftwareTeamSpecReview() {
  const navigate = useNavigate();
  const { selectedSoftwareTeamDraft, currentSoftwareTeamDraft } = useSpecsWorkspace();
  const draft = selectedSoftwareTeamDraft ?? currentSoftwareTeamDraft;
  const { data: review, isLoading, error } = useSoftwareTeamSpecReview(draft?.yaml ?? null);
  const reviewPods = review?.pods ?? [];
  const reviewNodes = review?.nodes ?? [];
  const reviewEdges = review?.edges ?? [];

  if (!draft) {
    return (
      <WorkspacePage>
        <div data-testid="software-team-spec-review-empty" className="space-y-5">
          <WorkflowHeader
            eyebrow="SoftwareTeam Spec Review"
            title="No SoftwareTeamSpec Selected"
            description="Choose a current or recent SoftwareTeam draft from the Library drawer to review it here before you import or bootstrap it."
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/import" })}>
            Open Import
          </Button>
        </div>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <div data-testid="software-team-spec-review" className="space-y-6">
        <WorkflowHeader
          eyebrow="SoftwareTeam Spec Review"
          title={review?.name ?? draft.label}
          description={review?.summary ?? "Review the spec structure before import or bootstrap."}
          actions={(
            <>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/import" })}>
                Open In Import
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/bootstrap" })}>
                Bootstrap
              </Button>
            </>
          )}
        />

        {/* Summary cards */}
        {review && (
          <WorkflowSummaryGrid>
            <WorkflowSummaryCard
              label="Format"
              value={review.format === "pod_aware" ? "Pod-Aware" : "Legacy"}
              testId="software-team-spec-summary-format"
            />
            <WorkflowSummaryCard
              label={review.format === "pod_aware" ? "Pods" : "Nodes"}
              value={review.format === "pod_aware" ? reviewPods.length : reviewNodes.length}
              testId="software-team-spec-summary-pods"
            />
            <WorkflowSummaryCard
              label="Members"
              value={review.format === "pod_aware"
                ? reviewPods.reduce((sum, p) => sum + p.members.length, 0)
                : reviewNodes.length}
              testId="software-team-spec-summary-members"
            />
            <WorkflowSummaryCard
              label="Edges"
              value={reviewEdges.length + (review.format === "pod_aware"
                ? reviewPods.reduce((sum, p) => sum + (p.edges?.length ?? 0), 0)
                : 0)}
              testId="software-team-spec-summary-edges"
            />
          </WorkflowSummaryGrid>
        )}

        {/* Loading / Error */}
        {isLoading && <div className="font-mono text-[10px] text-on-surface-variant">Loading review...</div>}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 font-mono text-[10px] text-red-700">
            {(error as Error).message}
          </div>
        )}

        {/* Delegated display */}
        <SoftwareTeamSpecDisplay review={review} yaml={draft.yaml} yamlTestId="software-team-spec-yaml" />
      </div>
    </WorkspacePage>
  );
}
