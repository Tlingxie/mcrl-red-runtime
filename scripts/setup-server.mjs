import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, 'server');
const version = '1.20.4';
if (process.env.MCRL_ACCEPT_EULA !== 'true') throw new Error('Read https://www.minecraft.net/eula and set MCRL_ACCEPT_EULA=true if you agree');

async function verifiedFetch(url, expectedHash) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha1').update(data).digest('hex');
  if (expectedHash && hash !== expectedHash) throw new Error(`SHA1 mismatch for ${url}`);
  return { data, hash };
}

await mkdir(directory, { recursive: true });
const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const manifest = JSON.parse((await verifiedFetch(manifestUrl)).data);
const release = manifest.versions.find(entry => entry.id === version);
if (!release) throw new Error(`Missing Minecraft version ${version}`);
const metadata = await verifiedFetch(release.url, release.sha1);
const download = JSON.parse(metadata.data).downloads.server;
const jarPath = resolve(directory, 'server.jar');
let existingHash;
try { existingHash = createHash('sha1').update(await readFile(jarPath)).digest('hex'); } catch {}
if (existingHash !== download.sha1) {
  const jar = await verifiedFetch(download.url, download.sha1);
  if (jar.data.length !== download.size) throw new Error('Server JAR size mismatch');
  await writeFile(jarPath, jar.data);
}
await writeFile(resolve(directory, 'download.json'), JSON.stringify({ version, manifestUrl, metadataUrl: release.url, metadataSha1: metadata.hash, serverUrl: download.url, serverSha1: download.sha1, serverSize: download.size }, null, 2) + '\n');
await writeFile(resolve(directory, 'eula.txt'), 'eula=true\n');
const properties = {
  'server-ip': '127.0.0.1', 'server-port': 25565,
  'online-mode': false, 'enforce-secure-profile': false,
  'enable-rcon': true, 'rcon.port': 25575, 'rcon.password': 'local-mcrl-only',
  'broadcast-rcon-to-ops': false, 'broadcast-console-to-ops': false,
  'max-players': 4, pvp: true, gamemode: 'survival', difficulty: 'normal',
  'level-name': 'world', 'level-type': 'minecraft:flat', 'level-seed': 42,
  'generator-settings': JSON.stringify({ biome: 'minecraft:plains', layers: [ { block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:dirt', height: 2 }, { block: 'minecraft:grass_block', height: 1 } ], structure_overrides: [] }),
  'generate-structures': false, 'spawn-animals': false, 'spawn-monsters': false,
  'spawn-npcs': false, 'spawn-protection': 0, 'view-distance': 4,
  'simulation-distance': 4, 'max-world-size': 128, 'max-tick-time': 60000,
  'sync-chunk-writes': true, 'enable-query': false, 'enable-status': true,
  'network-compression-threshold': 256, 'motd': 'MCRL local PvP laboratory',
};
await writeFile(resolve(directory, 'server.properties'), Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
// Vanilla offers no gamerule to disable advancement criteria; override their triggers.
const temporaryJar = resolve(directory, 'advancement-source.jar');
let advancementPaths;
try {
  const innerJar = execFileSync('unzip', ['-p', jarPath, `META-INF/versions/${version}/server-${version}.jar`], { maxBuffer: 128 * 1024 * 1024 });
  await writeFile(temporaryJar, innerJar);
  advancementPaths = execFileSync('unzip', ['-Z1', temporaryJar], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n').filter(path => /^data\/minecraft\/advancements\/.+\.json$/.test(path));
} finally { await unlink(temporaryJar).catch(() => {}); }
if (!advancementPaths.length) throw new Error('No vanilla advancement paths found');
const pack = resolve(directory, 'world/datapacks/mcrl-no-advancements');
await mkdir(pack, { recursive: true });
await writeFile(resolve(pack, 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: 26, description: 'MCRL: disable all vanilla advancement triggers' } }) + '\n');
for (const path of advancementPaths) {
  const output = resolve(pack, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, '{"criteria":{"disabled":{"trigger":"minecraft:impossible"}}}\n');
}
console.log(JSON.stringify({ version, directory, sha1: download.sha1, size: download.size, disabledAdvancements: advancementPaths.length }));
