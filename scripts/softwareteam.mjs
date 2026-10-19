#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const experts = ['manage-agent', 'need-agent', 'home-agent', 'code-agent', 'review-agent', 'test-agent', 'run-agent'];
export const expertLogicalId = name => `${['manage-agent', 'need-agent'].includes(name) ? 'product' : 'dev'}.${name}`;
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let machineOutput = false;
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function canonical(file) {
  let cursor = path.resolve(file);
  const parts = [];
  while (!fs.existsSync(cursor)) { parts.unshift(path.basename(cursor)); const next = path.dirname(cursor); if (next === cursor) break; cursor = next; }
  return path.join(fs.realpathSync(cursor), ...parts);
}

export function options(args, env = process.env) {
  const out = { runtime: undefined, stateDir: env.SOFTWARETEAM_HOME || path.join(os.homedir(), '.softwareteam'), headless: false, noStart: false, json: false, dryRun: false, check: false, help: false };
  const values = { '--runtime': 'runtime', '--state-dir': 'stateDir', '--port': 'port', '--name': 'name' };
  const flags = { '--headless': 'headless', '--no-start': 'noStart', '--json': 'json', '--dry-run': 'dryRun', '--check': 'check', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (values[key]) { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${key} requires a value`); out[values[key]] = args[++i]; }
    else if (flags[key]) out[flags[key]] = true;
    else throw new Error(`Unknown option ${key}; use --help`);
  }
  if (out.runtime && !['codex', 'claude-code'].includes(out.runtime)) throw new Error('--runtime must be codex or claude-code');
  if (out.name !== undefined) validateName(out.name);
  if (!path.isAbsolute(out.stateDir)) throw new Error('--state-dir must be an absolute path');
  if (out.port !== undefined) { out.port = Number(out.port); if (!Number.isInteger(out.port) || out.port < 1024 || out.port > 65535) throw new Error('--port must be an integer from 1024 to 65535'); }
  out.stateDir = validateState(out.stateDir, os.homedir(), [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.OPENRIG_HOME, env.RIGGED_HOME].filter(Boolean));
  if (inside(out.stateDir, canonical(sourceRoot))) throw new Error('State directory must be outside the source checkout; choose a fresh --state-dir');
  return out;
}

export function validateName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || ['external', 'kernel'].includes(name)) throw new Error('--name must be a nonreserved team slug using letters, digits, dash or underscore, beginning with a letter or digit (external and kernel are reserved)');
  return name;
}

export function validateState(dir, accountHome, protectedHomes = []) {
  const state = canonical(dir), home = canonical(accountHome);
  if (inside(home, state)) throw new Error('State directory cannot contain the account home');
  for (const name of ['.openrig', '.rigged', '.codex', '.claude', '.config', '.ssh']) {
    const protectedPath = canonical(path.join(home, name));
    if (inside(state, protectedPath) || inside(protectedPath, state)) throw new Error(`State directory overlaps protected account path ${name}; choose a fresh SoftwareTeam directory`);
  }
  for (const selected of protectedHomes) {
    const protectedPath = canonical(selected);
    if (inside(state, protectedPath) || inside(protectedPath, state)) throw new Error('State directory overlaps an existing selected provider or legacy home; choose a fresh directory');
  }
  return state;
}

function directory(dir) {
  if (fs.existsSync(dir)) { const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Expected a private directory: ${dir}`); }
  else fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
function writeJson(file, value) {
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error(`Refusing to replace nonregular file: ${file}`);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}
function readJson(file) { if (!fs.existsSync(file)) return undefined; return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function validateReceipt(receipt) {
  if (receipt === undefined) return receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || typeof receipt.installed !== 'boolean' || typeof receipt.name !== 'string' || !['codex', 'claude-code'].includes(receipt.runtime)) throw new Error('Incompatible instance receipt: valid persisted name and runtime are required; inspect this instance or choose a fresh --state-dir');
  validateName(receipt.name);
  return receipt;
}

export function acquireControllerLock(lock) {
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another install/start or stale lock owns ${lock}. Inspect its PID and manually recover only after confirming no controller is active; no concurrent launch was attempted`);
  }
  const token = randomUUID();
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(lock, 'owner'), token, { flag: 'wx', mode: 0o600 });
  const acquired = fs.lstatSync(lock);
  return () => {
    try {
      const current = fs.lstatSync(lock);
      if (current.isDirectory() && !current.isSymbolicLink() && current.dev === acquired.dev && current.ino === acquired.ino && fs.readFileSync(path.join(lock, 'owner'), 'utf8') === token) fs.rmSync(lock, { recursive: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
export function childEnvironment(stateDir, port, socket, env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) if (/^(OPENRIG_|RIGGED_|SOFTWARETEAM_)/.test(key) || ['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID'].includes(key)) delete clean[key];
  const home = path.join(stateDir, 'account');
  Object.assign(clean, { HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'), SOFTWARETEAM_HOME: stateDir, SOFTWARETEAM_DB: path.join(stateDir, 'softwareteam.sqlite'), SOFTWARETEAM_HOST: '127.0.0.1', SOFTWARETEAM_BIND_HOST: '127.0.0.1', SOFTWARETEAM_PORT: String(port), SOFTWARETEAM_URL: `http://127.0.0.1:${port}`, SOFTWARETEAM_TMUX_SOCKET: socket });
  return clean;
}

export function executable(name, env = process.env) {
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next directory */ }
  }
  return undefined;
}
export function prerequisites(runtime, env = process.env) {
  const missing = [];
  if (![22, 24].includes(Number(process.versions.node.split('.')[0]))) missing.push('Node.js 22 or 24 (install a supported Node.js version)');
  if (!['linux', 'darwin'].includes(process.platform)) missing.push('Linux or macOS (this source installer does not support Windows)');
  for (const name of ['npm', 'tmux', runtime === 'claude-code' ? 'claude' : 'codex']) if (!executable(name, env)) missing.push(`${name} (install ${name}, then retry --runtime ${runtime})`);
  return missing;
}
function run(bin, args, { env, cwd = sourceRoot, capture = false, label = bin, timeout = 600_000 } = {}) {
  const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : ['inherit', machineOutput ? 2 : 1, 2], timeout, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) { const error = new Error(`${label} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}${capture && r.stderr ? `\n${r.stderr.trim()}` : ''}`); error.exitCode = r.status || 1; throw error; }
  return r.stdout || '';
}
async function availablePort(preferred) {
  const probe = p => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(p, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  if (preferred !== undefined) return probe(preferred);
  try { return await probe(7434); } catch { return probe(0); }
}
export function isBuildInput(file) {
  return !/^(?:team\/(?:records|knowledge)\/)/.test(file);
}
function buildIdentity(root) {
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root, capture: true }).trim();
  const digest = createHash('sha256');
  const files = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, capture: true }).split('\0').filter(Boolean).sort();
  for (const file of files.filter(isBuildInput)) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    digest.update(`${file}\0${stat.mode & 0o777}\0`);
    digest.update(stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute));
    digest.update('\0');
  }
  return { sourceRoot: root, sourceSha256: digest.digest('hex'), commit, dirty: run('git', ['status', '--porcelain', '--', 'packages', 'scripts', 'team', 'install.sh', 'start.sh', 'SoftwareTeam'], { cwd: root, capture: true }).trim() !== '', lockSha256: hash(fs.readFileSync(path.join(root, 'package-lock.json'))) };
}

export function instanceCommand(stateDir) {
  return `#!${process.execPath}\nconst fs = require('node:fs'), path = require('node:path');\nconst { spawnSync } = require('node:child_process');\nconst childEnvironment = ${childEnvironment.toString()};\nconst stateDir = ${JSON.stringify(stateDir)};\ntry {\n  const receipt = JSON.parse(fs.readFileSync(path.join(stateDir, 'controller.json'), 'utf8'));\n  if (!receipt.installed) throw new Error('Installation incomplete; rerun install.sh');\n  const env = childEnvironment(stateDir, receipt.port || 7434, receipt.socket || path.join(stateDir, 'run/tmux.sock'));\n  const result = spawnSync(process.execPath, [receipt.entry, ...process.argv.slice(2)], { env, cwd: process.cwd(), stdio: 'inherit' });\n  if (result.error) throw result.error;\n  process.exitCode = result.status ?? 1;\n} catch (error) { console.error('SoftwareTeam: ' + error.message); process.exitCode = 1; }\n`;
}

export function rowsFromResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.entries)) return result.entries;
  throw new Error('SoftwareTeam ps returned an unexpected roster shape; no team was created or replaced');
}

export function terminalFacts(result) {
  let terminal;
  try { terminal = JSON.parse(result.stdout); }
  catch { terminal = { ok: false, error: result.error?.message || result.stderr?.trim() || 'Terminal returned no JSON result' }; }
  return { terminal, windowOpened: !!terminal.window, terminalExitCode: result.status ?? 1 };
}

async function install(config, receipt) {
  const prefix = path.join(config.stateDir, 'install');
  if (receipt && receipt.sourceRoot !== sourceRoot) throw new Error('This instance belongs to a different checkout; choose a fresh --state-dir');
  if (fs.existsSync(prefix) && receipt?.prefix !== prefix) throw new Error(`Unrecognized installation directory ${prefix}; choose a fresh state directory or inspect the interrupted installation`);
  const env = { ...childEnvironment(config.stateDir, 0, '', process.env) };
  delete env.SOFTWARETEAM_URL;
  const cache = path.join(config.stateDir, 'npm-cache');
  run(executable('npm'), ['ci', '--bin-links=false', '--cache', cache, '--no-audit', '--no-fund'], { env, label: 'dependency installation' });
  run(executable('npm'), ['rebuild', 'typescript', 'vitest', 'vite', 'tsx', 'esbuild', '--bin-links=true', '--cache', cache], { env, label: 'build tool preparation' });
  run(executable('npm'), ['run', 'build:package'], { env, label: 'package build' });
  const artifacts = path.join(config.stateDir, 'artifacts'); directory(artifacts);
  const packed = JSON.parse(run(executable('npm'), ['pack', '--json', '--pack-destination', artifacts], { cwd: path.join(sourceRoot, 'packages/cli'), env, capture: true, label: 'local package assembly' }))[0];
  const tarball = path.join(artifacts, packed.filename), tarSha256 = hash(fs.readFileSync(tarball));
  // Mark the prefix as owned before npm writes it, so an interrupted install is retryable.
  const progress = { ...config, ...buildIdentity(sourceRoot), installed: false, prefix, tarSha256, packageName: packed.name, version: packed.version };
  writeJson(path.join(config.stateDir, 'controller.json'), progress);
  directory(prefix);
  run(executable('npm'), ['install', '--prefix', prefix, '--omit=dev', '--cache', cache, '--no-audit', '--no-fund', tarball], { env, label: 'local artifact installation' });
  const entry = path.join(prefix, 'node_modules/@softwareteam/cli/dist/bin-wrapper.js');
  const version = run(process.execPath, [entry, '--version'], { env, capture: true, label: 'installed SoftwareTeam verification' }).trim();
  if (version.split(/\s/, 1)[0] !== packed.version) throw new Error('Installed SoftwareTeam version does not match the packed artifact');
  const bin = path.join(config.stateDir, 'bin'); directory(bin);
  const command = path.join(bin, 'SoftwareTeam');
  if (fs.existsSync(command)) {
    const stat = fs.lstatSync(command);
    const owned = stat.isSymbolicLink() ? fs.readlinkSync(command) === entry : stat.isFile() && receipt?.commandSha256 === hash(fs.readFileSync(command));
    if (!owned) throw new Error(`Command collision: ${command}`);
    fs.unlinkSync(command);
  }
  const commandBytes = instanceCommand(config.stateDir);
  fs.writeFileSync(command, commandBytes, { flag: 'wx', mode: 0o700 });
  const final = { ...progress, installed: true, entry, bin, commandSha256: hash(commandBytes), runtime: config.runtime, installedAt: new Date().toISOString() };
  writeJson(path.join(config.stateDir, 'controller.json'), final);
  return final;
}

function loginCheck(config, env) {
  const provider = config.runtime === 'codex' ? 'codex' : 'claude';
  const args = config.runtime === 'codex' ? ['login', 'status'] : ['auth', 'status'];
  const result = spawnSync(executable(provider), args, { env, encoding: 'utf8', stdio: 'pipe', timeout: 15_000 });
  if (result.error || result.status !== 0) {
    const login = config.runtime === 'codex' ? 'login' : 'auth login';
    const scoped = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].map(k => `${k}=${shellQuote(env[k])}`).join(' ');
    const error = new Error(`authentication_required: ${config.runtime} is not authenticated in the SoftwareTeam account. Run:\nenv ${scoped} ${shellQuote(executable(provider))} ${login}\nThen rerun ./start.sh --runtime ${config.runtime} --state-dir ${shellQuote(config.stateDir)}`);
    error.exitCode = 2; throw error;
  }
}

export function readiness(rows, runtime, name = 'software-team') {
  const ids = experts.map(expertLogicalId);
  const missing = ids.filter(id => rows.filter(row => row.logicalId === id).length !== 1);
  const unavailable = rows.filter(row => !ids.includes(row.logicalId) || row.canonicalSessionName !== `${row.logicalId?.replace('.', '-')}@${name}` || row.runtime !== runtime || row.sessionStatus !== 'running' || row.startupStatus !== 'ready' || row.lifecycleState !== 'running');
  return { ready: rows.length === 7 && missing.length === 0 && unavailable.length === 0, missing, unavailable: unavailable.map(r => ({ name: r.logicalId, startupStatus: r.startupStatus, lifecycleState: r.lifecycleState, error: r.latestError })) };
}

async function start(config, receipt) {
  const runRoot = path.join(config.stateDir, 'run'); directory(runRoot);
  let socketRoot = runRoot;
  if (Buffer.byteLength(path.join(runRoot, 'tmux.sock')) > 90) socketRoot = path.join(os.tmpdir(), `softwareteam-${process.getuid?.() ?? 'user'}-${hash(config.stateDir).slice(0, 16)}`);
  directory(socketRoot);
  const socket = path.join(socketRoot, 'tmux.sock');
  const daemonFile = path.join(config.stateDir, 'daemon.json');
  const daemonState = readJson(daemonFile);
  if (daemonState && config.port && daemonState.port !== config.port) throw new Error('Requested port differs from this instance receipt; no service was changed');
  let live = false;
  if (daemonState?.pid) { try { process.kill(daemonState.pid, 0); live = true; } catch { /* stopped */ } }
  const port = live ? daemonState.port : await availablePort(config.port ?? receipt.port);
  const env = childEnvironment(config.stateDir, port, socket);
  env.SOFTWARETEAM_ARTIFACT_SHA256 = receipt.tarSha256;
  for (const dir of [env.HOME, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]) directory(dir);
  loginCheck(config, env);
  const cli = (args, capture = true) => run(process.execPath, [receipt.entry, ...args], { env, capture, label: `SoftwareTeam ${args[0]}` });
  if (live) {
    let health;
    try { health = await (await fetch(`${env.SOFTWARETEAM_URL}/healthz`, { signal: AbortSignal.timeout(3000) })).json(); } catch { throw new Error('Recorded daemon process is alive but its owned endpoint is unavailable; inspect this instance without restarting it'); }
    if (health.product !== 'SoftwareTeam' || health.instanceHome !== config.stateDir || health.pid !== daemonState.pid || health.commit !== receipt.commit || health.dirty !== receipt.dirty || health.artifactSha256 !== receipt.tarSha256) throw new Error('Daemon identity/build mismatch; no service was stopped or adopted. Inspect the instance or choose a fresh --state-dir');
  } else cli(['daemon', 'start', '--host', '127.0.0.1', '--port', String(port), '--db', env.SOFTWARETEAM_DB, '--no-kernel'], false);
  writeJson(path.join(config.stateDir, 'controller.json'), { ...receipt, port, socket });
  const getRows = () => {
    const result = JSON.parse(cli(['ps', '--nodes', '--software-team', config.name, '--json', '--fields', 'logicalId,canonicalSessionName,runtime,sessionStatus,startupStatus,lifecycleState,tmuxAttachCommand,latestError']));
    return rowsFromResult(result);
  };
  let rows = getRows();
  if (rows.length === 0) {
    const teams = JSON.parse(cli(['ps', '--json']));
    const entries = rowsFromResult(teams);
    if (entries.some(t => t.name === config.name || t.softwareTeamName === config.name)) cli(['up', config.name, '--existing'], false);
    else {
      const { prepareTeam } = await import('./software-team.mjs');
      const { output } = prepareTeam(sourceRoot, config.runtime, config.name);
      cli(['up', output], false);
    }
  } else if (rows.every(r => r.sessionStatus !== 'running')) cli(['up', config.name, '--existing'], false);
  const deadline = Date.now() + 90_000;
  let state;
  do { rows = getRows(); state = readiness(rows, config.runtime, config.name); if (state.ready) break; await new Promise(r => setTimeout(r, 1000)); } while (Date.now() < deadline);
  if (!state.ready) throw new Error(`Experts are not ready: ${JSON.stringify(state)}. Inspect env SOFTWARETEAM_HOME=${shellQuote(config.stateDir)} ${shellQuote(path.join(sourceRoot, 'SoftwareTeam'))} ps --nodes --software-team ${shellQuote(config.name)} --json; working seats were preserved`);
  const manager = rows.find(r => r.logicalId?.endsWith('.manage-agent'));
  const attach = `env -u TMUX ${manager.tmuxAttachCommand}`;
  let facts = { windowOpened: false };
  if (!config.headless) facts = terminalFacts(spawnSync(process.execPath, [receipt.entry, 'terminal', 'open', config.name, '--window', '--json'], { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 32 * 1024 * 1024 }));
  return { installed: true, daemonHealthy: true, seatsReady: true, name: config.name, headless: config.headless, ...facts, visibilityConfirmed: false, attach, stateDir: config.stateDir, bin: receipt.bin, runtime: config.runtime };
}

export async function main(action, args) {
  if (action === 'cli') {
    const dir = options([], process.env).stateDir;
    const receipt = validateReceipt(readJson(path.join(dir, 'controller.json')));
    if (!receipt?.installed) throw new Error('SoftwareTeam is not installed for this instance. Run ./install.sh or ./start.sh first');
    const env = childEnvironment(dir, receipt.port || 7434, receipt.socket || path.join(dir, 'run/tmux.sock'));
    run(process.execPath, [receipt.entry, ...args], { env, cwd: process.cwd(), label: 'SoftwareTeam', timeout: 600_000 }); return;
  }
  const config = options(args);
  const requestedName = config.name, requestedRuntime = config.runtime;
  machineOutput = config.json;
  if (config.help) { console.log(`SoftwareTeam ${action}\nUsage: ./${action}.sh [--runtime codex|claude-code] [--name NAME] [--state-dir /absolute/path] [--port 7434]\n  --dry-run  Show the plan without writing or starting anything\n  --check    Check prerequisites and local installation without mutation\n  --headless Skip desktop window opening; print the exact attach command\n  --no-start Install only\n  --json     Print structured final facts\nInstallation is local to the SoftwareTeam state directory. Start bootstraps a cold checkout.\nA selected provider must log in separately in the isolated SoftwareTeam account.`); return; }
  const receiptPath = path.join(config.stateDir, 'controller.json');
  let receipt = validateReceipt(readJson(receiptPath));
  if (config.name !== undefined && receipt && config.name !== (receipt.name ?? 'software-team')) throw new Error(`Instance team name is ${receipt.name ?? 'software-team'}; no team was renamed or replaced. Choose a fresh --state-dir for --name ${config.name}`);
  config.name ??= receipt?.name ?? 'software-team';
  config.runtime ??= receipt?.runtime ?? 'codex';
  if (receipt?.runtime && receipt.runtime !== config.runtime) throw new Error(`Instance runtime is ${receipt.runtime}; use that runtime or a fresh --state-dir`);
  if (receipt?.sourceRoot && receipt.sourceRoot !== sourceRoot) throw new Error('Instance belongs to another checkout; use a fresh --state-dir');
  const plan = { product: 'SoftwareTeam', action, name: config.name, sourceRoot, stateDir: config.stateDir, runtime: config.runtime, installPrefix: path.join(config.stateDir, 'install'), installed: !!receipt?.installed, starts: action === 'start' && !config.noStart, headless: config.headless };
  if (config.dryRun) { console.log(JSON.stringify(plan, null, 2)); return; }
  const missing = prerequisites(config.runtime);
  if (config.check) { console.log(JSON.stringify({ ...plan, missing, authentication: 'not-checked', ready: false }, null, 2)); if (missing.length) process.exitCode = 1; return; }
  if (missing.length) throw new Error(`Missing prerequisites for ${config.runtime}:\n${missing.join('\n')}`);
  if (receipt?.installed && receipt.sourceSha256 !== buildIdentity(sourceRoot).sourceSha256) {
    const daemon = readJson(path.join(config.stateDir, 'daemon.json'));
    let live = false;
    if (daemon?.pid) { try { process.kill(daemon.pid, 0); live = true; } catch { /* stopped */ } }
    if (live) throw new Error('Source differs from the installed artifact while this instance is running. No restart/update was performed; inspect or stop this owned instance explicitly, then rerun ./install.sh');
    receipt = { ...receipt, installed: false };
  }
  directory(config.stateDir);
  directory(path.join(config.stateDir, 'account'));
  const lock = path.join(config.stateDir, 'controller.lock');
  const releaseLock = acquireControllerLock(lock);
  try {
    // Preflight can overlap another installer. Only the receipt read under our lock is authoritative.
    receipt = validateReceipt(readJson(receiptPath));
    if (requestedName !== undefined && receipt && requestedName !== (receipt.name ?? 'software-team')) throw new Error(`Instance team name is ${receipt.name ?? 'software-team'}; no team was renamed or replaced. Choose a fresh --state-dir for --name ${requestedName}`);
    config.name = requestedName ?? receipt?.name ?? 'software-team';
    config.runtime = requestedRuntime ?? receipt?.runtime ?? 'codex';
    if (receipt?.runtime && receipt.runtime !== config.runtime) throw new Error(`Instance runtime is ${receipt.runtime}; use that runtime or a fresh --state-dir`);
    if (receipt?.sourceRoot && receipt.sourceRoot !== sourceRoot) throw new Error('Instance belongs to another checkout; use a fresh --state-dir');
    const lockedMissing = prerequisites(config.runtime);
    if (lockedMissing.length) throw new Error(`Missing prerequisites for ${config.runtime}:\n${lockedMissing.join('\n')}`);
    if (receipt?.installed && receipt.sourceSha256 !== buildIdentity(sourceRoot).sourceSha256) {
      const daemon = readJson(path.join(config.stateDir, 'daemon.json'));
      let live = false;
      if (daemon?.pid) { try { process.kill(daemon.pid, 0); live = true; } catch { /* stopped */ } }
      if (live) throw new Error('Source differs from the installed artifact while this instance is running. No restart/update was performed; inspect or stop this owned instance explicitly, then rerun ./install.sh');
      receipt = { ...receipt, installed: false };
    }
    if (!receipt?.installed) receipt = await install(config, receipt);
    const result = action === 'start' && !config.noStart ? await start(config, receipt) : { ...plan, installed: true, bin: receipt.bin, seatsReady: false, ready: false };
    if (config.json) console.log(JSON.stringify(result));
    else { console.log(`SoftwareTeam installed: ${receipt.packageName}@${receipt.version}\nCommand: ${path.join(receipt.bin, 'SoftwareTeam')}\nState: ${config.stateDir}`); if (result.attach) console.log(`Seven experts ready. ${config.headless ? 'No desktop window requested.' : 'Terminal visibility is unconfirmed.'}\nOpen a new terminal and run:\n${result.attach}`); else console.log('No agents started. Run ./start.sh with the selected runtime.'); }
  } finally { releaseLock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv[2] || 'start', process.argv.slice(3)).catch(error => { console.error(`SoftwareTeam: ${error.message}`); process.exitCode = error.exitCode || 1; });
}
