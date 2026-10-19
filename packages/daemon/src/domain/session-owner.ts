import type Database from "better-sqlite3";

export interface SessionOwnerRow {
  node_id: string;
  logical_id: string;
  software_team_name: string;
}

/**
 * The OTHER managed node that currently owns a tmux session name, if any: a node whose binding names
 * it, or a node with a live (not superseded, detached or exited) session row under it. A session name
 * can be shared across softwareTeams, for example by an archived duplicate of a live softwareTeam, so the name alone
 * never proves which node a session belongs to. `ignoreArchived` skips owners in archived softwareTeams: an
 * archived softwareTeam keeps its bindings, so its node would otherwise claim the live seat's session.
 * `excludeNodeIds` skips further nodes, such as the rest of a group being removed together; it is applied
 * in both lookups before the first match is taken, so an excluded node can't hide another owner.
 */
export function findOtherSessionOwner(
  db: Database.Database,
  tmuxSession: string,
  nodeId: string,
  opts?: { ignoreArchived?: boolean; excludeNodeIds?: readonly string[] },
): SessionOwnerRow | null {
  const live = opts?.ignoreArchived ? " AND r.archived_at IS NULL" : "";
  const excluded = [nodeId, ...(opts?.excludeNodeIds ?? [])];
  const notExcluded = `n.id NOT IN (${excluded.map(() => "?").join(", ")})`;
  const bindingOwner = db.prepare(`
    SELECT n.id AS node_id, n.logical_id, r.name AS software_team_name
    FROM bindings b
    JOIN nodes n ON n.id = b.node_id
    JOIN software_teams r ON r.id = n.software_team_id
    WHERE b.tmux_session = ? AND ${notExcluded}${live}
    LIMIT 1
  `).get(tmuxSession, ...excluded) as SessionOwnerRow | undefined;
  if (bindingOwner) return bindingOwner;

  return db.prepare(`
    SELECT n.id AS node_id, n.logical_id, r.name AS software_team_name
    FROM sessions s
    JOIN nodes n ON n.id = s.node_id
    JOIN software_teams r ON r.id = n.software_team_id
    WHERE s.session_name = ? AND ${notExcluded} AND s.status NOT IN ('superseded', 'detached', 'exited')${live}
    LIMIT 1
  `).get(tmuxSession, ...excluded) as SessionOwnerRow | undefined ?? null;
}
