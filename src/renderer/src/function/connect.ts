/*
 * @FileDescription: Websocket 底层模块
 * @Author: Stapxs
 * @Date: 2022/10/20
 * @Version: 1.0
 * @Description: 此模块主要处理 Websocket 交互相关功能
 */

import Option from './option'
import app from '@renderer/main'

import { reactive } from 'vue'
import { LogType, Logger, PopType, PopInfo } from './base'
import { dispatch } from './msg'

import { BotActionElem, LoginCacheElem, ConnectionHistoryItem } from './elements/system'
import { updateMenu } from '@renderer/function/utils/appUtil'

import { v4 as uuid } from 'uuid'
import { getMsgData } from './utils/msgUtil'
import { backend } from '@renderer/runtime/backend'
import { useSettingsStore } from '@renderer/state/settings'
import { useAuthStore } from '@renderer/state/auth'
import { useConnectionStore } from '@renderer/state/connection'

const logger = new Logger()
const popInfo = new PopInfo()

let retry = 0
let forceCloseReason: string | undefined = undefined

// 断线自动重连状态 =====================================================
// PS：wantConnected 表示「已经成功连过、期望保持连接」。它只在成功握手后置 true，
//     在用户主动断开时置 false。掉线重连、唤醒/联网重连都以它为准，这样即便多次
//     重连失败也能一直沿着退避节奏重试，而不需要用户手动再点一次登录。
let reconnectTimer: number | undefined = undefined
let reconnectAttempts = 0
let wantConnected = false
let lifecycleHooksBound = false
let lastReconnectNow = 0
// 退避上限 30s；每次失败翻倍，成功后归零
const RECONNECT_MAX_DELAY = 30000
// 唤醒/联网事件去抖，避免多个事件在同一时刻重复触发重连
const RECONNECT_NOW_DEBOUNCE = 3000

export let websocket: WebSocket | undefined = undefined
const WS_PROTOCOL = 'ws' + '://'
const WSS_PROTOCOL = 'wss' + '://'

function parseUrl(url: string) {
    try {
        return new URL(url)
    } catch (e) {
        if (e instanceof TypeError) return undefined
        throw e
    }
}

export function appendAccessToken(url: string, token?: string) {
    if (!token) return url
    const parsedUrl = parseUrl(url)
    if (parsedUrl) {
        parsedUrl.searchParams.set('access_token', token)
        return parsedUrl.toString()
    }

    const [baseUrl, hash = ''] = url.split('#')
    const tokenParam = `access_token=${encodeURIComponent(token)}`
    const hashSuffix = hash ? `#${hash}` : ''
    const nextUrl = baseUrl
        .replace(/([?&])access_token=[^&]*/, `$1${tokenParam}`)
    if (nextUrl !== baseUrl) return nextUrl + hashSuffix
    const sep = baseUrl.includes('?') ? '&' : '?'
    return `${baseUrl}${sep}${tokenParam}${hashSuffix}`
}

export function decodeStoredToken(token: string): string
export function decodeStoredToken(token: undefined): undefined
export function decodeStoredToken(token: string | undefined) {
    if (token === undefined) return undefined
    if (token === '') return ''
    try {
        return decodeURIComponent(token)
    } catch (e) {
        if (!(e instanceof URIError)) throw e
        return token
    }
}

function normalizeConnectionHistory(history: unknown[]) {
    return history.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return []
        const historyItem = item as Partial<ConnectionHistoryItem>
        if (typeof historyItem.address !== 'string') return []
        return [{
            ...historyItem,
            address: historyItem.address,
            token: typeof historyItem.token === 'string'? decodeStoredToken(historyItem.token): '',
            lastConnected: typeof historyItem.lastConnected === 'number'? historyItem.lastConnected: 0
        }]
    })
}

function withWebSocketProtocol(address: string, secure: boolean) {
    return `${secure ? WSS_PROTOCOL : WS_PROTOCOL}${address}`
}

// 本地/局域网地址（IPv4、IPv6、localhost），这类地址默认使用明文 ws
const LOCAL_ADDRESS_REG =
    /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]|$)/i

/**
 * 把 http(s) 协议的地址转换为 ws(s)
 * PS：用户经常会直接粘贴 OneBot 的 http 地址，此时不能把它当作“没有协议”再拼一个 ws://，
 *     否则会得到 ws://https://... 这种非法地址（浏览器会报 scheme 错误）
 */
function normalizeProtocol(address: string) {
    if (address.startsWith('https://'))
        return WSS_PROTOCOL + address.slice('https://'.length)
    if (address.startsWith('http://'))
        return WS_PROTOCOL + address.slice('http://'.length)
    return address
}

/**
 * 补全缺失的 ws(s) 协议
 * PS：后端连接模式下地址会被原样交给后端解析（Tauri 使用 http::Uri），
 *     缺少协议会直接解析失败，所以发给后端前必须补全
 */
function withDefaultProtocol(address: string) {
    if (
        address.startsWith(WS_PROTOCOL) ||
        address.startsWith(WSS_PROTOCOL)
    ) {
        return address
    }
    return withWebSocketProtocol(address, !LOCAL_ADDRESS_REG.test(address))
}

class TimeoutError extends Error {
    echo: string
    constructor(echo: string) {
        super()
        this.echo = echo
    }
}

export class Connector {
    /**
     * 创建 Websocket 连接
     * @param address 地址
     * @param token 密钥
     */
    static create(
        address: string,
        token?: string,
        wss: boolean | undefined = undefined,
    ) {
        const { $t } = app.config.globalProperties
        const settingsStore = useSettingsStore()
        login.creating = true

        // 设置连接超时保护
        window.setTimeout(() => {
            if (login.creating) {
                login.creating = false
            }
        }, 10000)

        logger.add(LogType.WS, '当前处于 ALL 日志模式。连接器将输出全部收发消息 ……')

        // 把 http(s) 地址转换为 ws(s)
        address = normalizeProtocol(address)

        // 确保 address 包含路径部分，避免部分服务器因 HTTP 请求路径为空而返回 400
        const withoutProtocol = address.replace(/^(wss?|https?):(\/\/)/, '')
        if (!withoutProtocol.includes('/')) {
            address = address + '/'
        }

        // 记录当前连接目标，供唤醒/联网后的自动重连使用
        login.address = address
        login.token = token ?? ''

        // Electron 默认使用后端连接模式
        if (!backend.isWeb()) {
            logger.add(LogType.WS, '使用后端连接模式')
            // PS：后端拿到的必须是带协议的完整地址，否则无法解析
            const backendAddress = withDefaultProtocol(address)
            backend.call('Onebot', 'onebot:connect', false,
                backend.isDesktop() ?  { address: backendAddress, token: token, } : { url: appendAccessToken(backendAddress, token) })
            return
        }

        if(import.meta.env.VITE_APP_SSE_MODE == 'true') {
            if(import.meta.env.VITE_APP_SSE_SUPPORT == 'false') {
                // 如果 Bot 不支持 SSE 连接，直接跳过触发连接完成的后续操作
                // PS：在未连接 SSE 的情况下，ssqq 将会缺失一些功能：
                // - 新的消息推送、通知推送
                // - 聊天面板新消息将不会自动更新，但依旧可以通过重新加载面板来获取新消息
                this.onopen(address, token)
                return
            }
            logger.add(LogType.WS, '使用 SSE 连接模式')
            const sse = new EventSource(appendAccessToken(import.meta.env.VITE_APP_SSE_EVENT_ADDRESS, token))
            sse.onopen = () => {
                login.creating = false
                this.onopen(address, token)
            }
            sse.onmessage = (e) => {
                this.onmessage(e.data)
            }
            sse.onerror = () => {
                login.creating = false
                popInfo.add(PopType.ERR, $t('连接不稳定'))
                return
            }
            return
        } else {
            // PS：只有在未设定 wss 类型的情况下才认为是首次连接
            if (wss == undefined) {
                retry = 0
            } else {
                retry++
            }
            // 最多自动重试连接五次
            if (retry > 5) {
                login.creating = false
                return
            }

            let url = appendAccessToken(withWebSocketProtocol(address, false), token)
            if (address.startsWith(WS_PROTOCOL) || address.startsWith(WSS_PROTOCOL)) {
                url = appendAccessToken(address, token)
            } else if (wss == undefined) {
                // 判断连接类型
                if (document.location.protocol == 'https:') {
                    // 判断连接 URL 的协议，https 优先尝试 wss
                    settingsStore.connectSsl = true
                    url = appendAccessToken(withWebSocketProtocol(address, true), token)
                }
            } else {
                url = appendAccessToken(withWebSocketProtocol(address, true), token)
            }

            if (!websocket) {
                websocket = new WebSocket(url)
            }

            websocket.onopen = () => {
                login.creating = false
                this.onopen(address, token)
            }
            websocket.onmessage = (e) => {
                this.onmessage(e.data)
            }
            websocket.onclose = (e) => {
                login.creating = false
                const reason = forceCloseReason ?? e.reason
                forceCloseReason = undefined
                this.onclose(e.code, reason, address, token)
            }
            websocket.onerror = (e) => {
                login.creating = false
                if (e instanceof ErrorEvent) {
                    popInfo.add(PopType.ERR, $t('连接失败') + ': ' + e.message)
                } else {
                    popInfo.add(PopType.ERR, $t('连接失败') + ': ' + $t('未知错误'))
                }
            }
        }
    }

    // 连接事件 =====================================================

    static onopen(address: string, token: string | undefined) {
        const settingsStore = useSettingsStore()
        logger.add(LogType.WS, '连接成功')
        // 握手成功：进入「期望保持连接」状态，清空重连退避
        wantConnected = true
        reconnectAttempts = 0
        if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = undefined
        }
        // 保存登录信息
        Option.save('address', address)
        // 保存密钥
        if (
            settingsStore.sysConfig.save_password &&
            settingsStore.sysConfig.save_password != ''
        ) {
            Option.save('save_password', token)
        }
        // 清空应用通知
        popInfo.clear()
        // 加载初始化数据
        // PS：标记登陆成功在获取用户信息的回调位置，防止无法获取到内容
        Connector.send('get_version_info', {}, 'getVersionInfo')
        // 更新菜单
        updateMenu({
            parent: 'account',
            id: 'logout',
            action: 'visible',
            value: 'true',
        })
    }

    static onmessage(message: string) {
        const data = JSON.parse(message)
        logger.add(LogType.WS, 'GET：', data)
        if (data.echo === undefined){
            dispatch(data)
        }
        if (data.echo) {
            let echo: string = data.echo
            delete data.echo
            // 旧回调系统处理
            if (echo.startsWith('send_')) {
                echo = echo.slice(5)
                dispatch(data, echo)
                return
            }
            this.ReMap.set(echo, data)
        }
    }

    /**
     * 返回值Map
     */
    private static ReMap: Map<string, any> = new Map()

    private static waitReturn(echo: string, timeout: number=5000): Promise<any> {
        return new Promise((resolve, reject) => {
            const startTime = Date.now()

            const check = () => {
                if (this.ReMap.has(echo)) {
                    const re = this.ReMap.get(echo)
                    this.ReMap.delete(echo)
                    resolve(re)
                    return
                }

                if (Date.now() - startTime > timeout) {
                    reject(new TimeoutError(echo))
                    return
                }

                setTimeout(check, 20)
            }

            check()
        })
    }

    static onclose(
        code: number,
        msg: string | undefined,
        address: string,
        token: string | undefined,
    ) {
        const { $t } = app.config.globalProperties
        const connectionStore = useConnectionStore()

        if (connectionStore.metaEventWatchTimer) {
            clearTimeout(connectionStore.metaEventWatchTimer)
            connectionStore.metaEventWatchTimer = undefined
        }
        connectionStore.metaEventTimeoutTriggered = false
        websocket = undefined
        updateMenu({ parent: 'account', id: 'logout', action: 'visible', value: 'false' })
        updateMenu({ parent: 'account', id: 'userName', action: 'label', value: $t('连接') })

        switch (Number(code)) {
            case 1000:
                popInfo.add(PopType.INFO, $t('连接已断开') + (msg ? (': ' + msg.replace(':', ' - ')) : ''), false)
                break // 正常关闭
            case 1006: {
                // 非正常关闭，尝试重连
                if (wantConnected) {
                    // 曾经连上过：说明是掉线（网络波动 / 服务端重启 / 睡眠唤醒），
                    // 按退避节奏无限重连，不再需要用户手动重新登录
                    popInfo.add(PopType.ERR, $t('连接失败') + ': ' + $t('连接异常关闭'), false)
                    this.scheduleReconnect(address, token)
                } else {
                    // 从未连上过（首次连接失败）：保持原有协议回退逻辑，尝试明文 ws
                    popInfo.add(PopType.ERR, $t('连接失败') + ': ' + $t('连接异常关闭'), false)
                    this.create(address, token, false)
                }
                break
            }
            case 1015: {
                // TLS 错误
                popInfo.add(PopType.ERR, $t('连接失败') + ': ' + $t('TLS错误'), false)
                if (wantConnected) {
                    this.scheduleReconnect(address, token)
                } else {
                    // 首次连接的 TLS 错误：尝试使用 ws 连接
                    this.create(address, token, false)
                }
                break
            }
            default: {
                login.creating = false
                popInfo.add(PopType.ERR, $t('连接失败') + ': ' + $t('未知的错误 {code}',{ code: code }), false)
            }
        }

        logger.error(null, $t('连接失败') + ': ' + code)
        login.creating = false
        login.status = false
    }

    // 连接器操作 =====================================================

    /**
     * 正常断开 Websocket 连接
     */
    static close() {
        const connectionStore = useConnectionStore()
        if (connectionStore.metaEventWatchTimer) {
            clearTimeout(connectionStore.metaEventWatchTimer)
            connectionStore.metaEventWatchTimer = undefined
        }
        connectionStore.metaEventTimeoutTriggered = false
        forceCloseReason = undefined
        // 用户主动断开：停止自动重连
        wantConnected = false
        reconnectAttempts = 0
        if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = undefined
        }

        if(!backend.isWeb()) {
            backend.call('Onebot', 'onebot:close', false)
        } else {
            popInfo.add(
                PopType.INFO,
                app.config.globalProperties.$t('正在断开链接……'),
            )
            if (websocket) websocket.close(1000)
        }
    }

    static forceDisconnect(reason: string) {
        const connectionStore = useConnectionStore()
        if (connectionStore.metaEventWatchTimer) {
            clearTimeout(connectionStore.metaEventWatchTimer)
            connectionStore.metaEventWatchTimer = undefined
        }
        if (connectionStore.metaEventTimeoutTriggered && forceCloseReason === reason) {
            return
        }
        connectionStore.metaEventTimeoutTriggered = true
        forceCloseReason = reason

        if(!backend.isWeb()) {
            this.onclose(1006, reason, login.address, login.token)
            return
        }
        if (websocket) {
            websocket.close(4000, reason)
            return
        }
        this.onclose(1006, reason, login.address, login.token)
    }

    /**
     * 掉线后按指数退避排期重连（2s、4s、8s…，上限 30s，成功后归零）
     * PS：只在「曾经连上过」（wantConnected）时启用，避免和首次连接的协议回退冲突。
     *     Electron 后端掉线时上报的是 code -1 并自行重连，不会走到这里，因此不会重复重连。
     */
    static scheduleReconnect(address: string, token: string | undefined) {
        if (!wantConnected) return
        if (reconnectTimer) return
        // PS：onclose 会在 switch 之后才把 login.status 置 false，所以这里不能用
        //     login.status 作为门槛（此刻它可能还是 true）；实际的连接状态判断放到
        //     定时器回调里，届时状态已经稳定。
        const delay = Math.min(
            RECONNECT_MAX_DELAY,
            1000 * Math.pow(2, reconnectAttempts),
        )
        reconnectAttempts++
        logger.add(LogType.WS, `连接断开，将在 ${delay / 1000}s 后进行第 ${reconnectAttempts} 次重连 ……`)
        reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined
            if (!wantConnected || login.status || login.creating) return
            this.create(address, token, undefined)
        }, delay)
    }

    /**
     * 立即重连（网络恢复 / 窗口唤醒时调用）
     * PS：睡眠唤醒后 socket 往往已经静默失效，但不会立刻触发 onclose；此时若还「期望
     *     保持连接」且当前未连接，就重置退避立即重连，无需等待下一次退避 tick。
     */
    static reconnectNow() {
        if (!wantConnected) return
        if (login.status || login.creating) return
        const now = Date.now()
        if (now - lastReconnectNow < RECONNECT_NOW_DEBOUNCE) return
        lastReconnectNow = now
        if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = undefined
        }
        reconnectAttempts = 0
        logger.add(LogType.WS, '检测到网络恢复 / 窗口唤醒，立即尝试重连 ……')
        this.create(login.address, login.token, undefined)
    }

    /**
     * 注册网络/窗口生命周期钩子，用于睡眠唤醒、断网恢复后自动重连（只注册一次）
     */
    static registerLifecycleHooks() {
        if (lifecycleHooksBound) return
        lifecycleHooksBound = true
        const trigger = () => this.reconnectNow()
        window.addEventListener('online', trigger)
        window.addEventListener('focus', trigger)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.reconnectNow()
        })
    }

    /**
     * 调用 api
     * TODO 标准API适配
     * @param api  api名称,该api应该为映射Map里存在的键
     * @param args 参数
     * @returns undefined 表示无此API, null表示调用失败, 其余为经getMsgData过滤的返回值
     */
    static async callApi(api: string, args: {[key: string]: any}): Promise<any|undefined|null>{
        // 组建信息
        const echo = uuid()
        const authStore = useAuthStore()
        const apiMap = authStore.jsonMap?.[api]
        if (!apiMap) {
            logger.debug(`${authStore.jsonMap?.name} 未适配 API ${api}`)
            return undefined
        }

        // 发送信息
        if(import.meta.env.VITE_APP_SSE_MODE == 'true') {
            // 使用 http POST 请求 /api/$name,body 为 json
            this.sendSeeMod(apiMap.name, args, echo)
        } else {
            this.sendRaw(apiMap.name, args, echo)
        }

        // 处理响应
        try{
            const re = await this.waitReturn(echo)
            return getMsgData(api, re, apiMap)
        }catch (e) {
            if (e instanceof TimeoutError) {
                logger.error(e, `API ${api} 请求超时`)
            }else {
                logger.error(e as Error, `API ${api} 请求失败`)
            }
        }
        return null
    }

    /**
     * 发送 Websocket 消息
     * @param name 事件名
     * @param value 参数
     * @param echo 回调名
     * @deprecated 该函数看似在掉api,其实还有去指定对象调用回调函数,无法拿到api返回值
     */
    static send(
        name: string,
        value: { [key: string]: any },
        echo: string = name,
    ) {
        echo = 'send_' + echo
        if(import.meta.env.VITE_APP_SSE_MODE == 'true') {
            // 使用 http POST 请求 /api/$name,body 为 json
            this.sendSeeMod(name,value,echo)
        } else {
            this.sendRaw(name, value, echo)
        }
    }
    /**
     * 使用 see 模式发请求，请求结果会一并送到onmessage方法上
     * @param name api名称
     * @param args 参数
     * @param echo 回调标识
     */
    static sendSeeMod(
        name: string,
        args: { [key: string]: any },
        echo: string = name,
    ) {
        fetch(`${import.meta.env.VITE_APP_SSE_HTTP_ADDRESS}/${name}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': login.token,
            },
            body: JSON.stringify(args),
        }).then(async (response) => {
            if (response.ok) {
                try {
                    const data = await response.json()
                    data.echo = echo
                    this.onmessage(JSON.stringify(data))
                } catch (e) {
                    logger.error(null, `API ${name} 返回非 JSON 数据`)
                }
            }
        }).catch((error) => {
            logger.error(error, ` 请求 API ${name} 失败`)
        })
    }
    /**
     * 使用 ws 模式发请求，请求结果会送到onmessage方法上
     * @param name api名称
     * @param args 参数
     * @param echo 回调标识
     */
    static sendRaw(
        name: string,
        args: { [key: string]: any },
        echo: string = name,
    ) {
        const actionData: BotActionElem = {
            action: name,
            params: args,
            echo: echo,
        }
        const json = JSON.stringify(actionData)
        // 发送
        if(!backend.isWeb()) {
            backend.call('Onebot', 'onebot:send', false, json)
        } else if (websocket) {
            websocket.send(json)
        }

        if (Option.get('log_level') === 'debug') {
            logger.add(LogType.DEBUG, 'PUT：', JSON.parse(json))
        } else {
            logger.add(LogType.WS, 'PUT：', JSON.parse(json))
        }
    }
    static sendRawJson(str: string) {
        const json = JSON.parse(str)
        this.sendRaw(
            json.action,
            json.params,
            json.echo,
        )
    }
}

export const login: LoginCacheElem = reactive({
    quickLogin: [],
    status: false,
    address: '',
    token: '',
    creating: false,
    connectionHistory: [],
})

/**
 * 加载连接历史
 */
export function loadConnectionHistory(): ConnectionHistoryItem[] {
    const historyStr = Option.get('connection_history')
    if (historyStr && typeof historyStr === 'string') {
        try {
            const history = JSON.parse(historyStr)
            if (Array.isArray(history)) {
                return normalizeConnectionHistory(history)
            }
        } catch (e) {
            logger.error(e as Error, '加载连接历史失败')
        }
    }
    // 如果是数组直接返回（Option.get 已经解析过）
    if (Array.isArray(historyStr)) {
        return normalizeConnectionHistory(historyStr)
    }
    // 返回空数组作为默认值
    return []
}

/**
 * 保存连接历史
 */
function saveConnectionHistory(history: ConnectionHistoryItem[]) {
    Option.save('connection_history', JSON.stringify(history))
}

/**
 * 保存当前连接到历史
 */
export function saveConnectionToHistory(address: string, token: string, uin?: string, nickname?: string) {
    const settingsStore = useSettingsStore()
    // 确保 connectionHistory 已初始化
    if (!login.connectionHistory) {
        login.connectionHistory = []
    }
    const history = login.connectionHistory

    // 查找是否已存在（只根据 address 匹配）
    const existingIndex = history.findIndex(item =>
        item.address === address
    )

    const newItem: ConnectionHistoryItem = {
        address,
        token: (settingsStore.sysConfig.save_password &&
            settingsStore.sysConfig.save_password != '') ? token : '',
        uin,
        nickname,
        lastConnected: Date.now()
    }

    if (existingIndex !== -1) {
        // 更新已存在的记录（信息按最新的为准）
        history[existingIndex] = newItem
    } else {
        // 添加新记录
        history.unshift(newItem)
        // 保持最多 10 条历史记录
        if (history.length > 10) {
            history.pop()
        }
    }

    saveConnectionHistory(history)
}

/**
 * 从历史中加载连接信息
 */
export function loadConnectionFromHistory(item: ConnectionHistoryItem) {
    login.address = item.address
    login.token = item.token
}

/**
 * 删除历史记录
 */
export function deleteConnectionHistory(index: number) {
    if (!login.connectionHistory) {
        return
    }
    const history = login.connectionHistory
    if (index >= 0 && index < history.length) {
        history.splice(index, 1)
        saveConnectionHistory(history)
    }
}
