import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConnectionAddress } from '../src/renderer/src/function/connectionUrl.ts'

test('preserves an explicit secure websocket protocol', () => {
    assert.deepEqual(resolveConnectionAddress('wss://example.com/onebot'), {
        preferredAddress: 'wss://example.com/onebot',
        transportAddress: 'wss://example.com/onebot',
    })
})

test('accepts an explicit insecure websocket protocol', () => {
    assert.equal(
        resolveConnectionAddress('ws://127.0.0.1:3001').transportAddress,
        'ws://127.0.0.1:3001/',
    )
})

test('trims input and canonicalizes protocol casing', () => {
    assert.equal(
        resolveConnectionAddress('  WSS://example.com/socket  ').preferredAddress,
        'wss://example.com/socket',
    )
})

test('rejects empty, HTTP, and protocol-less addresses', () => {
    assert.throws(() => resolveConnectionAddress('  '), /不能为空/)
    const protocolError = /必须以 ws:\/\/ 或 wss:\/\/ 开头/
    assert.throws(() => resolveConnectionAddress('http://example.com'), protocolError)
    assert.throws(() => resolveConnectionAddress('https://example.com'), protocolError)
    assert.throws(() => resolveConnectionAddress('example.com:3001'), protocolError)
    assert.throws(() => resolveConnectionAddress('ftp://example.com/socket'), protocolError)
})
