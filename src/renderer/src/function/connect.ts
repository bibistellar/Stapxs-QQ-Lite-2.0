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
import type { ConnectionAddress } from './connectionUrl'
import { resolveConnectionAddress } from './connectionUrl'

const logger = new Logger()
const popInfo = new PopInfo()

// 断线自动重连状态 =====================================================
// PS：wantConnected 表示「用户期望保持连接」。它从用户发起连接时置 true，在主动
//     断开时置 false。首次连接失败、掉线重连、唤醒/联网重连都以它为准。
let reconnectTimer: number | undefined = undefined
let reconnectAttempts = 0
let wantConnected = false
let connectionTarget: (ConnectionAddress & {
    token: string
}) | undefined = undefined
let lifecycleHooksBound = false
let lastReconnectNow = 0
let reconnectImmediatelyOnClose = false
let connectTimeoutTimer: number | undefined = undefined
let connectionAttempt = 0
// 退避上限 30s；每次失败翻倍，成功后归零
const RECONNECT_MAX_DELAY = 30000
// 唤醒/联网事件去抖，避免多个事件在同一时刻重复触发重连
const RECONNECT_NOW_DEBOUNCE = 3000
// 实测 CDN / 反代的 TLS + Upgrade 偶尔会超过 10 秒
const CONNECT_UI_TIMEOUT = 20000

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

function finishConnectionAttempt() {
    if (connectTimeoutTimer) {
        clearTimeout(connectTimeoutTimer)
        connectTimeoutTimer = undefined
    }
    login.creating = false
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
    ) {
        const { $t } = app.config.globalProperties
        let resolved: ConnectionAddress
        try {
            resolved = resolveConnectionAddress(address)
        } catch (e) {
            finishConnectionAttempt()
            const message = e instanceof Error ? e.message : $t('未知错误')
            logger.error(e as Error, '连接地址解析失败')
            popInfo.add(PopType.ERR, $t('连接失败') + ': ' + message, false)
            return
        }

        // 用户发起新的连接时重置协议回退状态。preferredAddress 始终用于输入框、
        // 自动连接和历史记录；transportAddress 只描述当前 socket 实际使用的地址。
        connectionTarget = {
            ...resolved,
            token: token ?? '',
        }
        login.address = resolved.preferredAddress
        login.token = token ?? ''
        // 从用户点击连接开始就持续维护目标。这样首次连接时恰好断网，也会在网络
        // 恢复后继续重试，而不是必须成功握手一次才进入自动重连状态。
        wantConnected = true
        reconnectAttempts = 0
        this.openCurrentTarget()
    }

    private static openCurrentTarget() {
        if (!connectionTarget) return

        const address = connectionTarget.transportAddress
        const token = connectionTarget.token
        const attempt = ++connectionAttempt

        login.creating = true
        if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer)
        connectTimeoutTimer = window.setTimeout(() => {
            if (attempt === connectionAttempt && login.creating) {
                login.creating = false
                logger.add(LogType.WS, `连接握手超过 ${CONNECT_UI_TIMEOUT / 1000}s，继续等待底层结果`)
            }
        }, CONNECT_UI_TIMEOUT)

        logger.add(LogType.WS, '当前处于 ALL 日志模式。连接器将输出全部收发消息 ……')
        logger.add(LogType.WS, `正在连接到：${address}`)

        logger.add(LogType.WS, '使用 Tauri 后端连接模式')
        backend.call(undefined, 'onebot:connect', false, { address, token })
    }

    // 连接事件 =====================================================

    static onopen(_address: string, token: string | undefined) {
        const settingsStore = useSettingsStore()
        finishConnectionAttempt()
        logger.add(LogType.WS, '连接成功')
        // 握手成功：进入「期望保持连接」状态，清空重连退避
        wantConnected = true
        reconnectAttempts = 0
        if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = undefined
        }
        // 保存登录信息
        // 后端回传的是实际 transport 地址；持久化时仍使用用户首选地址，
        // 避免一次自动 ws 回退覆盖显式/无协议输入。
        Option.save('address', login.address)
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
        let data: any
        try {
            data = JSON.parse(message)
        } catch (e) {
            logger.error(e as Error, '收到无法解析的 WebSocket 消息')
            return
        }
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
        _address?: string,
        _token?: string,
    ) {
        const { $t } = app.config.globalProperties
        const connectionStore = useConnectionStore()

        if (connectionStore.metaEventWatchTimer) {
            clearTimeout(connectionStore.metaEventWatchTimer)
            connectionStore.metaEventWatchTimer = undefined
        }
        connectionStore.metaEventTimeoutTriggered = false
        connectionStore.heartbeatTime = -1
        connectionStore.oldHeartbeatTime = -1
        connectionStore.lastHeartbeatTime = -1
        connectionStore.backendOnline = undefined
        connectionStore.backendGood = undefined
        finishConnectionAttempt()
        login.status = false
        login.localReady = Boolean(useAuthStore().loginInfo?.uin)
        updateMenu({ parent: 'account', id: 'logout', action: 'visible', value: 'false' })
        updateMenu({ parent: 'account', id: 'userName', action: 'label', value: $t('连接') })

        const reconnectImmediately = reconnectImmediatelyOnClose
        reconnectImmediatelyOnClose = false

        switch (Number(code)) {
            case 1000:
                if (wantConnected) {
                    logger.add(LogType.WS, '连接被远端关闭，准备自动重连')
                    this.scheduleReconnect(reconnectImmediately)
                } else {
                    popInfo.add(PopType.INFO, $t('连接已断开') + (msg ? (': ' + msg.replace(':', ' - ')) : ''), false)
                }
                break // 正常关闭
            case -1:
            case 1006: {
                // 非正常关闭，尝试重连
                if (wantConnected) {
                    // 曾经连上过：说明是掉线（网络波动 / 服务端重启 / 睡眠唤醒），
                    // 按退避节奏无限重连，不再需要用户手动重新登录
                    popInfo.add(PopType.ERR, $t('连接失败') + ': ' + $t('连接异常关闭'), false)
                    this.scheduleReconnect(reconnectImmediately)
                } else {
                    popInfo.add(PopType.ERR, $t('连接失败') + ': ' + $t('连接异常关闭'), false)
                }
                break
            }
            case 1015: {
                // TLS 错误
                if (wantConnected) {
                    popInfo.add(PopType.ERR, $t('连接失败') + ': ' + $t('TLS错误'), false)
                    this.scheduleReconnect(reconnectImmediately)
                } else {
                    popInfo.add(PopType.ERR, $t('连接失败') + ': ' + $t('TLS错误'), false)
                }
                break
            }
            default: {
                popInfo.add(PopType.ERR, $t('连接失败') + ': ' + $t('未知的错误 {code}',{ code: code }), false)
                if (wantConnected) this.scheduleReconnect(reconnectImmediately)
            }
        }

        logger.error(null, $t('连接失败') + ': ' + code)
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
        connectionStore.backendOnline = undefined
        connectionStore.backendGood = undefined
        finishConnectionAttempt()
        // 用户主动断开：停止自动重连
        wantConnected = false
        connectionTarget = undefined
        reconnectImmediatelyOnClose = false
        reconnectAttempts = 0
        if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = undefined
        }

        backend.call(undefined, 'onebot:close', false)
    }

    static forceDisconnect(reason: string) {
        const connectionStore = useConnectionStore()
        if (connectionStore.metaEventWatchTimer) {
            clearTimeout(connectionStore.metaEventWatchTimer)
            connectionStore.metaEventWatchTimer = undefined
        }
        // 心跳 watchdog 和 online 事件可能同时发现同一条坏链路。
        // 一次关闭尚未回调前只允许发出一个 close，避免重复 onclose 干扰新连接。
        if (connectionStore.metaEventTimeoutTriggered) return
        connectionStore.metaEventTimeoutTriggered = true
        logger.add(LogType.WS, `主动重置连接：${reason}`)
        // 本地主动判定链路失效后无需再退避；close 回调到达时立即建立新连接。
        reconnectImmediatelyOnClose = true

        // 关闭事件会回到 onclose 并进入统一重连流程。
        backend.call(undefined, 'onebot:close', false)
    }

    /**
     * 掉线后按指数退避排期重连（1s、2s、4s…，上限 30s，成功后归零）。
     * 所有平台只由这一层调度，避免原生连接器与渲染层重复重连。
     */
    static scheduleReconnect(immediate = false) {
        if (!wantConnected || !connectionTarget) return
        if (reconnectTimer) {
            if (!immediate) return
            clearTimeout(reconnectTimer)
            reconnectTimer = undefined
        }
        const delay = immediate ? 0 : Math.min(
            RECONNECT_MAX_DELAY,
            1000 * Math.pow(2, reconnectAttempts),
        )
        if (!immediate) reconnectAttempts++
        logger.add(
            LogType.WS,
            immediate? '检测到连接已失效，立即重新连接 ……': `连接断开，将在 ${delay / 1000}s 后进行第 ${reconnectAttempts} 次重连 ……`,
        )
        reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined
            if (!wantConnected || login.status || login.creating) return
            this.openCurrentTarget()
        }, delay)
    }

    /**
     * 立即重连（网络恢复 / 窗口唤醒时调用）
     * PS：睡眠唤醒后 socket 往往已经静默失效，但不会立刻触发 onclose；此时若还「期望
     *     保持连接」且当前未连接，就重置退避立即重连，无需等待下一次退避 tick。
     */
    static reconnectNow(recycleConnected = false) {
        if (!wantConnected || !connectionTarget) return
        if (login.status) {
            if (recycleConnected) {
                // online 事件意味着网络栈刚恢复。旧 socket 即使仍显示在线也很可能
                // 已经半开，直接回收后重建比等待心跳超时更快、更确定。
                this.forceDisconnect('网络恢复后刷新连接')
            }
            return
        }
        if (login.creating) return
        const now = Date.now()
        if (now - lastReconnectNow < RECONNECT_NOW_DEBOUNCE) return
        lastReconnectNow = now
        if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = undefined
        }
        reconnectAttempts = 0
        logger.add(LogType.WS, '检测到网络恢复 / 窗口唤醒，立即尝试重连 ……')
        this.openCurrentTarget()
    }

    /**
     * 注册网络/窗口生命周期钩子，用于睡眠唤醒、断网恢复后自动重连（只注册一次）
     */
    static registerLifecycleHooks() {
        if (lifecycleHooksBound) return
        lifecycleHooksBound = true
        window.addEventListener('online', () => this.reconnectNow(true))
        window.addEventListener('focus', () => this.reconnectNow())
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
        this.sendRaw(apiMap.name, args, echo)

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
        this.sendRaw(name, value, echo)
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
        backend.call(undefined, 'onebot:send', false, json)

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
    localReady: false,
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
