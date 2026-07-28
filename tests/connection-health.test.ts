import assert from 'node:assert/strict'
import test from 'node:test'

import {
    getHeartbeatIntervalSeconds,
    getHeartbeatTimeoutMs,
    isOneBotHeartbeat,
} from '../src/renderer/src/function/connectionHealth.ts'

test('only treats heartbeat meta events as heartbeats', () => {
    assert.equal(isOneBotHeartbeat({
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
    }), false)
    assert.equal(isOneBotHeartbeat({
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
    }), true)
})

test('prefers the OneBot reported interval in milliseconds', () => {
    assert.equal(getHeartbeatIntervalSeconds(30000, -1, 1000), 30)
})

test('falls back to monotonic arrival time', () => {
    assert.equal(getHeartbeatIntervalSeconds(undefined, 1000, 31000), 30)
})

test('adds scheduling tolerance to the heartbeat timeout', () => {
    assert.equal(getHeartbeatTimeoutMs(30), 75000)
    assert.equal(getHeartbeatTimeoutMs(1), 15000)
    assert.equal(getHeartbeatTimeoutMs(600), 300000)
})
