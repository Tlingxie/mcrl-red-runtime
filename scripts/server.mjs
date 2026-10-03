import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectRcon, sendCommands } from './rcon.mjs';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../server');
const pidPath = resolve(directory, 'server.pid');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
function inspect(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}
function owned(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  const command = inspect('ps', ['-p', String(pid), '-o', 'command=']);
  const args = command.split(/\s+/);
  if (!/(?:^|\/)java$/.test(args[0])) return false;
  if (args.includes(resolve(directory, 'server.jar'))) return true;
  const cwd = inspect('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find(line => line.startsWith('n'))?.slice(1);
  return cwd === directory && args.includes('server.jar');
}
function localListeners(port) {
  const output = inspect('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn']);
  let pid;
  const matches = new Set();
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line === `n127.0.0.1:${port}` && pid) matches.add(pid);
  }
  return matches;
}
function localServer(pid) {
  return owned(pid) && localListeners(25565).has(pid) && localListeners(25575).has(pid);
}
async function livePid() {
  try {
    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    return owned(pid) ? pid : null;
  } catch { return null; }
}
async function ready(pid) {
  if (!localServer(pid)) return false;
  let client;
  try { client = await connectRcon(); await client.send('list'); return true; }
  catch { return false; }
  finally { if (client) await client.end(); }
}
const arenaCommands = [
  'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false',
  'gamerule doMobSpawning false', 'gamerule naturalRegeneration false',
  'gamerule doImmediateRespawn true', 'gamerule announceAdvancements false',
  'gamerule keepInventory false', 'gamerule doFireTick false',
  'gamerule mobGriefing false', 'gamerule randomTickSpeed 0',
  'gamerule spawnRadius 0', 'gamerule doInsomnia false',
  'time set noon', 'weather clear', 'worldborder center 0 0', 'worldborder set 48',
  'fill -23 63 -23 23 63 23 minecraft:stone',
  'fill -21 64 -21 21 67 -21 minecraft:barrier',
  'fill -21 64 21 21 67 21 minecraft:barrier',
  'fill -21 64 -20 -21 67 20 minecraft:barrier',
  'fill 21 64 -20 21 67 20 minecraft:barrier',
  'setworldspawn 0 64 0', 'kill @e[type=!minecraft:player]',
];

const action = process.argv[2] ?? 'status';
if (action === 'start') {
  await mkdir(directory, { recursive: true });
  let pid = await livePid();
  const reused = Boolean(pid && await ready(pid));
  if (!pid) {
    if (localListeners(25565).size || localListeners(25575).size) throw new Error('A different process owns a loopback Minecraft/RCON port; refusing to configure it');
    let java = process.env.MCRL_JAVA;
    if (!java) {
      try { java = resolve(execFileSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' }).trim(), 'bin/java'); }
      catch { java = 'java'; }
    }
    const log = openSync(resolve(directory, 'console.log'), 'a');
    const memory = Number(process.env.MCRL_MEMORY_MB || 512);
    if (!Number.isInteger(memory) || memory < 384 || memory > 8192) throw new Error('MCRL_MEMORY_MB must be an integer from 384 to 8192');
    const child = spawn(java, ['-Xms128M', `-Xmx${memory}M`, '-jar', resolve(directory, 'server.jar'), 'nogui'], { cwd: directory, detached: true, stdio: ['ignore', log, log] });
    closeSync(log);
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    child.unref();
    pid = child.pid;
    if (!pid) throw new Error('Unable to launch Java');
    await writeFile(pidPath, `${pid}\n`);
  }
  const deadline = Date.now() + 180000;
  while (!(await ready(pid))) {
    if (await livePid() !== pid) throw new Error('Owned server exited; inspect server/console.log');
    if (Date.now() > deadline) throw new Error('Server startup timed out; inspect server/console.log');
    await delay(1000);
  }
  if (!reused) {
    if (await livePid() !== pid || !localServer(pid)) throw new Error('Lost owned server before arena configuration');
    const results = await sendCommands(arenaCommands);
    const failed = results.filter(result => /Unknown|Incorrect|Failed|Cannot|Syntax error/i.test(result.response));
    if (failed.length) throw new Error(JSON.stringify(failed));
  }
  console.log(JSON.stringify({ running: true, ready: true, reused, pid, host: '127.0.0.1', port: 25565, rconPort: 25575, floorY: 63, spawnY: 64, arena: [-20, 20] }));
} else if (action === 'status') {
  const pid = await livePid();
  console.log(JSON.stringify({ running: Boolean(pid), ready: pid ? await ready(pid) : false, pid, host: '127.0.0.1', port: 25565, rconPort: 25575 }));
} else if (action === 'stop') {
  const pid = await livePid();
  if (pid) {
    if (localServer(pid) && await livePid() === pid) {
      try { await sendCommands(['stop']); } catch {}
    }
    const deadline = Date.now() + 30000;
    while (await livePid() === pid && Date.now() < deadline) await delay(250);
    if (await livePid() === pid && owned(pid)) { process.kill(pid, 'SIGTERM'); await delay(2000); }
    if (await livePid() === pid) throw new Error(`Server ${pid} has not stopped`);
  }
  if (!(await livePid())) await unlink(pidPath).catch(() => {});
  console.log(JSON.stringify({ running: false }));
} else if (action === 'arena') {
  const pid = await livePid();
  if (!pid || !(await ready(pid))) throw new Error('No verified ready project server for arena configuration');
  for (const result of await sendCommands(arenaCommands)) console.log(JSON.stringify(result));
} else throw new Error('Usage: node scripts/server.mjs start|status|stop|arena');
