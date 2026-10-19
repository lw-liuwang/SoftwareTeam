import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { expertRoles, prepareTeam, repositoryRoot } from "./software-team.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "software team-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "team"));
  writeFileSync(path.join(root, "team/rig.template.yaml"), readFileSync(path.join(repositoryRoot, "team/rig.template.yaml")));
  return root;
}

test("prepares seven separate repository-local seats with absolute workspace paths", t => {
  const root = fixture(t);
  const { spec, output } = prepareTeam(root, "claude-code");
  assert.equal(output, path.join(root, "team/rig.local.yaml"));
  assert.equal(spec.workspace.workspace_root, root);
  assert.equal(spec.workspace.repos[0].path, root);
  assert.equal(spec.workspace.knowledge_root, path.join(root, "team/knowledge"));
  const members = spec.pods.flatMap(pod => pod.members);
  assert.deepEqual(members.map(member => member.role), expertRoles);
  assert.equal(new Set(members.map(member => member.cwd)).size, 7);
  for (const member of members) {
    assert.equal(member.cwd, path.join(root, "team/workspaces", member.role));
    assert.equal(member.agent_ref, `path:${path.join(root, "packages/daemon/specs/agents/software-team", member.role)}`);
    assert.equal(member.runtime, "claude-code");
    assert.ok(existsSync(path.join(root, "team/records", member.role)));
    assert.ok(existsSync(path.join(root, "team/knowledge", member.role)));
  }
  assert.deepEqual(parse(readFileSync(output, "utf8")), spec);
});

test("re-preparing changes runtime without replacing knowledge, records or standards", t => {
  const root = fixture(t);
  prepareTeam(root);
  const durable = ["team/knowledge/facts.md", "team/knowledge/testing/experience.md", "team/records/testing/report.md", "team/standards.yaml"];
  for (const file of durable) writeFileSync(path.join(root, file), "existing human or expert work\n");
  prepareTeam(root, "claude-code");
  for (const file of durable) assert.equal(readFileSync(path.join(root, file), "utf8"), "existing human or expert work\n");
});

test("rejects an incomplete team and paths outside the project before creating launch output", t => {
  for (const mutate of [
    spec => spec.pods[0].members.pop(),
    spec => { spec.pods[0].members[0].cwd = "../../other-project"; },
  ]) {
    const root = fixture(t);
    const template = path.join(root, "team/rig.template.yaml");
    const spec = parse(readFileSync(template, "utf8"));
    mutate(spec);
    writeFileSync(template, stringify(spec));
    assert.throws(() => prepareTeam(root), /seven permanent experts|leaves the repository/);
    assert.equal(existsSync(path.join(root, "team/rig.local.yaml")), false);
  }
  assert.throws(() => prepareTeam(fixture(t), "unknown"), /Runtime/);
});
