import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const express = require('express');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { Rcon } = require('rcon-client');
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(dirname(require.resolve('prismarine-viewer')), 'public');
const port = Number(process.env.VIEWER_PORT || 3007);
const bridge = process.env.BRIDGE_URL || 'http://127.0.0.1:3000';

// Expose the existing packaged renderer without rebuilding its large asset bundle.
const original = readFileSync(resolve(publicDir, 'index.js'), 'utf8');
const marker = 'let h=new THREE.OrbitControls(u.camera,l.domElement);';
if (!original.includes(marker)) throw new Error('Unsupported prismarine-viewer bundle: camera hook not found');
const bundle = original.replace(marker, 'let h=null;window.mcrlViewer=u;window.mcrlRenderer=l;window.mcrlSocket=o;');
const app = express();
app.get('/', (_req, res) => res.sendFile(resolve(root, 'viewer/index.html')));
app.get('/index.js', (_req, res) => res.type('js').send(bundle));
app.get('/state', async (_req, res) => {
  try {
    const response = await fetch(`${bridge}/state`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
    res.json(await response.json());
  } catch (error) {
    res.status(503).json({ error: error.message, players: [] });
  }
});
app.get('/health', (_req, res) => res.json({ ready: Boolean(bot.entity && bot.game), username: bot.username, version: bot.version }));
app.use(express.static(resolve(root, 'viewer')));
app.use(express.static(publicDir));
const server = app.listen(port, '127.0.0.1');
const io = new Server(server);
let closing = false;
const bot = mineflayer.createBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT || 25565), version: '1.20.4', username: 'Camera', auth: 'offline', viewDistance: 'tiny' });
bot.on('error', error => console.error('Camera:', error.message));
bot.on('kicked', reason => console.error('Camera kicked:', reason));
bot.on('end', reason => { console.error('Camera disconnected:', reason); shutdown(); });

io.on('connection', socket => {
  let view;
  const attach = () => {
    if (!bot.entity || view) return;
    socket.emit('version', bot.version);
    view = new WorldView(bot.world, 3, bot.entity.position, socket);
    view.listenToBot(bot);
    view.init(bot.entity.position).catch(error => console.error('Chunks:', error.message));
    for (const entity of Object.values(bot.entities)) {
      if (entity.username && entity.username !== 'Camera') socket.emit('player', { id: entity.id, name: entity.username });
    }
  };
  const player = entity => {
    if (entity.username && entity.username !== 'Camera') socket.emit('player', { id: entity.id, name: entity.username });
  };
  const moved = () => view?.updatePosition(bot.entity.position);
  const swing = entity => socket.emit('combatAnimation', { id: entity.id, type: 'swing' });
  const hurt = entity => socket.emit('combatAnimation', { id: entity.id, type: 'hurt' });
  bot.on('entitySpawn', player);
  bot.on('entitySwingArm', swing);
  bot.on('entityHurt', hurt);
  bot.on('move', moved);
  bot.on('spawn', attach);
  attach();
  socket.on('disconnect', () => {
    view?.removeListenersFromBot(bot);
    bot.removeListener('spawn', attach);
    bot.removeListener('move', moved);
    bot.removeListener('entitySpawn', player);
    bot.removeListener('entitySwingArm', swing);
    bot.removeListener('entityHurt', hurt);
  });
});

await once(bot, 'spawn');
const rcon = await Rcon.connect({ host: '127.0.0.1', port: Number(process.env.RCON_PORT || 25575), password: process.env.RCON_PASSWORD || 'local-mcrl-only' });
await rcon.send('gamemode spectator Camera');
await rcon.send('tp Camera 0 80 0');
await rcon.end();
console.log(`VIEWER_READY http://127.0.0.1:${port}`);
function shutdown() {
  if (closing) return;
  closing = true;
  bot.quit();
  io.close();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
