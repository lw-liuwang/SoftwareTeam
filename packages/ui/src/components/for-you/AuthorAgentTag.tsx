// V1 attempt-3 Phase 4 — AuthorAgentTag with cmux launcher wired.
//
// Per agent-chat-surface.md L13–L21 V1 default: click → topology seat
// detail with cmux launcher button. Phase 3 stubbed the navigation;
// Phase 4 wires the cmux launcher itself via useCmuxLaunch (POST to
// /api/software-teams/$softwareTeamId/nodes/$logicalId/open-cmux — open-or-focus cmux
// surface semantics).
//
// Click semantics: Tag click → cmux launches (foregrounds the seat
// in cmux). The label stays a Link so right-click / cmd-click still
// open the seat detail page (URL preserved).

import { Link } from "@tanstack/react-router";
import { useCmuxLaunch } from "../../hooks/useCmuxLaunch.js";
import { ActorMark, isHumanActor } from "../graphics/RuntimeMark.js";
import { parseSessionName } from "../../lib/session-name.js";

interface AuthorAgentTagProps {
  authorSession: string;
  softwareTeamId?: string;
  className?: string;
  testId?: string;
}

function parseSeat(authorSession: string): { logicalId: string; softwareTeamId: string | null } {
  // OPR.0.4.6.MH1 FR-8: the shared parse contract; non-canonical names
  // render whole as the logical id (no softwareTeam link target).
  const parsed = parseSessionName(authorSession);
  if (parsed.kind !== "canonical") return { logicalId: authorSession, softwareTeamId: null };
  return { logicalId: parsed.member, softwareTeamId: parsed.softwareTeam };
}

export function AuthorAgentTag({ authorSession, softwareTeamId, className, testId }: AuthorAgentTagProps) {
  const parsed = parseSeat(authorSession);
  const targetSoftwareTeamId = softwareTeamId ?? parsed.softwareTeamId;
  const cmuxLaunch = useCmuxLaunch();
  const humanActor = isHumanActor(authorSession);

  // If we can't resolve a softwareTeamId, just show the tag without a link.
  if (!targetSoftwareTeamId) {
    return (
      <span
        data-testid={testId ?? "author-agent-tag"}
        className={className ?? "inline-flex items-center gap-1 font-mono text-[10px] text-on-surface-variant"}
      >
        {humanActor ? <ActorMark actor={authorSession} size="xs" /> : null}
        <span>{authorSession}</span>
      </span>
    );
  }

  return (
    <Link
      to="/topology/seat/$softwareTeamId/$logicalId"
      params={{ softwareTeamId: targetSoftwareTeamId, logicalId: encodeURIComponent(parsed.logicalId) }}
      data-testid={testId ?? "author-agent-tag"}
      onClick={(e) => {
        // Cmd/Ctrl-click or right-click → standard Link behavior (open seat detail).
        // Plain click → fire cmux launcher AND let Link navigate.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        cmuxLaunch.mutate({ softwareTeamId: targetSoftwareTeamId, logicalId: parsed.logicalId });
      }}
      className={
        className ??
        "inline-flex items-center gap-1 font-mono text-[10px] text-on-surface-variant hover:text-on-surface hover:underline"
      }
    >
      {humanActor ? <ActorMark actor={authorSession} size="xs" /> : null}
      <span>{authorSession}</span>
    </Link>
  );
}
