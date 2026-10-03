const TURNS = [-0.6, -0.2, -0.06, 0, 0.06, 0.2, 0.6]
const MOVES = [
  {}, { forward: true }, { forward: true, sprint: true },
  { left: true }, { right: true }, { forward: true, left: true },
  { forward: true, right: true }, { back: true },
  { back: true, left: true }, { back: true, right: true },
  { forward: true, sprint: true, jump: true },
  { left: true, jump: true }, { right: true, jump: true }, { attack: false }
]
function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)) }
function aimError(p, q, yaw) { return wrap(Math.atan2(p.x - q.x, p.z - q.z) - yaw) }
function movement(index) {
  if (!Number.isInteger(index) || !MOVES[index]) throw new Error('invalid movement')
  return { attack: true, ...MOVES[index] }
}
function rayHits(p, yaw, pitch, q, reach = 3) {
  const origin = [p.x, p.y + 1.62, p.z]
  const direction = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]
  const lo = [q.x - 0.3, q.y, q.z - 0.3]
  const hi = [q.x + 0.3, q.y + 1.8, q.z + 0.3]
  let near = 0; let far = reach
  for (let k = 0; k < 3; k++) {
    if (Math.abs(direction[k]) < 1e-9) {
      if (origin[k] < lo[k] || origin[k] > hi[k]) return false
    } else {
      const a = (lo[k] - origin[k]) / direction[k]
      const b = (hi[k] - origin[k]) / direction[k]
      near = Math.max(near, Math.min(a, b))
      far = Math.min(far, Math.max(a, b))
      if (near > far) return false
    }
  }
  return far >= 0 && near <= reach
}
function settleTerminal(terminal, dead) {
  if (dead.every(Boolean)) return { reason: 'death', loser: null, winner: null, doubleKO: true }
  const loser = dead.findIndex(Boolean)
  return loser < 0 ? terminal : { reason: 'death', loser, winner: 1 - loser }
}
function rememberVisitor(visitors, username) {
  if (username && !['RedDQN', 'BlueDQN', 'Camera'].includes(username)) visitors.add(username)
}
module.exports = { TURNS, MOVES, wrap, aimError, movement, rayHits, settleTerminal, rememberVisitor }
