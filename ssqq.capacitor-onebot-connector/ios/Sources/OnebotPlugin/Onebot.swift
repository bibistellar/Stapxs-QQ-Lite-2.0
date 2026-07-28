import Foundation
import Network
import os

@available(iOS 14.0, *)
@objc public class Onebot: NSObject {

    // 需要返回 type 和 data 两个字段
    var onEvent: ((String, String) -> Void)?
    var onOptionEvent: ((String, String) -> Void)?

    private var client: WebSocketClient?
    private var connectionGeneration = 0

    @objc public func connect(_ url: String) {
        let url = URL(string: url)!
        connectionGeneration += 1
        let generation = connectionGeneration
        client?.disconnect()
        let nextClient = WebSocketClient(url: url, onEvent: { [weak self] type, data in
            // 被新连接替换的旧 task 可能延迟回调，不能让它覆盖当前连接状态。
            if let self, generation == self.connectionGeneration, let onEvent = self.onEvent {
                onEvent(type, data)
            }
        })
        // 在异步 resume 前先替换引用，避免短时间内多次 connect 创建并行连接。
        self.client = nextClient

        // 使用 GCD 创建 WebSocket 连接
        DispatchQueue.global().async {
            nextClient.connect()
        }
    }

    @objc public func send(_ data: String) {
        client?.sendMessage(data)
    }

    @objc public func close() {
        client?.disconnect()
    }

    @objc public func findService() {
        DispatchQueue.global().async {
            Task {
                let lanScanner = LANScanner(onEvent: { type, data in
                if let onEvent = self.onEvent {
                    onEvent(type, data)
                }
            })
                await lanScanner.scanCurrentLAN()
            }
        }
    }

    @objc public func changeIcon(_ name: String) {
        DispatchQueue.main.async {
            let logger = Logger()
            logger.debug("更新图标名：\(name)")
            if UIApplication.shared.supportsAlternateIcons {
                UIApplication.shared.setAlternateIconName(name.isEmpty ? nil : name) { error in
                    if let error = error {
                        logger.error("更新图标失败：\(error.localizedDescription)")
                    }
                }
            }
        }
    }

    @objc public func getUsedIcon(_ send: @escaping ((String) -> Void)) {
        DispatchQueue.main.async {
            send(UIApplication.shared.alternateIconName ?? "")
        }
    }
}
