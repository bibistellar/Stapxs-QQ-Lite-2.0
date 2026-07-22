import { ChatInfoElem, MergeStackData } from '@renderer/function/elements/information'
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

export const useChatStore = defineStore('chat', () => {
    const chatInfo = ref<ChatInfoElem>({
        show: { type: '', id: 0, name: '', avatar: '' },
        info: {
            group_info: {},
            user_info: {},
            me_info: {},
            group_members: [],
            group_files: {},
            group_sub_files: {},
            jin_info: {
                list: [],
                pages: 0,
            },
        },
    })

    const messageList = ref<any[]>([])
    // 登录后预取的最近会话历史；打开会话时可先即时展示，再由网络请求校准。
    const recentHistoryCache = reactive(new Map<number, any[]>())
    const mergeMsgStack = ref<MergeStackData[]>([])
    const mergeMessageList = ref<any[] | undefined>(undefined)
    const mergeMessageImgList = ref<any[] | undefined>(undefined)

    return {
        chatInfo,
        messageList,
        recentHistoryCache,
        mergeMsgStack,
        mergeMessageList,
        mergeMessageImgList,
    }
})
