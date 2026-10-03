const test = require('node:test')
const assert = require('node:assert/strict')
const { parseHumanData } = require('../bridge/human')

test('human telemetry uses authoritative NBT health, food and grounded state', () => {
  assert.deepEqual(parseHumanData('Player has the following entity data: {Health: 7.5f, foodLevel: 18, OnGround: 1b, Inventory: []}'),
    { health: 7.5, food: 18, onGround: true, inventoryCount: 0 })
  assert.equal(parseHumanData('{Health: 0.0f, foodLevel: 20, OnGround: 0b, Inventory: []}').health, 0)
})

test('missing human data fails closed instead of inventing a living opponent', () => {
  assert.throws(() => parseHumanData('No entity was found'))
  assert.throws(() => parseHumanData('{Health: 20.0f}'))
})
