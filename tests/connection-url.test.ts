import assert from 'node:assert/strict'
import test from 'node:test'

import {
    resolveConnectionAddress,
    toInsecureWebSocketAddress,
} from '../src/renderer/src/function/connectionUrl.ts'

test('preserves an explicit secure websocket protocol', () => {
    assert.deepEqual(resolveConnectionAddress('wss://example.com/onebot'), {
        preferredAddress: 'wss://example.com/onebot',
        transportAddress: 'wss://example.com/onebot',
        allowInsecureFallback: false,
    })
})

test('converts explicit HTTP protocols without allowing downgrade', () => {
    assert.equal(
        resolveConnectionAddress('https://example.com').transportAddress,
        'wss://example.com/',
    )
    assert.equal(
        resolveConnectionAddress('http://example.com').transportAddress,
        'ws://example.com/',
    )
    assert.equal(
        resolveConnectionAddress('https://example.com').allowInsecureFallback,
        false,
    )
})

test('uses wss first for a public address without a protocol', () => {
    const resolved = resolveConnectionAddress('example.com:3001/onebot?client=ssqq')
    assert.equal(resolved.preferredAddress, 'example.com:3001/onebot?client=ssqq')
    assert.equal(
        resolved.transportAddress,
        'wss://example.com:3001/onebot?client=ssqq',
    )
    assert.equal(resolved.allowInsecureFallback, true)
    assert.equal(
        toInsecureWebSocketAddress(resolved.transportAddress),
        'ws://example.com:3001/onebot?client=ssqq',
    )
})

test('uses ws without fallback for local addresses', () => {
    assert.deepEqual(resolveConnectionAddress('127.0.0.1:3001'), {
        preferredAddress: '127.0.0.1:3001',
        transportAddress: 'ws://127.0.0.1:3001/',
        allowInsecureFallback: false,
    })
    assert.equal(
        resolveConnectionAddress('[::1]:3001').transportAddress,
        'ws://[::1]:3001/',
    )
})

test('trims input and canonicalizes protocol casing', () => {
    assert.equal(
        resolveConnectionAddress('  WSS://example.com/socket  ').preferredAddress,
        'wss://example.com/socket',
    )
})

test('rejects empty and unsupported addresses', () => {
    assert.throws(() => resolveConnectionAddress('  '), /不能为空/)
    assert.throws(
        () => resolveConnectionAddress('ftp://example.com/socket'),
        /不支持的连接协议/,
    )
})
