# SnowLuma API 接入参考

本文记录 Stapxs QQ Lite 对接 SnowLuma 时已经确认可用的 OneBot API、连接行为、
消息历史语义和已知限制，供后续实现连接恢复与近期消息补拉时查阅。

## 调研基线

- 调研日期：2026-08-07
- SnowLuma 官方仓库：<https://github.com/SnowLuma/SnowLuma>
- 核对版本：`main` 分支提交
  [`ebbe90be7ea52432fb822d401a07882cfc4d9f47`](https://github.com/SnowLuma/SnowLuma/commit/ebbe90be7ea52432fb822d401a07882cfc4d9f47)
- 官方文档：<https://snowluma.github.io/>
- SDK 文档：<https://snowluma.github.io/sdk/>

SnowLuma 的 API 可能继续演进。实现兼容逻辑时应先调用 `get_version_info`，并避免
假设所有历史版本都支持本文记录的扩展参数。

## 连接端点和鉴权

SnowLuma 默认暴露以下 OneBot 端点：

| 传输 | 默认地址 | 用途 |
| --- | --- | --- |
| HTTP | `http://127.0.0.1:3000/` | 请求/响应 |
| WebSocket | `ws://127.0.0.1:3001/` | 请求/响应与实时事件 |

WebSocket 连接可以使用查询参数鉴权：

```text
ws://127.0.0.1:3001/?access_token=<token>
```

SnowLuma 的 WebSocket 角色有 `Api`、`Event` 和 `Universal`；Stapxs QQ Lite 需要
同时调用 API 和接收事件，应连接 `Universal` 角色的端点。默认服务端配置就是
`Universal`。

配置说明：
<https://snowluma.github.io/guide/configuration.html>

## WebSocket 与 OneBot 心跳

SnowLuma 有两层不同含义的心跳，客户端不应混淆。

### WebSocket 传输层 Ping/Pong

- SnowLuma 每 30 秒向客户端发送 WebSocket Ping。
- 连续两次 Ping 没有得到有效回应后，约 90 秒总静默时间会终止半开连接。
- 任意入站 WebSocket 帧都会刷新 SnowLuma 的连接存活计数。
- Stapxs QQ Lite 不再额外定时发送 Ping；SnowLuma 发起 Ping，底层 WebSocket
  协议栈自动回复 Pong。这一层只负责传输层半开连接清理。

官方实现：
[`ws-server-connections.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/network/ws-server-connections.ts#L20-L30)

### OneBot 心跳元事件

SnowLuma 每 30 秒发送一次 OneBot 心跳事件，并且在新的事件 WebSocket 建立后立即
发送 `connect`、`enable` 和一帧心跳。

```json
{
  "time": 1786032000,
  "self_id": 10000,
  "post_type": "meta_event",
  "meta_event_type": "heartbeat",
  "status": {
    "online": true,
    "good": true
  },
  "interval": 30000
}
```

字段含义：

- `online`：QQ 账号是否在线。
- `good`：QQ 接收链路是否健康，不只是 WebSocket 是否连通。
- `interval`：下一次 OneBot 心跳间隔，单位毫秒。

官方实现：
[`instance.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/instance.ts#L608-L640)

## 通用请求与响应

WebSocket 请求格式：

```json
{
  "action": "get_status",
  "params": {},
  "echo": "request-id"
}
```

典型响应格式：

```json
{
  "status": "ok",
  "retcode": 0,
  "data": {},
  "echo": "request-id"
}
```

客户端应同时校验 `status` 和 `retcode`，不能只以收到相同 `echo` 的响应作为业务
成功。没有 `echo` 的包通常是实时事件。

## 连接与状态 API

### `get_version_info`

用于识别后端实现和版本。

```json
{
  "action": "get_version_info",
  "params": {},
  "echo": "version"
}
```

SnowLuma 返回的关键字段：

```json
{
  "app_name": "SnowLuma",
  "app_version": "<version>-node",
  "protocol_version": "v11"
}
```

### `get_login_info`

获取当前账号：

```json
{
  "action": "get_login_info",
  "params": {},
  "echo": "login"
}
```

`data` 包含：

- `user_id`
- `nickname`

### `get_status`

```json
{
  "action": "get_status",
  "params": {},
  "echo": "health"
}
```

`data` 包含：

```json
{
  "online": true,
  "good": true
}
```

建议用途：

- 收到有效响应：SnowLuma WebSocket API 通道可用。
- `online === true && good === true`：可以开始消息补拉。
- `online === false`：账号离线，不应把连接标记为消息同步就绪。
- `good === false`：SnowLuma 到 QQ 的接收链路异常；重新建立客户端 WebSocket
  不一定能修复，应保留“后端可达但 QQ 链路异常”的独立状态。

官方实现：
[`info.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/actions/info.ts#L28-L45)

## 联系人 API

以下标准接口可用于刷新花名册：

- `get_friend_list`
- `get_group_list`

它们不提供一个可靠的“断线期间有新消息的会话”集合，因此不能代替最近会话接口。

### `get_recent_contact` 当前不可用

SnowLuma 虽然注册了 `get_recent_contact`，但当前只是兼容占位：接受 `count` 参数，
始终返回空数组。

官方实现：
[`extended.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/actions/extended.ts#L1374-L1391)

因此 Stapxs QQ Lite 应以本地 SQLite 的最近会话为主。若客户端从未见过某个新会话，
当前公开 OneBot API 没有低成本、可靠的发现方式；只能进行低优先级联系人探测，或
等待 SnowLuma 将该占位接口实现为真实最近会话列表。

## 消息历史 API

这是后续“重连只补近期消息、上拉再取旧消息”的主要基础。

### `get_group_msg_history`

请求参数：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `group_id` | integer | 必填 | 群号 |
| `message_id` | signed integer | `0` | 锚点消息 ID；可能为负数 |
| `count` | integer | `20` | 请求条数，SnowLuma 最大规范化为 200 |
| `reverse_order` | boolean | `true` | 有锚点时决定向旧消息还是新消息方向读取 |

向上翻历史：

```json
{
  "action": "get_group_msg_history",
  "params": {
    "group_id": 123456,
    "message_id": -123456789,
    "count": 20,
    "reverse_order": true
  },
  "echo": "group-history-older"
}
```

重连后向前补消息：

```json
{
  "action": "get_group_msg_history",
  "params": {
    "group_id": 123456,
    "message_id": -123456789,
    "count": 50,
    "reverse_order": false
  },
  "echo": "group-history-newer"
}
```

### `get_friend_msg_history`

请求参数与群历史基本一致，以 `user_id` 指定好友：

```json
{
  "action": "get_friend_msg_history",
  "params": {
    "user_id": 123456,
    "message_id": -987654321,
    "count": 50,
    "reverse_order": false
  },
  "echo": "friend-history-newer"
}
```

好友历史在 `message_id: 0` 时会通过 QQ 漫游接口获取最新双向消息。服务器或身份解析
失败时，SnowLuma 会让 action 失败，不会把不完整的本地缓存伪装成成功结果。

官方 action 定义：
[`extended.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/actions/extended.ts#L476-L525)

官方历史实现：
[`message-actions.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/modules/message-actions.ts#L161-L329)

### 历史方向语义

当 `message_id !== 0` 时：

- `reverse_order: true`：返回锚点以及锚点之前的更旧消息。
- `reverse_order: false`：返回锚点以及锚点之后的更新消息。
- 结果统一按旧到新排列。
- 返回结果包含锚点，客户端必须按 `message_id` 去重。

`message_id: 0` 表示无显式锚点：

- 好友：直接通过 QQ 漫游接口获取最新双向记录。
- 群聊：SnowLuma 先寻找自己消息库中该群最新的权威序号，再向 QQ 获取历史。
- 如果 SnowLuma 从未观察或保存过某个群的权威序号，无锚点群历史可能返回空结果。

### `message_id` 注意事项

- SnowLuma 的 `message_id` 是有符号 int32 哈希，负值完全有效。
- 它是 opaque ID，不能比较大小，也不能用 `+1` 推导下一条消息。
- 本地 SQLite 当前把 `message_id` 保存为字符串；调用 SnowLuma 前应转换为安全整数。
- 锚点必须存在于 SnowLuma 的消息存储并具有可用的权威序号，否则显式锚点请求可能
  退回本地结果或返回空数组。
- SnowLuma 从 QQ 拉到的历史会写入自己的消息库，后续可以继续用返回的
  `message_id` 翻页。

### `message_seq` 注意事项

- 群消息的 `message_seq` 可以用于排序和辅助发现序号缺口。
- 私聊消息存在发送方本地序号与会话服务端序号的区别，不应仅靠公开的
  `message_seq` 做跨方向严格缺口判断。
- 私聊补拉应以 `message_id` 锚点、时间排序和 ID 去重为主。

### SnowLuma 内部历史限制

当前实现包括以下保护：

- 单次 action 最多返回 200 条消息。
- 单个历史 action 内部最多执行 12 个协议窗口请求。
- QQ 历史协议请求共用限速门，发送间隔至少 300ms。
- 后续窗口请求失败时，action 可能整体失败，而不是返回看似完整的部分结果。

客户端仍应限制会话并发，不应同时向大量群和好友请求 200 条历史。

## 其他消息 API

### `get_msg`

按 SnowLuma `message_id` 获取已知消息。历史接口拉到的消息会被 SnowLuma 保存，因而
后续可以被 `get_msg`、回复和部分消息操作引用。

### 标记已读

SnowLuma 提供：

- `mark_group_msg_as_read`
- `mark_private_msg_as_read`
- `mark_msg_as_read`
- `_mark_all_as_read`

加载历史本身不等于标记已读。客户端应只在用户实际阅读会话时调用已读接口，避免
断线补拉改变 QQ 的已读状态。

## SnowLuma 后端登录历史补齐

SnowLuma WebUI 可以为账号开启登录历史补齐，但该能力只能作为辅助：

- 默认关闭，下一次登录或重启后生效。
- 只把 QQ 云端漫游消息写入 SnowLuma 自己的消息库。
- 不重放 OneBot 消息事件。
- 不改变 QQ 已读状态。
- 花名册预热后等待 30 秒才执行。
- 最多扫描 100 个群和 100 位好友。
- 每类最多选择 3 个会话，每个会话最多读取 20 条。
- 自动请求间隔至少 2 秒，本次失败后不重试。

官方说明：
<https://github.com/SnowLuma/SnowLuma#可选登录时补齐云端历史>

这项设置适合提高 SnowLuma 自身曾经离线后的历史覆盖率，但不能替代客户端重连后的
主动近期补拉。

## 没有提供的同步能力

当前公开 OneBot action 中没有以下 Telegram 风格能力：

- 全局事件游标或 `update_id`
- `get_updates_since(cursor)`
- 可持久化的每账号同步状态
- 断线期间 OneBot 事件重放
- 可用的最近会话或未读会话枚举

因此客户端只能进行有界、尽力而为的消息补拉，无法仅依赖当前 SnowLuma API 做严格
的全事件同步。撤回、通知、好友请求等非历史消息事件也不能通过消息历史接口完整恢复。

## Stapxs QQ Lite 推荐同步策略

### 重连后的近期补拉

1. WebSocket 建立并完成 `get_login_info`。
2. 从最近一帧 OneBot 心跳读取 `status.online` 和 `status.good`；必要时只调用一次
   `get_status` 确认后端就绪，不把它用于周期保活。
3. 从本地 SQLite 读取最近活跃会话和每个会话的最新 `message_id`。
4. 当前打开会话、置顶会话优先，其余按本地活跃时间排序。
5. 使用最新本地锚点和 `reverse_order: false` 请求更新消息。
6. 每页建议 50 条，每个会话最多 2 页，即最多补 100 条。
7. 若锚点无效、响应为空或 action 失败，回退到 `message_id: 0, count: 20` 的最新快照。
8. 按 `message_id` 去重、按时间与可用序号排序后写入 SQLite。

推荐的初始资源限制：

- 最近会话上限：30
- 每页消息数：50
- 每会话页数上限：2
- 客户端并发：1
- 会话请求间隔：350–500ms

### 向上翻阅旧消息

1. 优先从本地 SQLite 读取更旧消息。
2. 本地不足一页时，取当前最旧的 SnowLuma 消息 ID 作为锚点。
3. 调用对应历史接口：`count: 20, reverse_order: true`。
4. 删除接口返回中重复的锚点，将剩余消息插入列表顶部并写入 SQLite。
5. 返回空数组或没有新 ID 时，标记当前远程方向已经没有更多历史。

## 当前项目兼容注意事项

当前 SnowLuma 映射文件：
[`src/renderer/src/assets/pathMap/SnowLuma.yaml`](../src/renderer/src/assets/pathMap/SnowLuma.yaml)

后续实现前需要注意：

- SnowLuma 映射当前重定向到 `Lagrange.OneBot`。
- 继承的消息映射没有把 SnowLuma 的 `message_seq` 保存为本地 `seq_id`。
- 当前启动补拉主要使用 `message_id: 0`，没有使用 `reverse_order: false` 从本地最新
  锚点向前补消息。
- 客户端只使用 OneBot 心跳 watchdog 判活：每帧心跳刷新超时计时，并记录
  `status.online/good`；不再叠加 Rust 主动 Ping 或周期 `get_status` 探针。
- `get_recent_contact` 恒空时，项目当前存在大范围联系人探测逻辑；SnowLuma 下应改为
  SQLite 最近会话优先，联系人探测仅作为限量、低优先级兜底。
- 历史接口返回锚点，客户端合并逻辑必须始终按字符串化的 `message_id` 去重。

## 官方源码索引

| 内容 | 官方源码 |
| --- | --- |
| 历史 action 参数 | [`actions/extended.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/actions/extended.ts#L476-L525) |
| 历史获取与持久化 | [`modules/message-actions.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/modules/message-actions.ts#L161-L329) |
| WebSocket Ping/Pong | [`network/ws-server-connections.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/network/ws-server-connections.ts#L20-L30) |
| OneBot 心跳事件 | [`instance.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/instance.ts#L608-L640) |
| `get_status` / 版本信息 | [`actions/info.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/actions/info.ts#L28-L65) |
| `get_recent_contact` 占位 | [`actions/extended.ts`](https://github.com/SnowLuma/SnowLuma/blob/ebbe90be7ea52432fb822d401a07882cfc4d9f47/packages/onebot/src/actions/extended.ts#L1374-L1391) |
