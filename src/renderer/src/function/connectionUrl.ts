export interface ConnectionAddress {
    /**
     * 用户首选地址。显式协议会规范化为 ws(s)，未填写协议时保留原始输入，
     * 避免一次临时回退覆盖连接历史。
     */
    preferredAddress: string
    /**
     * 本次首先尝试的完整 WebSocket 地址。
     */
    transportAddress: string
    /**
     * 仅未填写协议的公网地址允许在首次握手失败后回退到明文 ws。
     */
    allowInsecureFallback: boolean
}

const LOCAL_HOST_REG =
    /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]|$)/i
const SCHEME_REG = /^[a-z][a-z\d+.-]*:\/\//i
const WS_SCHEME_REG = /^wss?:\/\//i
const HTTP_SCHEME_REG = /^https?:\/\//i

function canonicalizeExplicitProtocol(address: string) {
    if (/^https:\/\//i.test(address))
        return 'wss://' + address.slice('https://'.length)
    if (/^http:\/\//i.test(address))
        return 'ws://' + address.slice('http://'.length)
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
 * - 显式 ws(s)/http(s) 始终尊重用户选择，http(s) 只做等价协议转换；
 * - 未填写协议的本地地址默认 ws；
 * - 未填写协议的公网地址默认 wss，并允许一次 ws 回退。
 */
export function resolveConnectionAddress(input: string): ConnectionAddress {
    const address = input.trim()
    if (!address) throw new TypeError('WebSocket 地址不能为空')

    const hasExplicitSupportedProtocol =
        WS_SCHEME_REG.test(address) || HTTP_SCHEME_REG.test(address)
    if (SCHEME_REG.test(address) && !hasExplicitSupportedProtocol) {
        throw new TypeError(`不支持的连接协议：${address.split('://')[0]}`)
    }

    if (hasExplicitSupportedProtocol) {
        const normalized = validateWebSocketUrl(canonicalizeExplicitProtocol(address))
        return {
            preferredAddress: normalized,
            transportAddress: normalized,
            allowInsecureFallback: false,
        }
    }

    const local = LOCAL_HOST_REG.test(address)
    const transportAddress = validateWebSocketUrl(`${local ? 'ws' : 'wss'}://${address}`)
    return {
        preferredAddress: address,
        transportAddress,
        allowInsecureFallback: !local,
    }
}

export function toInsecureWebSocketAddress(address: string) {
    const parsed = new URL(address)
    if (parsed.protocol !== 'wss:') return address
    parsed.protocol = 'ws:'
    return parsed.toString()
}
