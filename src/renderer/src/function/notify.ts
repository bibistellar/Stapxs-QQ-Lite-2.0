import app from '@renderer/main'
import { NotifyInfo } from './elements/system'
import { backend } from '@renderer/runtime/backend'

export class Notify {
    private static userNotifyList: { [key: string]: number } = {}

    public notify(info: NotifyInfo) {
        const { $t } = app.config.globalProperties
        const userId = info.tag.split('/')[0]
        if (Notify.userNotifyList[userId] === undefined) {
            Notify.userNotifyList[userId] = 1
        } else {
            Notify.userNotifyList[userId]++
            info.body = $t('“{body}” 以及 {num} 条消息', {
                body: info.body,
                num: Notify.userNotifyList[userId] - 1,
            })
            this.closeAll(userId)
        }
        backend.call(undefined, 'sys:sendNotice', false, { data: info })
    }

    public notifySingle(info: NotifyInfo) {
        backend.call(undefined, 'sys:sendNotice', false, { data: info })
    }

    public closeAll(userId: string) {
        backend.call(undefined, 'sys:closeAllNotice', false, String(userId))
        delete Notify.userNotifyList[userId]
    }

    public clear() {
        backend.call(undefined, 'sys:clearNotice', false)
    }
}
