export interface ConnectionAddress {
    /**
     * 用户首选地址。仅允许完整的 ws(s) WebSocket 地址。
     */
    preferredAddress: string
    /**
     * 本次首先尝试的完整 WebSocket 地址。
     */
    transportAddress: string
}

const WS_SCHEME_REG = /^wss?:\/\//i

function canonicalizeWebSocketProtocol(address: string) {
    if (/^wss:\/\//i.test(address))
        return 'wss://' + address.slice('wss://'.length)
    if (/^ws:\/\//i.test(address))
        return 'ws://' + address.slice('ws://'.length)
    return address
}

function validateWebSocketUrl(address: string) {
    const parsed = new URL(address)
    if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname) {
        throw new TypeError(`无效的 WebSocket 地址：${address}`)
    }
    return parsed.toString()
}

/**
 * 解析用户输入的 OneBot 地址。
 *
 * 只接受用户明确填写的 ws:// 或 wss:// 地址，不推断或转换协议。
 */
export function resolveConnectionAddress(input: string): ConnectionAddress {
    const address = input.trim()
    if (!address) throw new TypeError('WebSocket 地址不能为空')

    if (!WS_SCHEME_REG.test(address)) {
        throw new TypeError('连接地址必须以 ws:// 或 wss:// 开头')
    }

    const normalized = validateWebSocketUrl(canonicalizeWebSocketProtocol(address))
    return {
        preferredAddress: normalized,
        transportAddress: normalized,
    }
}
