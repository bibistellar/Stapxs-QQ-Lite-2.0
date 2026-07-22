/**
 * 后端和前端的简易通信器，封装一些常用的交互
 */

import WebSocket from 'ws'
import log4js from 'log4js'
import { BrowserWindow, ipcMain } from 'electron'
import { logLevel } from '../index.ts'

export class Connector {
    private logger = log4js.getLogger('connector')

    private win: BrowserWindow
    private websocket: WebSocket | undefined
    private connectionOpened = false

    constructor(win: BrowserWindow) {
        this.logger.level = logLevel
        this.win = win
        // 初始化 ipc
        ipcMain.on('onebot:send', (_, json) => {
            this.websocket?.send(json)
        })
        ipcMain.on('onebot:close', () => {
            this.websocket?.close(1000)
            this.websocket = undefined
        })
        this.logger.info('后端连接器已初始化')
    }

    connect(url: string, token: string) {
        // PS：http(s) 地址要转换而不是拼接，否则会得到 wss://http://... 这种非法地址
        if (url.startsWith('https://')) {
            url = 'wss://' + url.slice('https://'.length)
        } else if (url.startsWith('http://')) {
            url = 'ws://' + url.slice('http://'.length)
        } else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
            url = 'wss://' + url
        }
        // 确保 URL 包含路径部分，避免部分服务器因 HTTP 请求路径为空而返回 400
        const withoutProtocol = url.replace(/^wss?:\/\//, '')
        if (!withoutProtocol.includes('/')) {
            url = url + '/'
        }

        if (!this.websocket) {
            this.logger.info('正在连接到：', url)
            this.websocket = new WebSocket(`${url}?access_token=${encodeURIComponent(token)}`)
        } else {
            // 如果前端发起了连接请求，说明前端在未连接状态；断开已有连接，重新连接
            // PS：这种情况一般不会发生，大部分情况是因为 debug 模式前端热重载导致的
            this.websocket.close(1000)
            this.connect(url, token)
        }

        this.websocket.onopen = () => {
            this.connectionOpened = true
            this.logger.info('已成功连接到', url)
            this.win.webContents.send('onebot:onopen', {
                address: url,
                token: token,
            })
        }
        this.websocket.onmessage = (e) => {
            this.win.webContents.send('onebot:onmessage', e.data)
        }
        this.websocket.onclose = (e) => {
            this.websocket = undefined

            this.logger.info('连接已关闭，代码：', e.code)
            let retryUrl = url
            // 仅首次握手失败时尝试另一种协议；已经成功过的连接掉线后保持原协议，
            // 避免把正常的 wss 连接意外降级成 ws。
            if (!this.connectionOpened && e.code === 1006) {
                retryUrl = url.startsWith('wss://')
                    ? 'ws://' + url.slice('wss://'.length)
                    : 'wss://' + url.slice('ws://'.length)
            }
            // 重连策略统一由渲染进程管理，避免前后端同时重试形成重复连接。
            this.win.webContents.send('onebot:onclose', {
                code: e.code,
                message: e.reason,
                address: retryUrl,
                token: token,
            })
        }
        this.websocket.onerror = (e) => {
            this.websocket = undefined
            this.logger.error('连接错误：', e)
        }
    }
}
