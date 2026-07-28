import assert from 'node:assert/strict'
import test from 'node:test'

import {
    confirmOutgoingMessage,
    mergeConversationMessages,
    prepareOutgoingMessage,
} from '../src/renderer/src/function/outgoingMessage.ts'

test('prepares a group outgoing message for local persistence', () => {
    const message = prepareOutgoingMessage(
        { message_id: 'temporary', message: [], fake_msg: true },
        123,
        'group',
        456,
    )

    assert.equal(message.message_type, 'group')
    assert.equal(message.group_id, 123)
    assert.equal(message.infoList.group_id, 123)
    assert.equal(message.infoList.sender, 456)
})

test('normalizes a private outgoing message and confirms its real id', () => {
    const message = prepareOutgoingMessage(
        { message_id: 'temporary', message: [], fake_msg: true },
        123,
        'user',
        '456',
    )

    confirmOutgoingMessage(message, 789)

    assert.equal(message.message_type, 'private')
    assert.equal(message.user_id, 123)
    assert.equal(message.infoList.target_id, 123)
    assert.equal(message.message_id, 789)
    assert.equal(message.infoList.message_id, 789)
    assert.equal(message.fake_msg, false)
})

test('merges pending messages without duplicating a confirmed database record', () => {
    const local = [
        { message_id: 'old', time: 10, raw_message: 'old' },
        { message_id: 'confirmed', time: 20, raw_message: 'database' },
    ]
    const pending = [
        { message_id: 'confirmed', fake_message_id: 'temporary', time: 20, raw_message: 'pending' },
        { message_id: 'new', time: 30, raw_message: 'new' },
    ]

    const merged = mergeConversationMessages(local, pending)

    assert.deepEqual(merged.map((item) => item.message_id), ['old', 'confirmed', 'new'])
    assert.equal(merged[1].raw_message, 'pending')
})
