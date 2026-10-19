import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { options, childEnvironment, readiness, validateState, prerequisites, expertLogicalId, rowsFromResult, terminalFacts, isBuildInput, acquireControllerLock } from './softwareteam.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'softwareteam install '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = path.join(root, 'tools'), project = path.join(root, 'source with spaces'), home = path.join(root, 'owner'), state = path.join(root, 'new state');
  for (const d of [tools, home, path.join(project, 'scripts'), path.join(project, 'packages/cli')]) fs.mkdirSync(d, { recursive: true });
  for (const name of ['install.sh', 'start.sh', 'SoftwareTeam']) fs.copyFileSync(path.join(import.meta.dirname, '..', name), path.join(project, name));
  fs.copyFileSync(path.join(import.meta.dirname, 'softwareteam.mjs'), path.join(project, 'scripts/softwareteam.mjs'));
  fs.writeFileSync(path.join(project, 'package-lock.json'), '{}');
  fs.symlinkSync(process.execPath, path.join(tools, 'node'));
  const script = (name, source) => fs.writeFileSync(path.join(tools, name), `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  script('git', `if(process.argv.includes('rev-parse')) console.log('${'a'.repeat(40)}'); else if(process.argv.includes('ls-files')) process.stdout.write('package-lock.json\\0scripts/softwareteam.mjs\\0');`);
  script('tmux', 'process.exit(0);');
  script('codex', 'process.exit(process.env.AUTHENTICATED === "1" ? 0 : 1);');
  script('rig', 'require("node:fs").appendFileSync(process.env.CALLS,"UNEXPECTED OLD COMMAND\\n");process.exit(99);');
  script('npm', `
const fs=require('node:fs'),path=require('node:path');
const a=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify({args:a,home:process.env.HOME,old:!!process.env.OPENRIG_URL,newHome:process.env.SOFTWARETEAM_HOME})+'\\n');
if(process.env.FAIL_STAGE===a[0])process.exit(23);
if(a[0]==='pack'){const dest=a[a.indexOf('--pack-destination')+1];fs.writeFileSync(path.join(dest,'softwareteam-cli-0.6.12.tgz'),'fixture artifact');console.log(JSON.stringify([{filename:'softwareteam-cli-0.6.12.tgz',name:'@softwareteam/cli',version:'0.6.12'}]));}
if(a[0]==='install'){const prefix=a[a.indexOf('--prefix')+1];const entry=path.join(prefix,'node_modules/@softwareteam/cli/dist/bin-wrapper.js');fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,process.env.MOCK_ENTRY_SOURCE ? fs.readFileSync(process.env.MOCK_ENTRY_SOURCE) : '#!/usr/bin/env node\\nconsole.log(process.argv.includes("--version") ? "0.6.12" : "SoftwareTeam fixture help");',{mode:0o755});}
`);
  const calls = path.join(root, 'calls');
  const env = { ...process.env, HOME: home, PATH: `${tools}:/usr/bin:/bin`, CALLS: calls, OPENRIG_URL: 'http://old.invalid:7433', RIGGED_HOME: path.join(home, '.rigged') };
  for (const key of Object.keys(env)) if (key.startsWith('SOFTWARETEAM_')) delete env[key];
  return { root, project, state, env, calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [], run: (action, args = [], extra = {}) => spawnSync('/bin/sh', [path.join(project, `${action}.sh`), '--state-dir', state, ...args], { cwd: os.tmpdir(), env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000 }) };
}

test('cold help and dry-run work from an unrelated cwd with no node_modules and no writes', t => {
  const f = fixture(t);
  for (const flag of ['--help', '--dry-run', '--check']) {
    const result = f.run('start', [flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(f.state), false);
    assert.deepEqual(f.calls(), []);
  }
});
test('invalid options and runtime fail before mutation', t => {
  const f = fixture(t);
  for (const args of [['--runtime', 'stub'], ['--unknown'], ['--port', '0'], ...['', '../bad', 'a@host', 'a.b', 'external', 'kernel'].map(name => ['--name', name])]) {
    assert.notEqual(f.run('start', args).status, 0);
    assert.equal(fs.existsSync(f.state), false);
  }
});
test('custom team name persists, omitted name reuses it, and mismatch refuses without writes', t => {
  const f = fixture(t);
  assert.equal(f.run('install', ['--name', 'My_team-2']).status, 0);
  const file = path.join(f.state, 'controller.json'), before = fs.readFileSync(file);
  assert.equal(JSON.parse(before).name, 'My_team-2');
  const repeat = f.run('start', ['--dry-run']);
  assert.equal(JSON.parse(repeat.stdout).name, 'My_team-2');
  const refused = f.run('start', ['--name', 'other']);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /fresh --state-dir/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(f.calls().length, 5);
});
test('local installation repairs cold tool bins, pins the artifact, and is idempotent', t => {
  const f = fixture(t);
  const first = f.run('install', ['--runtime', 'codex', '--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).installed, true);
  const calls = f.calls();
  assert.deepEqual(calls.map(c => c.args[0]), ['ci', 'rebuild', 'run', 'pack', 'install']);
  assert.ok(calls[0].args.includes('--bin-links=false'));
  assert.ok(calls.every(c => !c.old && c.home === path.join(f.state, 'account')));
  const entry = path.join(f.state, 'bin/SoftwareTeam');
  assert.equal(spawnSync(entry, ['--version'], { env: f.env, encoding: 'utf8' }).stdout.trim(), '0.6.12');
  const repeat = f.run('install');
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(f.calls().length, calls.length);
});
test('receipt is reread under the lock after another installer changes the team name', t => {
  const f = fixture(t);
  assert.equal(f.run('install', ['--name', 'first']).status, 0);
  const file = path.join(f.state, 'controller.json');
  const git = path.join(f.root, 'tools/git');
  fs.appendFileSync(git, `\nif(process.argv.includes('ls-files') && process.env.INTERLEAVE_RECEIPT){const fs=require('node:fs');const p=process.env.INTERLEAVE_RECEIPT;const r=JSON.parse(fs.readFileSync(p));r.name='second';fs.writeFileSync(p,JSON.stringify(r));}\n`);
  const result = f.run('install', ['--name', 'first'], { INTERLEAVE_RECEIPT: file });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Instance team name is second/);
  assert.equal(JSON.parse(fs.readFileSync(file)).name, 'second');
  assert.equal(f.calls().length, 5);
  assert.equal(fs.existsSync(path.join(f.state, 'controller.lock')), false);
});
test('failed dependency installation propagates status, prevents later phases and can retry', t => {
  const f = fixture(t);
  const failed = f.run('start', [], { FAIL_STAGE: 'ci' });
  assert.equal(failed.status, 23, failed.stderr);
  assert.match(failed.stderr, /dependency installation failed/);
  assert.deepEqual(f.calls().map(c => c.args[0]), ['ci']);
  assert.equal(fs.existsSync(path.join(f.state, 'daemon.json')), false);
  assert.equal(f.run('install').status, 0);
});

test('stale locks are never automatically reclaimed and release preserves replacement ownership', t => {
  const f = fixture(t), lock = path.join(f.root, 'lock');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), '2147483647');
  for (let i = 0; i < 2; i++) assert.throws(() => acquireControllerLock(lock), /manually recover/);
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), '2147483647');
  fs.rmSync(lock, { recursive: true });
  const release = acquireControllerLock(lock);
  assert.throws(() => acquireControllerLock(lock), /no concurrent launch/);
  fs.renameSync(lock, `${lock}-old`);
  const replacementRelease = acquireControllerLock(lock);
  const owner = fs.readFileSync(path.join(lock, 'owner'));
  release(); assert.deepEqual(fs.readFileSync(path.join(lock, 'owner')), owner);
  replacementRelease(); assert.equal(fs.existsSync(lock), false);
});

test('corrupt persisted name/runtime refuse before mutations including under-lock interleaving', t => {
  const f = fixture(t); assert.equal(f.run('install').status, 0);
  const file = path.join(f.state, 'controller.json'), original = JSON.parse(fs.readFileSync(file));
  for (const values of [{ name: undefined }, { name: '../escape' }, { name: 'kernel' }, { name: 42 }, { runtime: undefined }, { runtime: 'stub' }]) {
    const bytes = JSON.stringify({ ...original, ...values }); fs.writeFileSync(file, bytes);
    assert.notEqual(f.run('start').status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(fs.existsSync(path.join(f.state, 'controller.lock')), false);
    assert.equal(f.calls().length, 5);
    assert.equal(fs.existsSync(path.join(f.state, 'account/.codex')), false);
  }
  fs.writeFileSync(file, JSON.stringify(original));
  fs.appendFileSync(path.join(f.root, 'tools/git'), `\nif(process.argv.includes('ls-files') && process.env.CORRUPT_RECEIPT){const fs=require('node:fs');const p=process.env.CORRUPT_RECEIPT;const r=JSON.parse(fs.readFileSync(p));delete r.name;fs.writeFileSync(p,JSON.stringify(r));}\n`);
  const result = f.run('start', [], { CORRUPT_RECEIPT: file });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Incompatible instance receipt/);
  assert.equal(f.calls().length, 5);
});

test('in-checkout state refuses before creating runtime files or probing providers', t => {
  const f = fixture(t), state = path.join(f.project, 'local-state');
  const result = f.run('install', ['--state-dir', state]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /outside the source checkout/);
  assert.equal(fs.existsSync(state), false); assert.deepEqual(f.calls(), []);
});
test('source changes refresh the installed artifact and a running instance is never restarted', t => {
  const f = fixture(t);
  assert.equal(f.run('install').status, 0);
  const receiptFile = path.join(f.state, 'controller.json');
  const original = JSON.parse(fs.readFileSync(receiptFile));
  fs.appendFileSync(path.join(f.project, 'scripts/softwareteam.mjs'), '\n// changed candidate\n');
  fs.writeFileSync(path.join(f.state, 'daemon.json'), JSON.stringify({ pid: process.pid }));
  const refused = f.run('install');
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Source differs/);
  assert.equal(f.calls().length, 5);
  fs.unlinkSync(path.join(f.state, 'daemon.json'));
  assert.equal(f.run('install').status, 0);
  assert.equal(f.calls().length, 10);
  assert.notEqual(JSON.parse(fs.readFileSync(receiptFile)).sourceSha256, original.sourceSha256);
});
test('generic wrapper preserves caller cwd for relative arguments', t => {
  const f = fixture(t); assert.equal(f.run('install').status, 0);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.state, 'controller.json')));
  fs.writeFileSync(receipt.entry, 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));');
  const result = spawnSync('/bin/sh', [path.join(f.project, 'SoftwareTeam'), 'up', './project.yaml'], { cwd: f.root, env: { ...f.env, SOFTWARETEAM_HOME: f.state }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cwd: f.root, args: ['up', './project.yaml'] });
});
test('published instance command preserves cwd and binds custom state despite inherited selectors', t => {
  const f = fixture(t); assert.equal(f.run('install').status, 0);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.state, 'controller.json')));
  fs.writeFileSync(receipt.entry, 'console.log(JSON.stringify({cwd:process.cwd(),state:process.env.SOFTWARETEAM_HOME,home:process.env.HOME,codex:process.env.CODEX_HOME,old:process.env.OPENRIG_URL,args:process.argv.slice(2)}));');
  const result = spawnSync(path.join(f.state, 'bin/SoftwareTeam'), ['up', './project.yaml'], { cwd: f.root, env: { ...f.env, SOFTWARETEAM_HOME: '/wrong', SOFTWARETEAM_URL: 'http://wrong', CODEX_HOME: '/owner/codex' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cwd: f.root, state: f.state, home: path.join(f.state, 'account'), codex: path.join(f.state, 'account/.codex'), args: ['up', './project.yaml'] });
});
test('rosters use the real ps projection envelope and reject unknown contracts', () => {
  const entries = [{ logicalId: 'dev.code-agent' }];
  assert.deepEqual(rowsFromResult({ entries, totalNodes: 1, truncated: false }), entries);
  assert.deepEqual(rowsFromResult([]), []);
  assert.throws(() => rowsFromResult({ items: [] }), /unexpected roster shape/);
});
test('terminal outcomes retain nonzero fallback facts and actual window results', () => {
  const fallback = { ok: false, error: 'No display', absent: [], degraded: ['viewer'], notes: ['manual attach'] };
  assert.deepEqual(terminalFacts({ stdout: JSON.stringify(fallback), status: 1 }), { terminal: fallback, terminalExitCode: 1, windowOpened: false });
  assert.equal(terminalFacts({ stdout: JSON.stringify({ ok: true, window: { provider: 'terminal' } }), status: 0 }).windowOpened, true);
  assert.equal(terminalFacts({ stdout: JSON.stringify({ ok: true, reusedWorkspace: { id: 'existing' } }), status: 0 }).windowOpened, false);
});
test('mutable team evidence is outside build identity while executable and launch inputs remain', () => {
  for (const file of ['team/records/code-agent/report.md', 'team/knowledge/facts.md']) assert.equal(isBuildInput(file), false);
  for (const file of ['scripts/softwareteam.mjs', 'team/software-team.template.yaml', 'team/PROJECT.md', 'packages/daemon/src/index.ts']) assert.equal(isBuildInput(file), true);
});
test('cold start bootstraps then reports isolated authentication prerequisite without launching daemon', t => {
  const f = fixture(t);
  const result = f.run('start', ['--headless']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /authentication_required: codex/);
  assert.ok(result.stderr.includes(path.join(f.state, 'account/.codex')));
  assert.equal(fs.existsSync(path.join(f.state, 'daemon.json')), false);
  assert.equal(fs.existsSync(path.join(f.state, 'controller.lock')), false);
});

test('root start orchestrates custom-name preparation, readiness, repeat reuse and terminal fallback', t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(import.meta.dirname, 'software-team.mjs'), path.join(f.project, 'scripts/software-team.mjs'));
  fs.symlinkSync(path.resolve(import.meta.dirname, '../node_modules'), path.join(f.project, 'node_modules'));
  fs.mkdirSync(path.join(f.project, 'team'));
  for (const name of ['software-team.template.yaml', 'PROJECT.md']) fs.copyFileSync(path.resolve(import.meta.dirname, '../team', name), path.join(f.project, 'team', name));
  const extra = { AUTHENTICATED: '1', MOCK_ENTRY_SOURCE: path.join(import.meta.dirname, 'fixtures/controller-cli.cjs') };
  t.after(() => { const file = path.join(f.state, 'daemon.json'); if (fs.existsSync(file)) { try { process.kill(JSON.parse(fs.readFileSync(file)).pid); } catch {} } });
  const first = f.run('start', ['--name', 'My-team', '--headless', '--json'], extra);
  assert.equal(first.status, 0, first.stderr);
  const facts = JSON.parse(first.stdout);
  assert.equal(facts.name, 'My-team'); assert.equal(facts.seatsReady, true);
  assert.match(facts.attach, /product-manage-agent@My-team/);
  assert.equal(facts.visibilityConfirmed, false);
  const repeat = f.run('start', ['--json'], extra);
  assert.equal(repeat.status, 0, repeat.stderr);
  const repeated = JSON.parse(repeat.stdout);
  assert.equal(repeated.name, 'My-team'); assert.equal(repeated.terminalExitCode, 1);
  assert.equal(repeated.windowOpened, false); assert.match(repeated.attach, /product-manage-agent@My-team/);
  const events = fs.readFileSync(path.join(f.state, 'fixture-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.args[0] === 'up').length, 1);
  assert.equal(events.filter(e => e.args[0] === 'daemon' && e.args[1] === 'start').length, 1);
  assert.ok(events.filter(e => e.args[0] === 'ps' && e.args.includes('--nodes')).every(e => e.args.includes('My-team')));
  assert.equal(events.find(e => e.args[0] === 'terminal').args[2], 'My-team');
  assert.match(fs.readFileSync(path.join(f.project, 'team/PROJECT.local.md'), 'utf8'), /--software-team My-team/);
});
test('runtime mismatch and wrong-type state do not replace files', t => {
  const f = fixture(t);
  assert.equal(f.run('install').status, 0);
  const receipt = fs.readFileSync(path.join(f.state, 'controller.json'));
  assert.notEqual(f.run('start', ['--runtime', 'claude-code']).status, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.state, 'controller.json')), receipt);
  const bad = path.join(f.root, 'user-file'); fs.writeFileSync(bad, 'preserve');
  assert.throws(() => validateState(path.dirname(f.env.HOME), f.env.HOME), /contain/);
  const result = spawnSync(process.execPath, [path.join(f.project, 'scripts/softwareteam.mjs'), 'install', '--state-dir', bad], { env: f.env, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.equal(fs.readFileSync(bad, 'utf8'), 'preserve');
});
test('environment removes every old target and scopes provider, transport and tmux together', () => {
  const env = childEnvironment('/tmp/new account', 12345, '/tmp/private.sock', { PATH: '/usr/bin', HOME: '/old', OPENRIG_URL: 'secret', RIGGED_DB: '/old/db', SOFTWARETEAM_NODE_ID: 'old-seat', TMUX: '/old/socket,1,1', CODEX_HOME: '/old/codex' });
  assert.equal(env.OPENRIG_URL, undefined); assert.equal(env.RIGGED_DB, undefined); assert.equal(env.SOFTWARETEAM_NODE_ID, undefined); assert.equal(env.TMUX, undefined);
  assert.equal(env.SOFTWARETEAM_URL, 'http://127.0.0.1:12345');
  assert.equal(env.SOFTWARETEAM_TMUX_SOCKET, '/tmp/private.sock');
  assert.equal(env.CODEX_HOME, '/tmp/new account/account/.codex');
});
test('legacy/account path overlap is rejected, including symlinks', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.env.HOME, '.openrig')); fs.symlinkSync(path.join(f.env.HOME, '.openrig'), path.join(f.root, 'alias'));
  for (const dir of [f.env.HOME, path.join(f.env.HOME, '.openrig/new'), path.join(f.root, 'alias/new'), path.join(f.env.HOME, '.codex')]) assert.throws(() => validateState(dir, f.env.HOME));
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
    const custom = path.join(f.root, 'custom provider');
    assert.throws(() => options(['--state-dir', path.join(custom, 'new')], { [key]: custom }), /overlaps/);
  }
});
test('readiness requires exactly seven named running experts and reports partial failures', () => {
  const names = ['manage-agent', 'need-agent', 'home-agent', 'code-agent', 'review-agent', 'test-agent', 'run-agent'];
  const rows = names.map(n => ({ logicalId: expertLogicalId(n), canonicalSessionName: `${expertLogicalId(n).replace('.', '-')}@software-team`, runtime: 'codex', sessionStatus: 'running', startupStatus: 'ready', lifecycleState: 'running' }));
  assert.equal(readiness(rows, 'codex').ready, true);
  const custom = rows.map(row => ({ ...row, canonicalSessionName: row.canonicalSessionName.replace('@software-team', '@my-team') }));
  assert.equal(readiness(custom, 'codex', 'my-team').ready, true);
  assert.equal(readiness(custom, 'codex').ready, false);
  assert.equal(readiness(rows.slice(1), 'codex').ready, false);
  assert.equal(readiness([...rows, rows[0]], 'codex').ready, false);
  const wrongGroup = rows.map(row => ({ ...row, logicalId: row.logicalId.replace(/^product\./, 'dev.') }));
  assert.equal(readiness(wrongGroup, 'codex').ready, false);
  rows[3].startupStatus = 'failed'; assert.equal(readiness(rows, 'codex').unavailable[0].name, 'dev.code-agent');
});
test('missing selected provider is an explicit prerequisite and unselected provider is not required', () => {
  const missing = prerequisites('claude-code', { PATH: '/definitely-absent' });
  assert.ok(missing.some(s => s.startsWith('claude '))); assert.ok(!missing.some(s => s.startsWith('codex ')));
  assert.throws(() => options(['--runtime', 'other']), /codex or claude-code/);
});
