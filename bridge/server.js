const http = require('node:http')
const fs = require('node:fs')
const mineflayer = require('mineflayer')
const { Rcon } = require('rcon-client')
const { TURNS, movement, aimError, rayHits, settleTerminal, rememberVisitor } = require('./combat')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const names = ['RedDQN', 'BlueDQN']
const bots = []; const stats = []
let rcon; let active = false; let resetting = false; let busy = false
let episode = 0; let phase = 'idle'; let startTime = 0; let endedAt = 0
let terminal = null; let maxSeconds = 70; let lastActions = [13, 13]
let finalState = null
let settling = null
let visitors = new Set()

function stopControls() { for (const bot of bots) bot.clearControlStates() }
function finish(reason, loser = null) {
  if (!active) return
  terminal = { reason, loser, winner: loser === null ? null : 1 - loser }
  active = false; endedAt = Date.now(); stopControls()
  // The clients have separate TCP streams. Drain the other player's same-tick
  // health packet before freezing a death, including simultaneous knockouts.
  settling = sleep(180).then(() => {
    terminal = settleTerminal(terminal, stats.map(s => s.dead))
    finalState = state()
    settling = null
  })
}
function state() {
  if (finalState && !active && !resetting) return finalState
  return {
    episode, phase, active, done: !!terminal, terminal, visitors: [...visitors],
    elapsed: startTime ? ((active ? Date.now() : endedAt || Date.now()) - startTime) / 1000 : 0,
    players: bots.map((b, i) => {
      const s = stats[i]; const p = b.entity.position
      const q = bots[1 - i]?.entity?.position || p
      return {
        name: b.username, position: { x: p.x, y: p.y, z: p.z },
        velocity: b.entity.velocity, yaw: b.entity.yaw, pitch: b.entity.pitch,
        health: s.dead ? 0 : b.health, food: b.food, onGround: b.entity.onGround,
        action: lastActions[i], hits: s.hits, damageDealt: s.dealt, damageTaken: s.taken,
        environmentDamage: s.environmentDamage, swings: s.swings,
        inventoryCount: b.inventory.items().length,
        cooldown: Math.min(1, (Date.now() - s.lastAttack) / 500),
        hurtCooldown: Math.min(1, (Date.now() - s.lastHurt) / 500),
        aimError: aimError(p, q, b.entity.yaw),
        distance: p.distanceTo(q), canHit: rayHits(p, b.entity.yaw, b.entity.pitch, q)
      }
    })
  }
}
async function command(cmd) { return rcon.send(cmd) }
async function reset(opts = {}) {
  if (settling) await settling
  active = false; resetting = true; terminal = null; finalState = null; stopControls()
  for (const bot of bots) if (bot.health <= 0) bot.respawn()
  // Mineflayer deliberately delays its post-respawn position packet by 1500 ms.
  // Complete that handshake before issuing a second teleport for a new episode.
  if (stats.some(s => s.dead)) await sleep(2100)
  for (const bot of bots) bot.physicsEnabled = false
  await sleep(100)
  episode++; phase = opts.phase || 'combat'; maxSeconds = opts.maxSeconds || 70
  const distance = opts.distance || 6
  const angle = opts.angle || 0
  const positions = [
    [-Math.cos(angle) * distance / 2, -Math.sin(angle) * distance / 2],
    [Math.cos(angle) * distance / 2, Math.sin(angle) * distance / 2]
  ]
  for (let i = 0; i < 2; i++) {
    const name = names[i]; const [x, z] = positions[i]
    await command(`gamemode survival ${name}`)
    await command(`clear ${name}`)
    await command(`effect clear ${name}`)
    await command(`effect give ${name} minecraft:instant_health 1 10 true`)
    await command(`effect give ${name} minecraft:saturation 1 10 true`)
    const yaw = opts.yaws ? opts.yaws[i] : (i ? 90 : -90)
    await command(`tp ${name} ${x.toFixed(4)} 64 ${z.toFixed(4)} ${yaw} 0`)
  }
  await sleep(300)
  for (const bot of bots) bot.physicsEnabled = true
  await sleep(150)
  for (let i = 0; i < 2; i++) {
    stats[i] = { hits: 0, dealt: 0, taken: 0, environmentDamage: 0, swings: 0,
      lastAttack: 0, lastHurt: 0, health: bots[i].health, dead: false }
  }
  visitors = new Set()
  for (const username of Object.keys(bots[0].players)) rememberVisitor(visitors, username)
  lastActions = [13, 13]; startTime = Date.now(); endedAt = 0
  resetting = false; active = true
  return state()
}
function control(i, action) {
  const bot = bots[i]; const target = bot.players[names[1 - i]]?.entity
  if (!target || !active) return
  const move = movement(action.move)
  if (!Number.isInteger(action.turn) || TURNS[action.turn] === undefined) throw new Error('invalid turn')
  lastActions[i] = action.move
  const delta = target.position.minus(bot.entity.position)
  const pitch = Math.atan2(delta.y + 1.0 - 1.62, Math.hypot(delta.x, delta.z))
  bot.look(bot.entity.yaw + TURNS[action.turn], pitch, true)
  for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) {
    bot.setControlState(k, !!move[k])
  }
}
function attack(i) {
  if (!active) return
  const b = bots[i]; const other = bots[1 - i]
  const target = b.players[other.username]?.entity
  const s = stats[i]
  if (!target || !movement(lastActions[i]).attack || Date.now() - s.lastAttack < 500) return
  if (rayHits(b.entity.position, b.entity.yaw, b.entity.pitch, target.position)) {
    s.lastAttack = Date.now(); s.swings++; b.attack(target)
  }
}
async function step(data) {
  if (!active) { if (settling) await settling; return state() }
  if (!Array.isArray(data.actions) || data.actions.length !== 2) throw new Error('two actions required')
  data.actions.forEach((a, i) => control(i, a))
  const duration = Math.min(500, Math.max(50, data.ms || 100))
  const until = Date.now() + duration
  while (active && Date.now() < until) {
    attack(0); attack(1)
    if ((Date.now() - startTime) / 1000 >= maxSeconds) finish('timeout')
    await sleep(Math.min(20, Math.max(1, until - Date.now())))
  }
  if (settling) await settling
  return state()
}
async function main() {
  rcon = await Rcon.connect({ host: '127.0.0.1', port: 25575, password: 'local-mcrl-only' })
  for (let i = 0; i < 2; i++) {
    let hasSpawned = false
    const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565,
      username: names[i], auth: 'offline', version: '1.20.4', hideErrors: false, respawn: false })
    bots.push(bot); stats.push({ hits: 0, dealt: 0, taken: 0, health: 20, dead: false, lastAttack: 0, lastHurt: 0, swings: 0, environmentDamage: 0 })
    bot.on('error', e => console.error(names[i], e.message))
    bot.on('playerJoined', player => {
      if (active || settling) rememberVisitor(visitors, player.username)
    })
    bot.on('kicked', reason => { console.error('KICK', names[i], reason); finish('disconnect', i) })
    bot.on('end', () => { finish('disconnect', i); console.error('DISCONNECTED', names[i]) })
    bot.on('health', () => {
      const s = stats[i]
      if ((active || settling) && !resetting && !s.dead && bot.health < s.health) {
        const damage = s.health - bot.health
        s.taken += damage; s.lastHurt = Date.now()
        if (Date.now() - stats[1 - i].lastAttack < 700) {
          stats[1 - i].dealt += damage; stats[1 - i].hits++
        } else s.environmentDamage += damage
      }
      s.health = bot.health
      if ((active || settling) && bot.health <= 0) { s.dead = true; finish('death', i) }
    })
    bot.on('death', () => {
      stats[i].dead = true
      // A bot disconnected on the death screen cannot emit its first spawn
      // after reconnecting until it requests respawn explicitly.
      if (!hasSpawned) bot.respawn()
      else finish('death', i)
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('spawn timeout')), 30000)
      bot.once('spawn', () => { clearTimeout(timer); resolve() })
      bot.once('error', reject)
    })
    hasSpawned = true
    console.log('JOINED', names[i])
  }
  await command('scoreboard objectives add damage_dealt minecraft.custom:minecraft.damage_dealt').catch(() => {})
  await command('scoreboard objectives add damage_taken minecraft.custom:minecraft.damage_taken').catch(() => {})
  const server = http.createServer(async (req, res) => {
    let acquired = false
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:3000') {
      res.statusCode = 403; return res.end(JSON.stringify({ error: 'Foreign browser origin rejected' }))
    }
    try {
      if (req.method === 'GET' && req.url === '/state') return res.end(JSON.stringify(state()))
      if (req.method !== 'POST') { res.statusCode = 404; return res.end('{}') }
      if (busy) { res.statusCode = 409; return res.end(JSON.stringify({ error: 'step/reset already running' })) }
      busy = true; acquired = true
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 100000) throw new Error('request too large')
      }
      const data = JSON.parse(body || '{}')
      let result
      if (req.url === '/reset') result = await reset(data)
      else if (req.url === '/step') result = await step(data)
      else if (req.url === '/stop') { finish('stopped'); result = state() }
      else if (req.url === '/command') result = { result: await command(data.command) }
      else throw new Error('unknown endpoint')
      res.end(JSON.stringify(result))
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); console.error(e) }
    finally { if (acquired) busy = false }
  })
  server.listen(3000, '127.0.0.1', () => console.log('BRIDGE_READY http://127.0.0.1:3000'))
  fs.mkdirSync('runs', { recursive: true }); fs.writeFileSync('runs/bridge.pid', `${process.pid}\n`)
  process.on('SIGINT', () => { stopControls(); bots.forEach(b => b.quit()); rcon.end(); server.close(); process.exit(0) })
}
const launch = process.env.HUMAN_OPPONENT ? require('./human').main : main
launch().catch(e => { console.error(e); process.exit(1) })
