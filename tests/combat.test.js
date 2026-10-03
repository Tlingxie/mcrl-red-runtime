const test = require('node:test')
const assert = require('node:assert/strict')
const { wrap, aimError, rayHits, movement, settleTerminal, rememberVisitor } = require('../bridge/combat')

test('yaw wraps across pi and points along Minecraft -Z', () => {
  assert.ok(Math.abs(wrap(2 * Math.PI + 0.2) - 0.2) < 1e-8)
  assert.equal(aimError({ x: 0, z: 0 }, { x: 0, z: -2 }, 0), 0)
})
test('attack requires actual camera ray, survival reach and height', () => {
  const p = { x: 0, y: 64, z: 0 }
  const q = { x: 0, y: 64, z: -2 }
  assert.equal(rayHits(p, 0, 0, q), true)
  assert.equal(rayHits(p, Math.PI, 0, q), false)
  assert.equal(rayHits(p, 0, 0, { ...q, z: -4 }), false)
  assert.equal(rayHits(p, 0, 0, { ...q, y: 68 }), false)
})
test('retreat has backward control and no conflicting forward', () => {
  assert.equal(movement(7).back, true)
  assert.equal(movement(7).forward, undefined)
  assert.equal(movement(13).attack, false)
})
test('in-flight lethal packets override timeout and detect double knockout', () => {
  const timeout = { reason: 'timeout', loser: null, winner: null }
  assert.deepEqual(settleTerminal(timeout, [true, false]), { reason: 'death', loser: 0, winner: 1 })
  assert.deepEqual(settleTerminal(timeout, [true, true]), { reason: 'death', loser: null, winner: null, doubleKO: true })
  assert.deepEqual(settleTerminal(timeout, [false, false]), timeout)
})
test('episode isolation remembers a brief external arrival but permits the camera', () => {
  const visitors = new Set()
  for (const name of ['RedDQN', 'BlueDQN', 'Camera']) rememberVisitor(visitors, name)
  assert.equal(visitors.size, 0)
  rememberVisitor(visitors, 'Observer')
  rememberVisitor(visitors, 'Observer')
  assert.deepEqual([...visitors], ['Observer'])
})
