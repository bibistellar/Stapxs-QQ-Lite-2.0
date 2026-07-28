export interface PendingOutgoingMessage {
    chatId: number
    message: any
}

/**
 * 补齐预发送消息写入本地历史所需的会话信息。
 */
export function prepareOutgoingMessage(
    message: any,
    chatId: number,
    chatType: string,
    selfId: string | number,
) {
    const isGroup = chatType === 'group'
    message.message_type = isGroup ? 'group' : 'private'
    if (isGroup) {
        message.group_id = chatId
        delete message.user_id
    } else {
        message.user_id = chatId
        delete message.group_id
    }
    message.infoList = {
        ...(message.infoList ?? {}),
        message_id: message.message_id,
        sender: Number(selfId),
        group_id: isGroup ? chatId : undefined,
        private_id: isGroup ? undefined : chatId,
        target_id: isGroup ? undefined : chatId,
    }
    return message
}

/**
 * 将后端确认的真实消息 ID 写回预发送消息。
 */
export function confirmOutgoingMessage(message: any, messageId: string | number) {
    message.message_id = messageId
    message.fake_msg = false
    if (message.infoList) {
        message.infoList.message_id = messageId
    }
    return message
}

/**
 * 合并本地数据库消息和仍在等待确认/落库的预发送消息。
 * pending 放在后面，使其在 ID 相同时覆盖较旧的数据库对象。
 */
export function mergeConversationMessages(local: any[], pending: any[]) {
    const merged = new Map<string, any>()
    const withoutId: any[] = []

    for (const item of [...local, ...pending]) {
        const id = item?.message_id ?? item?.fake_message_id
        if (id === undefined || id === null || String(id) === '') {
            withoutId.push(item)
        } else {
            merged.set(String(id), item)
        }
    }

    return [...merged.values(), ...withoutId].sort((a, b) => {
        const timeA = Number(a?.time)
        const timeB = Number(b?.time)
        const safeTimeA = Number.isFinite(timeA) ? timeA : 0
        const safeTimeB = Number.isFinite(timeB) ? timeB : 0
        return safeTimeA - safeTimeB
    })
}
