const http = require('node:http')
const fs = require('node:fs')
const mineflayer = require('mineflayer')
const { Rcon } = require('rcon-client')
const { TURNS, movement, aimError, rayHits } = require('./combat')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function parseHumanData(text) {
  const field = name => {
    const match = text.match(new RegExp(`(?:[,{]\\s*)${name}:\\s*(-?\\d+(?:\\.\\d+)?)(?:[bfd])?(?=[,}\\s])`))
    if (!match) throw new Error(`Missing authoritative human field: ${name}`)
    return Number(match[1])
  }
  return { health: field('Health'), food: field('foodLevel'), onGround: field('OnGround') === 1,
    inventoryCount: /Inventory:\s*\[\s*\]/.test(text) ? 0 : 1 }
}

async function main() {
  const humanName = process.env.HUMAN_OPPONENT
  if (!/^[A-Za-z0-9_]{1,16}$/.test(humanName) || ['RedDQN', 'BlueDQN', 'Camera'].includes(humanName)) throw new Error('Invalid human opponent')
  const rcon = await Rcon.connect({ host: '127.0.0.1', port: 25575, password: 'local-mcrl-only' })
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'RedDQN', auth: 'offline', version: '1.20.4', respawn: false })
  let active = false; let ready = false; let startRequested = false; let resetting = false
  let terminal = null; let phase = 'human_waiting'; let episode = 0; let startedAt = 0; let endedAt = 0
  let humanOnline = false; let human = null; let previousPosition = null; let previousTime = 0
  let busy = false; let closing = false; let action = 13; let botHealth = 20
  const fresh = () => ({ hits: 0, dealt: 0, taken: 0, swings: 0, lastAttack: 0, lastHurt: 0 })
  let stats = [fresh(), fresh()]
  const command = text => rcon.send(text)
  const announce = text => command(`tellraw ${humanName} ${JSON.stringify({ text, color: 'gold' })}`)
  const target = () => bot.players[humanName]?.entity

  function finish(reason, loser = null) {
    if (!active) return
    active = false; ready = false; endedAt = Date.now(); bot.clearControlStates()
    terminal = { reason, loser, winner: loser === null ? null : 1 - loser }
    phase = 'human_finished'
    console.log(JSON.stringify({ event: 'human_round_end', episode, terminal, damage: stats.map(s => s.dealt) }))
  }
  bot.on('health', () => {
    const damage = Math.max(0, botHealth - bot.health)
    if (!resetting && damage > 0) {
      if (ready) startRequested = true
      if (active || phase === 'human_finished') {
        stats[0].taken += damage; stats[0].lastHurt = Date.now()
        stats[1].dealt += damage; stats[1].hits++
      }
    }
    botHealth = bot.health
    if (active && bot.health <= 0) finish('death', 0)
  })
  bot.on('entitySwingArm', entity => {
    if (entity.username === humanName || entity.id === target()?.id) {
      stats[1].lastAttack = Date.now(); stats[1].swings++
    }
  })
  bot.on('playerLeft', player => { if (player.username === humanName) { humanOnline = false; ready = false; finish('disconnect', 1) } })
  bot.on('entityDead', entity => { if (entity.id === target()?.id && active) finish('death', 1) })
  // A dead client stops seeing player entities, so respawn cannot wait for prepare().
  bot.on('death', () => { if (active) finish('death', 0); bot.respawn() })
  bot.on('error', error => console.error(error))
  bot.on('end', () => { if (!closing) { console.error('Human fighter disconnected'); process.exit(1) } })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Human fighter spawn timeout')), 30000)
    bot.once('spawn', () => { clearTimeout(timer); resolve() })
    bot.once('error', reject)
  })

  async function syncHuman() {
    const entity = target()
    if (!entity) { humanOnline = false; finish('disconnect', 1); return }
    let data
    try { data = parseHumanData(await command(`data get entity ${humanName}`)) }
    catch (error) {
      humanOnline = false; finish('disconnect', 1); console.error(error.message); return
    }
    humanOnline = true
    const now = Date.now(); const position = entity.position.clone()
    const dt = Math.max(.02, (now - previousTime) / 1000)
    const velocity = previousPosition ? position.minus(previousPosition).scaled(1 / (20 * dt)) : position.scaled(0)
    if (human && (active || phase === 'human_finished') && !resetting && data.health < human.health) {
      const damage = human.health - data.health
      stats[1].taken += damage; stats[1].lastHurt = now
      stats[0].dealt += damage; stats[0].hits++
    }
    human = { ...data, position, velocity, yaw: entity.yaw || 0, pitch: entity.pitch || 0 }
    previousPosition = position; previousTime = now
    if (active && data.health <= 0) finish('death', 1)
    if (terminal?.reason === 'death' && bot.health <= 0 && data.health <= 0) terminal = { reason: 'death', loser: null, winner: null, doubleKO: true }
  }
  function state() {
    const p = bot.entity.position
    const other = human || { position: p, velocity: p.scaled(0), yaw: 0, pitch: 0, health: 0, food: 20, onGround: true, inventoryCount: 0 }
    const actors = [{ name: 'RedDQN', position: p, velocity: bot.entity.velocity, yaw: bot.entity.yaw, pitch: bot.entity.pitch,
      health: bot.health, food: bot.food, onGround: bot.entity.onGround, inventoryCount: bot.inventory.items().length }, { name: humanName, ...other }]
    return { mode: 'human', humanName, humanOnline, episode, phase, active, ready, startRequested, done: !!terminal, terminal,
      elapsed: startedAt ? ((active ? Date.now() : endedAt || Date.now()) - startedAt) / 1000 : 0,
      players: actors.map((a, i) => ({ ...a, action: i ? 'HUMAN' : action, hits: stats[i].hits,
        damageDealt: stats[i].dealt, damageTaken: stats[i].taken, environmentDamage: 0, swings: stats[i].swings,
        cooldown: Math.min(1, (Date.now() - stats[i].lastAttack) / 500), hurtCooldown: Math.min(1, (Date.now() - stats[i].lastHurt) / 500),
        aimError: aimError(a.position, actors[1 - i].position, a.yaw), distance: a.position.distanceTo(actors[1 - i].position),
        canHit: rayHits(a.position, a.yaw, a.pitch, actors[1 - i].position) })) }
  }
  async function prepare() {
    active = false; ready = false; resetting = true; terminal = null; bot.clearControlStates()
    try {
      await syncHuman()
      if (!humanOnline || human.health <= 0) return state()
      if (human.inventoryCount) throw new Error('Empty your inventory before starting the empty-hand duel; no items were removed')
      if (bot.health <= 0) { bot.respawn(); await sleep(2100) }
      for (const name of ['RedDQN', humanName]) {
        await command(`gamemode survival ${name}`)
        await command(`effect clear ${name}`)
        await command(`effect give ${name} minecraft:instant_health 1 10 true`)
        await command(`effect give ${name} minecraft:saturation 1 10 true`)
      }
      await command('clear RedDQN')
      bot.physicsEnabled = false
      await command('tp RedDQN -2 64 0 -90 0')
      await command(`tp ${humanName} 2 64 0 90 0`)
      await sleep(300); bot.physicsEnabled = true; await sleep(150)
      previousPosition = null; await syncHuman()
      stats = [fresh(), fresh()]; botHealth = bot.health; action = 13
      startRequested = false; ready = true; phase = 'human_ready'; startedAt = 0; endedAt = 0
      await announce('空手对战已准备好：打一下 RedDQN 开局。每局死亡即结束，复活后可再来。')
      return state()
    } finally { resetting = false; bot.physicsEnabled = true }
  }
  async function begin() {
    if (!ready || !startRequested) throw new Error('Punch RedDQN to request a round first')
    ready = false; resetting = true; bot.clearControlStates()
    try {
      if (bot.health <= 0) { bot.respawn(); await sleep(2100) }
      for (let count = 3; count > 0; count--) {
        await command(`title ${humanName} actionbar ${JSON.stringify({ text: `空手对战 ${count}`, color: 'yellow' })}`)
        await sleep(1000)
      }
      // Reset countdown knockback so both fighters start at the intended gap.
      bot.physicsEnabled = false
      await command('tp RedDQN -2 64 0 -90 0')
      await command(`tp ${humanName} 2 64 0 90 0`)
      await sleep(200)
      bot.physicsEnabled = true
      for (const name of ['RedDQN', humanName]) {
        await command(`effect give ${name} minecraft:instant_health 1 10 true`)
        await command(`effect give ${name} minecraft:saturation 1 10 true`)
      }
      await sleep(200); previousPosition = null; await syncHuman()
      if (!humanOnline || human.health <= 0 || bot.health <= 0) throw new Error('Both fighters must be alive to begin')
      stats = [fresh(), fresh()]; botHealth = bot.health
      episode++; startedAt = Date.now(); endedAt = 0; terminal = null; startRequested = false
      phase = 'human_pvp'; active = true
      await command(`title ${humanName} actionbar ${JSON.stringify({ text: '开始！', color: 'red' })}`)
      return state()
    } finally { resetting = false; bot.physicsEnabled = true }
  }
  async function step(data) {
    await syncHuman()
    if (!active) return state()
    const a = data.actions?.[0]
    if (!a || !Number.isInteger(a.turn) || TURNS[a.turn] === undefined) throw new Error('Invalid human duel action')
    const move = movement(a.move); action = a.move
    const delta = target().position.minus(bot.entity.position)
    bot.look(bot.entity.yaw + TURNS[a.turn], Math.atan2(delta.y + 1 - 1.62, Math.hypot(delta.x, delta.z)), true)
    for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) bot.setControlState(k, !!move[k])
    const until = Date.now() + Math.min(500, Math.max(50, data.ms || 100))
    while (active && Date.now() < until) {
      const entity = target()
      if (!entity) { finish('disconnect', 1); break }
      if (move.attack && Date.now() - stats[0].lastAttack >= 500 && rayHits(bot.entity.position, bot.entity.yaw, bot.entity.pitch, entity.position)) {
        stats[0].lastAttack = Date.now(); stats[0].swings++; bot.attack(entity)
      }
      if (Date.now() - startedAt > 180000) finish('timeout')
      await sleep(20)
    }
    await syncHuman()
    return state()
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:3000') {
      res.statusCode = 403; return res.end(JSON.stringify({ error: 'Foreign browser origin rejected' }))
    }
    if (req.method === 'GET' && req.url === '/state') return res.end(JSON.stringify(state()))
    if (busy) { res.statusCode = 409; return res.end(JSON.stringify({ error: 'Human duel request already running' })) }
    busy = true
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 10000) throw new Error('Request too large') }
      const data = JSON.parse(body || '{}')
      let result
      if (req.url === '/observe') { await syncHuman(); result = state() }
      else if (req.url === '/prepare') result = await prepare()
      else if (req.url === '/begin') result = await begin()
      else if (req.url === '/step') result = await step(data)
      else if (req.url === '/stop') { finish('stopped'); ready = false; bot.clearControlStates(); result = state() }
      else if (req.url === '/command') result = { result: await command(data.command) }
      else throw new Error('Unsupported human duel endpoint')
      res.end(JSON.stringify(result))
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); console.error(error.message) }
    finally { busy = false }
  })
  server.listen(3000, '127.0.0.1', () => console.log(`HUMAN_BRIDGE_READY ${humanName}`))
  fs.writeFileSync('runs/bridge.pid', `${process.pid}\n`)
  const shutdown = () => { closing = true; active = false; ready = false; bot.clearControlStates(); bot.quit(); rcon.end(); server.close(); setTimeout(() => process.exit(0), 200) }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
}

module.exports = { parseHumanData, main }
