import {spawn, execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile, unlink, access} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const pause = ms => new Promise(done => setTimeout(done, ms));
const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const pidFile = resolve(root, 'runs/runtime.pid');
const python = process.env.MCRL_PYTHON || resolve(root, '.venv/bin/python');
const env = {...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1'};

function owned(pid) {
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    return cwd.split('\n').includes(`n${root}`) && (cmd.includes(resolve(root, 'scripts/run.mjs')) || /scripts\/run\.mjs(?:\s|$)/.test(cmd));
  } catch { return false; }
}
async function command(executable, commandArgs) {
  const child = spawn(executable, commandArgs, {cwd: root, env, stdio: 'inherit'});
  await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error(`Command exited ${code}: ${executable}`))); });
}
if (args.includes('--help')) {
  console.log('npm start -- [--player YOUR_NAME] [--viewer] [--rounds 100]\nnpm stop\nMCRL_MEMORY_MB=512 controls the Java heap. Inference uses CPU/NumPy.');
  process.exit(0);
}
if (args.includes('--stop')) {
  let pid;
  try { pid = Number((await readFile(pidFile, 'utf8')).trim()); } catch {}
  if (owned(pid)) {
    process.kill(pid, 'SIGINT');
    for (let i = 0; i < 40 && owned(pid); i++) await pause(250);
    if (owned(pid)) throw new Error('Runtime shutdown is still in progress');
  }
  await command(process.execPath, [resolve(root, 'scripts/server.mjs'), 'stop']);
  process.exit(0);
}
const player = value('--player');
if (args.includes('--player') && (!player || !/^[A-Za-z0-9_]{1,16}$/.test(player) || ['RedDQN', 'BlueDQN', 'Camera'].includes(player))) throw new Error('Provide your Minecraft username after --player');
const rounds = value('--rounds') || '100';
if (!/^\d+$/.test(rounds) || Number(rounds) < 1) throw new Error('--rounds must be positive');
await mkdir(resolve(root, 'runs'), {recursive: true});
try { const prior = Number((await readFile(pidFile, 'utf8')).trim()); if (owned(prior)) throw new Error('This runtime is already running'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await access(python).catch(() => { throw new Error('Create .venv and install requirements.txt first'); });
await access(resolve(root, 'server/server.jar')).catch(() => { throw new Error('Run npm run setup:server first'); });
for (const port of [25565, 25575, 3000, ...(args.includes('--viewer') ? [3007] : [])]) {
  let occupied = '';
  try { occupied = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim(); } catch {}
  if (occupied) throw new Error(`Port ${port} is already occupied. Stop the existing lab before starting this runtime.`);
}
await command(python, ['-m', 'mcrl.download']);
await writeFile(pidFile, `${process.pid}\n`);
const children = [];
let stopping = false;
let startedServer = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // Stop policy inference before disconnecting its arena transport.
  for (const child of [...children].reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGINT');
      for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await pause(100);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
  }
  if (startedServer) await command(process.execPath, [resolve(root, 'scripts/server.mjs'), 'stop']);
  if (Number((await readFile(pidFile, 'utf8').catch(() => '0')).trim()) === process.pid) await unlink(pidFile);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown().then(() => process.exit(0)).catch(error => {console.error(error); process.exit(1);}));
function service(executable, commandArgs, childEnv=env) {
  const child = spawn(executable, commandArgs, {cwd: root, env: childEnv, stdio: 'inherit'});
  child.on('error', error => {console.error(error); shutdown().finally(() => process.exit(1));});
  children.push(child);
  return child;
}
async function ready(url, child) {
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Service exited during startup');
    try { const r = await fetch(url, {signal: AbortSignal.timeout(1000)}); if (r.ok) return; } catch {}
    await pause(1000);
  }
  throw new Error(`Service did not become ready: ${url}`);
}
try {
  startedServer = true;
  await command(process.execPath, [resolve(root, 'scripts/server.mjs'), 'start']);
  const childEnv = {...env};
  delete childEnv.HUMAN_OPPONENT;
  if (player) childEnv.HUMAN_OPPONENT = player;
  const bridge = service(process.execPath, [resolve(root, 'bridge/server.js')], childEnv);
  await ready('http://127.0.0.1:3000/state', bridge);
  if (args.includes('--viewer')) {
    const viewer = service(process.execPath, [resolve(root, 'scripts/viewer.mjs')]);
    await ready('http://127.0.0.1:3007/health', viewer);
    console.log('Viewer: http://127.0.0.1:3007');
  }
  const policy = service(python, ['-m', 'mcrl.play', '--rounds', rounds]);
  const code = await new Promise((done, reject) => {policy.once('exit', done); policy.once('error', reject);});
  if (code !== 0 && !stopping) throw new Error(`Policy process exited ${code}`);
} finally { await shutdown(); }
