import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { expertRoles, prepareTeam, repositoryRoot } from "./software-team.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "software team-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "team"));
  writeFileSync(path.join(root, "team/software-team.template.yaml"), readFileSync(path.join(repositoryRoot, "team/software-team.template.yaml")));
  writeFileSync(path.join(root, 'team/PROJECT.md'), readFileSync(path.join(repositoryRoot, 'team/PROJECT.md')));
  return root;
}

test("prepares seven separate repository-local seats with absolute workspace paths", t => {
  const root = fixture(t);
  const { spec, output } = prepareTeam(root, "claude-code");
  assert.equal(output, path.join(root, "team/software-team.local.yaml"));
  assert.equal(spec.workspace.workspace_root, root);
  assert.equal(spec.workspace.repos[0].path, root);
  assert.equal(spec.workspace.knowledge_root, path.join(root, "team/knowledge"));
  const members = spec.pods.flatMap(pod => pod.members);
  assert.deepEqual(spec.pods.map(pod => [pod.id, pod.members.map(member => member.id)]), [
    ['product', ['manage-agent', 'need-agent']],
    ['dev', ['home-agent', 'code-agent', 'review-agent', 'test-agent', 'run-agent']],
  ]);
  assert.equal(spec.edges.length, 5);
  assert.ok(spec.edges.every(edge => edge.from === 'product.manage-agent' && edge.to.startsWith('dev.')));
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

test('custom names project the team, addresses and workflow guidance without changing group IDs', t => {
  const root = fixture(t);
  const { spec } = prepareTeam(root, 'codex', 'My_team-2');
  assert.equal(spec.name, 'My_team-2');
  assert.deepEqual(spec.pods.map(pod => pod.id), ['product', 'dev']);
  assert.equal(spec.startup.files[0].path, 'PROJECT.local.md');
  const startup = readFileSync(path.join(root, 'team/PROJECT.local.md'), 'utf8');
  assert.match(startup, /product-manage-agent@My_team-2/);
  assert.match(startup, /--software-team My_team-2/);
  assert.doesNotMatch(startup, /@software-team/);
});

test("re-preparing changes runtime without replacing knowledge, records or standards", t => {
  const root = fixture(t);
  prepareTeam(root);
  const durable = ["team/knowledge/facts.md", "team/knowledge/test-agent/experience.md", "team/records/test-agent/report.md", "team/standards.yaml"];
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
    const template = path.join(root, "team/software-team.template.yaml");
    const spec = parse(readFileSync(template, "utf8"));
    mutate(spec);
    writeFileSync(template, stringify(spec));
    assert.throws(() => prepareTeam(root), /seven permanent experts|leaves the repository/);
    assert.equal(existsSync(path.join(root, "team/software-team.local.yaml")), false);
  }
  assert.throws(() => prepareTeam(fixture(t), "unknown"), /Runtime/);
});

test('generated files and directory symlinks refuse before any output or workspace writes', t => {
  for (const relative of ['team/PROJECT.local.md', 'team/software-team.local.yaml', 'team/workspaces', 'team/knowledge', 'team/records']) {
    const root = fixture(t), outside = mkdtempSync(path.join(tmpdir(), 'team-sentinel-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const sentinel = path.join(outside, 'sentinel'); writeFileSync(sentinel, 'owner data');
    symlinkSync(relative.endsWith('.md') || relative.endsWith('.yaml') ? sentinel : outside, path.join(root, relative));
    assert.throws(() => prepareTeam(root), /Unsafe generated path/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'owner data');
    assert.equal(existsSync(path.join(root, 'team/workspaces/code-agent')), false);
    if (relative !== 'team/PROJECT.local.md') assert.equal(existsSync(path.join(root, 'team/PROJECT.local.md')), false);
  }
});
