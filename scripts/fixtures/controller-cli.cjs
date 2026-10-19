// Controlled CLI/health contracts for root-controller tests; no native providers or tmux seats.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2), state = process.env.SOFTWARETEAM_HOME;
const receiptFile = path.join(state, 'controller.json'), daemonFile = path.join(state, 'daemon.json');
const rosterFile = path.join(state, 'fixture-roster.json'), events = path.join(state, 'fixture-events.jsonl');
const receipt = () => JSON.parse(fs.readFileSync(receiptFile));
const record = data => fs.appendFileSync(events, JSON.stringify(data) + '\n');
const ids = ['product.manage-agent', 'product.need-agent', 'dev.home-agent', 'dev.code-agent', 'dev.review-agent', 'dev.test-agent', 'dev.run-agent'];
if (args[0] === '--fixture-server') {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const r = receipt();
    res.end(JSON.stringify({ product: 'SoftwareTeam', instanceHome: state, pid: process.pid, commit: r.commit, dirty: r.dirty, artifactSha256: r.tarSha256 }));
  });
  server.listen(Number(process.env.SOFTWARETEAM_PORT), '127.0.0.1', () => fs.writeFileSync(daemonFile, JSON.stringify({ pid: process.pid, port: Number(process.env.SOFTWARETEAM_PORT) })));
} else if (args[0] === '--version') console.log('0.6.12');
else {
  record({ args, cwd: process.cwd(), home: process.env.HOME });
  if (args[0] === 'daemon' && args[1] === 'start') {
    const child = spawn(process.execPath, [__filename, '--fixture-server'], { env: process.env, stdio: 'ignore', detached: true }); child.unref();
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(daemonFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (!fs.existsSync(daemonFile)) throw Error('fixture health server failed');
  } else if (args[0] === 'daemon' && args[1] === 'stop') {
    if (fs.existsSync(daemonFile)) { process.kill(JSON.parse(fs.readFileSync(daemonFile)).pid); fs.unlinkSync(daemonFile); }
  } else if (args[0] === 'ps') {
    const rows = fs.existsSync(rosterFile) ? JSON.parse(fs.readFileSync(rosterFile)) : [];
    console.log(JSON.stringify(args.includes('--nodes') ? { entries: rows } : rows.length ? [{ name: receipt().name }] : []));
  } else if (args[0] === 'up') {
    const r = receipt();
    const spec = fs.readFileSync(args[1], 'utf8');
    if (!spec.includes(`name: ${r.name}`)) throw Error('wrong prepared name');
    const rows = ids.map(logicalId => ({ logicalId, canonicalSessionName: `${logicalId.replace('.', '-')}@${r.name}`, runtime: r.runtime, sessionStatus: 'running', startupStatus: 'ready', lifecycleState: 'running', tmuxAttachCommand: `tmux -S '${r.socket}' attach -t '${logicalId.replace('.', '-')}@${r.name}'` }));
    fs.writeFileSync(rosterFile, JSON.stringify(rows));
  } else if (args[0] === 'terminal') {
    console.log(JSON.stringify({ ok: false, error: 'fixture has no desktop' })); process.exitCode = 1;
  } else throw Error(`unsupported fixture command: ${args.join(' ')}`);
}
