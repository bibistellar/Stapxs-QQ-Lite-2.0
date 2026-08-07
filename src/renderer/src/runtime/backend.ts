import type { InvokeArgs, InvokeOptions } from '@tauri-apps/api/core'
import { i18n } from '../main'
import { Logger, LogType, PopInfo, PopType } from '../function/base'

const logger = new Logger()
const popInfo = new PopInfo()

type TauriInvoke = <T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<T>
type TauriListener = (event: string, callback: (...args: any[]) => void) => Promise<() => void>

/** Tauri-only runtime bridge shared by the renderer modules. */
export const backend = {
    type: 'tauri' as const,
    platform: undefined as 'win32' | 'darwin' | 'linux' | undefined,
    release: '',
    arch: '' as string | undefined,
    proxy: undefined as number | undefined,
    function: undefined as { invoke: TauriInvoke } | undefined,
    listener: undefined as TauriListener | undefined,
    unlisteners: new Map<string, Map<(...args: any[]) => void, () => void>>(),

    isDesktop() {
        return true
    },

    proxyUrl(url: string) {
        if (this.proxy && url && url.startsWith('http')) {
            return `http://localhost:${this.proxy}/proxy?url=${encodeURIComponent(url)}`
        }
        return url
    },

    async proxyImageUrl(url: string) {
        return this.proxyUrl(url)
    },

    unProxyUrl(url: string) {
        if (this.proxy && url && url.startsWith('http://localhost')) {
            const urlObj = new URL(url)
            if (urlObj.pathname === '/proxy') {
                const realUrl = urlObj.searchParams.get('url')
                if (realUrl) return decodeURIComponent(realUrl)
            }
        }
        return url
    },

    async init() {
        const $t = i18n.global.t
        if (window.__TAURI_INTERNALS__ === undefined) {
            throw new Error('Stapxs QQ Lite 2.0 must run inside the Tauri desktop shell')
        }

        this.function = { invoke: (await import('@tauri-apps/api/core')).invoke }
        this.listener = (await import('@tauri-apps/api/event')).listen
        this.platform = await this.call(undefined, 'sys:getPlatform', true)
        const releaseData = await this.call(undefined, 'sys:getRelease', true)
        this.release = releaseData?.release || ''
        this.arch = releaseData?.arch || undefined
        this.proxy = await this.call(undefined, 'sys:runProxy', true)

        if (!this.proxy) {
            logger.error(null, 'Tauri 代理服务似乎没有正常启动，此服务异常将会影响应用内的大部分外部资源的加载。')
            popInfo.add(PopType.ERR, $t('Tauri 代理服务似乎没有正常启动'), false)
        }
    },

    /**
     * Invoke a Tauri command. Command names retain the renderer's historic
     * colon/camelCase format and are normalized here for Rust commands.
     */
    async call(_type: string | undefined, name: string, _needBack: boolean, ...args: any[]) {
        if (!this.function) return undefined
        const command = name.replaceAll(':', '_').replace(/([A-Z])/g, '_$1').toLowerCase()
        if (args.length === 0 || Object.prototype.toString.call(args[0]) !== '[object Object]') {
            args = [{ data: args[0] }]
        }

        try {
            return await this.function.invoke(command, args[0])
        } catch (ex) {
            logger.add(LogType.DEBUG, `调用 Tauri 命令 ${command} 失败`, ex)
            return undefined
        }
    },

    addListener(_type: string | undefined, name: string, callBack: (...args: any[]) => void) {
        if (!this.listener) {
            logger.error(null, `添加 Tauri 事件监听失败：${name}`)
            return
        }

        const listener = (event: any) => callBack(event, event?.payload)
        void this.listener(name, listener).then((unlisten) => {
            const listeners = this.unlisteners.get(name) ?? new Map()
            listeners.set(callBack, unlisten)
            this.unlisteners.set(name, listeners)
        })
    },

    removeListener(_type: string | undefined, name: string, callBack: (...args: any[]) => void) {
        const listeners = this.unlisteners.get(name)
        listeners?.get(callBack)?.()
        listeners?.delete(callBack)
        if (listeners?.size === 0) this.unlisteners.delete(name)
    },
}
