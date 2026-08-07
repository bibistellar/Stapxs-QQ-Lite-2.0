const HEARTBEAT_TIMEOUT_FACTOR = 2.5
const HEARTBEAT_TIMEOUT_MIN = 15000
const HEARTBEAT_TIMEOUT_MAX = 5 * 60 * 1000

export function isOneBotHeartbeat(message: { [key: string]: any }) {
    return message.post_type === 'meta_event' &&
        message.meta_event_type === 'heartbeat'
}

export function parseHeartbeatStatus(status: unknown) {
    if (typeof status !== 'object' || status === null) {
        return {} as { online?: boolean, good?: boolean }
    }

    const value = status as { online?: unknown, good?: unknown }
    return {
        online: typeof value.online === 'boolean' ? value.online : undefined,
        good: typeof value.good === 'boolean' ? value.good : undefined,
    }
}

export function getHeartbeatIntervalSeconds(
    reportedInterval: unknown,
    lastReceivedAt: number,
    now: number,
) {
    const reported = Number(reportedInterval)
    if (Number.isFinite(reported) && reported > 0) return reported / 1000
    if (lastReceivedAt > 0 && now > lastReceivedAt) {
        return Math.max(1, Math.round((now - lastReceivedAt) / 1000))
    }
    return undefined
}

export function getHeartbeatTimeoutMs(intervalSeconds: number) {
    return Math.min(
        HEARTBEAT_TIMEOUT_MAX,
        Math.max(
            HEARTBEAT_TIMEOUT_MIN,
            Math.ceil(intervalSeconds * HEARTBEAT_TIMEOUT_FACTOR * 1000),
        ),
    )
}
