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
    private pendingConnection: { url: string, token: string } | undefined

    constructor(win: BrowserWindow) {
        this.logger.level = logLevel
        this.win = win
        // 初始化 ipc
        ipcMain.on('onebot:send', (_, json) => {
            this.websocket?.send(json)
        })
        ipcMain.on('onebot:close', () => {
            this.pendingConnection = undefined
            this.websocket?.close(1000)
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
        const parsedUrl = new URL(url)
        const connection = { url: parsedUrl.toString(), token }

        if (this.websocket) {
            // close 是异步的，不能在 socket 仍存在时递归 connect，否则会栈溢出。
            // 只保留最新目标，待旧连接 close 后再创建。
            this.pendingConnection = connection
            this.websocket.close(1000)
            return
        }

        this.open(connection)
    }

    private open(connection: { url: string, token: string }) {
        const { url, token } = connection
        this.logger.info('正在连接到：', new URL(url).origin)
        const socketUrl = new URL(url)
        socketUrl.searchParams.set('access_token', token)
        const socket = new WebSocket(socketUrl)
        this.websocket = socket

        socket.onopen = () => {
            if (this.websocket !== socket) return
            this.logger.info('已成功连接到', new URL(url).origin)
            this.win.webContents.send('onebot:onopen', {
                address: url,
                token,
            })
        }
        socket.onmessage = (e) => {
            if (this.websocket !== socket) return
            this.win.webContents.send('onebot:onmessage', e.data)
        }
        socket.onclose = (e) => {
            if (this.websocket !== socket) return
            this.websocket = undefined

            this.logger.info('连接已关闭，代码：', e.code)
            if (this.pendingConnection) {
                const pending = this.pendingConnection
                this.pendingConnection = undefined
                this.open(pending)
                return
            }

            this.win.webContents.send('onebot:onclose', {
                code: e.code,
                message: e.reason,
                address: url,
                token,
            })
        }
        socket.onerror = (e) => {
            this.logger.error('连接错误：', e)
        }
    }
}
