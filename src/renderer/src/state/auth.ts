import { defineStore } from 'pinia'
import { shallowReactive, ref } from 'vue'
import snowLumaMap from '@renderer/assets/pathMap/SnowLuma.yaml'

export const useAuthStore = defineStore('auth', () => {
    const loginInfo = shallowReactive<Record<string, any>>({})
    const botInfo = shallowReactive<Record<string, any>>({})
    const jsonMap = ref<any>(snowLumaMap)

    return {
        loginInfo,
        botInfo,
        jsonMap,
    }
})
