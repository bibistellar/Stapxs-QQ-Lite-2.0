use base64::{engine::general_purpose, Engine as _};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use log::{debug, error, info};
use rand::RngCore;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

// ── 全局状态 ────────────────────────────────────────────────

/// Tauri managed state：用 Mutex 包装 SQLite 连接
pub struct DbState(pub Mutex<DbStateInner>);

pub struct DbStateInner {
    pub data_dir: PathBuf,
    pub conn: Option<Connection>,
}

impl DbState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self(Mutex::new(DbStateInner {
            data_dir,
            conn: None,
        }))
    }

    fn with_conn<T, F>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let mut inner = self.0.lock().map_err(|e| e.to_string())?;

        if inner.conn.is_none() {
            let conn = open_db(inner.data_dir.clone()).map_err(|e| e.to_string())?;
            inner.conn = Some(conn);
            info!("SQLite 数据库懒加载初始化完成");
        }

        let conn = inner
            .conn
            .as_ref()
            .ok_or_else(|| "无法获取数据库连接".to_string())?;

        f(conn)
    }
}

// ── 数据结构 ────────────────────────────────────────────────

/// 单条消息记录（前后端共用）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MsgRecord {
    /// Bot 侧的消息 ID
    pub message_id: String,
    /// 关联会话 ID（group_id 或 user_id）
    pub chat_id: i64,
    /// 会话类型："group" | "private"
    pub chat_type: String,
    /// 发送者 user_id
    pub sender_id: i64,
    /// 发送者昵称（card 优先，fallback nickname）
    pub sender_name: Option<String>,
    /// 消息序号（并非所有 Bot 都提供，可为 null）
    pub seq: Option<i64>,
    /// 消息时间戳（秒，Bot 原始值）
    pub time: i64,
    /// JSON 序列化的 MsgItemElem[] 消息段数组
    pub message: String,
    /// 纯文本摘要（getMsgRawTxt 结果）
    pub raw_message: Option<String>,
    /// 是否已撤回
    pub revoked: bool,
}

/// 尚未完成服务端确认的发件箱记录。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OutgoingRecord {
    /// 客户端生成的稳定消息 ID，用于跨重启追踪发送状态。
    pub client_id: String,
    pub chat_id: i64,
    pub chat_type: String,
    /// 群临时会话的来源群号；普通私聊和群聊为空。
    pub source_group_id: Option<i64>,
    pub sender_id: i64,
    pub sender_name: Option<String>,
    pub time: i64,
    /// JSON 序列化的 OneBot 消息段。
    pub message: String,
    /// JSON 序列化的原始发送载荷，可能是消息段数组或 CQ 字符串。
    pub payload: String,
    pub raw_message: Option<String>,
    /// pending | sending | failed | uncertain
    pub state: String,
    pub server_message_id: Option<String>,
    pub error: Option<String>,
    pub retry_count: i64,
    /// 原始回调名；文件消息等调用方会携带额外元数据。
    pub echo: String,
}

/// 备份并移走旧数据库后的结果。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbRebuildResult {
    /// 没有旧数据库文件时为空。
    pub backup_directory: Option<String>,
    pub moved_files: usize,
}

/// 获取当前平台的数据库加密密钥。
/// 若系统密码管理器不可用，回退到设备本地随机密钥文件（每台设备唯一）。
fn get_db_key(db_path: &std::path::Path) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        match crate::commands::keychain::get_or_create_db_key() {
            Ok(key) => return Ok(key),
            Err(e) => log::warn!("钥匙串读取失败，尝试本地回退密钥：{}", e),
        }
    }
    #[cfg(target_os = "windows")]
    {
        match crate::commands::keychain::get_or_create_db_key() {
            Ok(key) => return Ok(key),
            Err(e) => log::warn!("Windows 凭据管理器读取失败，尝试本地回退密钥：{}", e),
        }
    }
    #[cfg(target_os = "linux")]
    {
        match crate::commands::keychain::get_or_create_db_key() {
            Ok(key) => return Ok(key),
            Err(e) => log::warn!("Linux Secret Service 读取失败，尝试本地回退密钥：{}", e),
        }
    }

    let fallback_path = db_path.with_extension("dbkey");
    get_or_create_fallback_db_key(&fallback_path)
}

fn get_or_create_fallback_db_key(path: &std::path::Path) -> Result<String, String> {
    if let Ok(existing) = fs::read_to_string(path) {
        let key = existing.trim().to_string();
        if !key.is_empty() {
            return Ok(key);
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建密钥目录失败：{}", e))?;
    }

    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    let key: String = buf.iter().map(|b| format!("{:02x}", b)).collect();

    fs::write(path, &key).map_err(|e| format!("写入回退密钥失败：{}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }

    log::warn!(
        "系统密码管理器不可用，已写入本地设备专属回退密钥：{:?}",
        path
    );

    Ok(key)
}

// ── 初始化 ──────────────────────────────────────────────────

/// 打开（或创建）数据库，建表建索引
pub fn open_db(data_dir: PathBuf) -> rusqlite::Result<Connection> {
    std::fs::create_dir_all(&data_dir).ok();
    let db_path = data_dir.join("messages.db");

    open_encrypted_db(db_path)
}

/// 尝试以加密模式打开数据库；失败返回给调用方，由界面提供重建入口。
fn open_encrypted_db(db_path: std::path::PathBuf) -> rusqlite::Result<Connection> {
    match try_open_encrypted(&db_path) {
        Ok(conn) => Ok(conn),
        Err(e) => {
            error!("无法以加密模式打开 {:?}（{}）", db_path, e);
            Err(e)
        }
    }
}

/// 打开并执行加密初始化，返回就绪的连接
fn try_open_encrypted(db_path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;

    // 从平台密码管理器获取加密密钥（必须在任何其他操作之前执行）
    let key = get_db_key(db_path)
        .map_err(|e| rusqlite::Error::InvalidParameterName(format!("数据库密钥不可用：{}", e)))?;
    conn.execute_batch(&format!("PRAGMA key = '{}';" , key))?;

    // 验证密钥是否正确（query sqlite_master 是 SQLCipher 推荐的验证方式）
    conn.execute_batch("SELECT count(*) FROM sqlite_master;")?;

    // WAL 模式：并发读写性能更好
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            self_id     TEXT    NOT NULL,
            message_id  TEXT    NOT NULL,
            chat_id     INTEGER NOT NULL,
            chat_type   TEXT    NOT NULL,
            sender_id   INTEGER NOT NULL,
            sender_name TEXT,
            seq         INTEGER,
            time        INTEGER NOT NULL,
            message     TEXT    NOT NULL,
            raw_message TEXT,
            revoked     INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL,
            UNIQUE(self_id, message_id)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_chat
            ON messages(self_id, chat_id, time, id);
        ",
    )?;

    // 迁移：为旧数据库添加 seq 列（若列已存在则静默忽略）
    let _ = conn.execute_batch("ALTER TABLE messages ADD COLUMN seq INTEGER;");

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS outgoing_messages (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            self_id           TEXT    NOT NULL,
            client_id         TEXT    NOT NULL,
            chat_id           INTEGER NOT NULL,
            chat_type         TEXT    NOT NULL,
            source_group_id   INTEGER,
            sender_id         INTEGER NOT NULL,
            sender_name       TEXT,
            time              INTEGER NOT NULL,
            message           TEXT    NOT NULL,
            payload           TEXT    NOT NULL DEFAULT '[]',
            raw_message       TEXT,
            state             TEXT    NOT NULL DEFAULT 'pending',
            server_message_id TEXT,
            error             TEXT,
            retry_count       INTEGER NOT NULL DEFAULT 0,
            echo              TEXT    NOT NULL DEFAULT 'sendMsgBack',
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL,
            UNIQUE(self_id, client_id)
        );

        CREATE INDEX IF NOT EXISTS idx_outgoing_messages_state
            ON outgoing_messages(self_id, state, time, id);

        UPDATE outgoing_messages
           SET state = 'uncertain',
               error = COALESCE(error, '客户端在等待发送回执时退出'),
               updated_at = unixepoch('now') * 1000
         WHERE state = 'sending';
        ",
    )?;
    let _ = conn.execute_batch(
        "ALTER TABLE outgoing_messages ADD COLUMN source_group_id INTEGER;",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE outgoing_messages ADD COLUMN payload TEXT NOT NULL DEFAULT '[]';",
    );

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS images (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            self_id    TEXT    NOT NULL,
            url_hash   TEXT    NOT NULL,
            mime_type  TEXT    NOT NULL DEFAULT 'image/jpeg',
            data       BLOB    NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(self_id, url_hash)
        );
        ",
    )?;

    Ok(conn)
}

// ── 命令实现 ─────────────────────────────────────────────────

/// 批量保存消息（已存在的 message_id 使用后端返回的完整内容更新）
///
/// 返回实际写入或更新的条数。
#[tauri::command]
pub fn db_save_messages(
    state: State<DbState>,
    self_id: String,
    messages: Vec<MsgRecord>,
) -> Result<usize, String> {
    state.with_conn(|conn| {
        let now = chrono::Utc::now().timestamp_millis();
        let mut saved = 0usize;

        debug!("保存 {} 条 {} 的消息 ……", messages.len(), self_id);

        for msg in &messages {
            let n = conn
                .execute(
                    "INSERT INTO messages
                        (self_id, message_id, chat_id, chat_type,
                         sender_id, sender_name, seq, time, message,
                         raw_message, revoked, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                     ON CONFLICT(self_id, message_id) DO UPDATE SET
                         chat_id = excluded.chat_id,
                         chat_type = excluded.chat_type,
                         sender_id = excluded.sender_id,
                         sender_name = excluded.sender_name,
                         seq = COALESCE(excluded.seq, messages.seq),
                         time = excluded.time,
                         message = excluded.message,
                         raw_message = excluded.raw_message,
                         revoked = MAX(messages.revoked, excluded.revoked)",
                    params![
                        self_id,
                        msg.message_id,
                        msg.chat_id,
                        msg.chat_type,
                        msg.sender_id,
                        msg.sender_name,
                        msg.seq,
                        msg.time,
                        msg.message,
                        msg.raw_message,
                        msg.revoked as i32,
                        now,
                    ],
                )
                .map_err(|e| e.to_string())?;
            saved += n;
        }

        debug!("成功保存 {} 条消息", saved);

        Ok(saved)
    })
}

fn valid_outgoing_state(state: &str) -> bool {
    matches!(state, "pending" | "sending" | "failed" | "uncertain")
}

/// 关闭当前连接，将数据库及事务日志文件移入带时间戳的备份目录。
/// 加密密钥文件不会被移动，新数据库继续使用原有设备密钥。
#[tauri::command]
pub fn db_rebuild(state: State<DbState>) -> Result<DbRebuildResult, String> {
    let mut inner = state.0.lock().map_err(|e| e.to_string())?;

    if let Some(conn) = inner.conn.take() {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        drop(conn);
    }

    backup_database_files(&inner.data_dir)
}

fn backup_database_files(data_dir: &std::path::Path) -> Result<DbRebuildResult, String> {
    let sources = [
        (data_dir.join("messages.db"), "messages.db"),
        (data_dir.join("messages.db-wal"), "messages.db-wal"),
        (data_dir.join("messages.db-shm"), "messages.db-shm"),
        (data_dir.join("messages.db-journal"), "messages.db-journal"),
    ];
    let existing: Vec<_> = sources
        .into_iter()
        .filter(|(path, _)| path.exists())
        .collect();

    if existing.is_empty() {
        return Ok(DbRebuildResult {
            backup_directory: None,
            moved_files: 0,
        });
    }

    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    let base_name = format!("messages-db-backup-{}", timestamp);
    let mut backup_dir = data_dir.join(&base_name);
    let mut suffix = 1;
    while backup_dir.exists() {
        backup_dir = data_dir.join(format!("{}-{}", base_name, suffix));
        suffix += 1;
    }
    fs::create_dir_all(&backup_dir).map_err(|e| format!("创建数据库备份目录失败：{}", e))?;

    let mut moved = Vec::new();
    for (source, file_name) in existing {
        let target = backup_dir.join(file_name);
        if let Err(e) = fs::rename(&source, &target) {
            for (moved_source, moved_target) in moved.iter().rev() {
                let _ = fs::rename(moved_target, moved_source);
            }
            let _ = fs::remove_dir(&backup_dir);
            return Err(format!("备份数据库文件 {:?} 失败：{}", source, e));
        }
        moved.push((source, target));
    }

    info!(
        "旧 SQLite 数据库已备份至 {:?}（{} 个文件）",
        backup_dir,
        moved.len()
    );
    Ok(DbRebuildResult {
        backup_directory: Some(backup_dir.to_string_lossy().into_owned()),
        moved_files: moved.len(),
    })
}

/// 新建或更新一条持久化发件箱记录。
#[tauri::command]
pub fn db_save_outgoing(
    state: State<DbState>,
    self_id: String,
    outgoing: OutgoingRecord,
) -> Result<bool, String> {
    if !valid_outgoing_state(&outgoing.state) {
        return Err(format!("未知的发送状态：{}", outgoing.state));
    }

    state.with_conn(|conn| {
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO outgoing_messages
                (self_id, client_id, chat_id, chat_type, source_group_id, sender_id, sender_name,
                 time, message, payload, raw_message, state, server_message_id, error,
                 retry_count, echo, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17)
             ON CONFLICT(self_id, client_id) DO UPDATE SET
                 chat_id = excluded.chat_id,
                 chat_type = excluded.chat_type,
                 source_group_id = excluded.source_group_id,
                 sender_id = excluded.sender_id,
                 sender_name = excluded.sender_name,
                 time = excluded.time,
                 message = excluded.message,
                 payload = excluded.payload,
                 raw_message = excluded.raw_message,
                 state = excluded.state,
                 server_message_id = COALESCE(excluded.server_message_id, outgoing_messages.server_message_id),
                 error = excluded.error,
                 retry_count = excluded.retry_count,
                 echo = excluded.echo,
                 updated_at = excluded.updated_at",
            params![
                self_id,
                outgoing.client_id,
                outgoing.chat_id,
                outgoing.chat_type,
                outgoing.source_group_id,
                outgoing.sender_id,
                outgoing.sender_name,
                outgoing.time,
                outgoing.message,
                outgoing.payload,
                outgoing.raw_message,
                outgoing.state,
                outgoing.server_message_id,
                outgoing.error,
                outgoing.retry_count,
                outgoing.echo,
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(true)
    })
}

/// 更新一条发件箱记录的状态。
#[tauri::command]
pub fn db_update_outgoing_state(
    state: State<DbState>,
    self_id: String,
    client_id: String,
    send_state: String,
    server_message_id: Option<String>,
    error: Option<String>,
    increment_retry: Option<bool>,
) -> Result<bool, String> {
    if !valid_outgoing_state(&send_state) {
        return Err(format!("未知的发送状态：{}", send_state));
    }

    state.with_conn(|conn| {
        let now = chrono::Utc::now().timestamp_millis();
        let n = conn.execute(
            "UPDATE outgoing_messages
                SET state = ?3,
                    server_message_id = COALESCE(?4, server_message_id),
                    error = ?5,
                    retry_count = retry_count + CASE WHEN ?6 THEN 1 ELSE 0 END,
                    updated_at = ?7
              WHERE self_id = ?1 AND client_id = ?2",
            params![
                self_id,
                client_id,
                send_state,
                server_message_id,
                error,
                increment_retry.unwrap_or(false),
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(n > 0)
    })
}

/// 获取当前账号的发件箱；可按会话和状态过滤。
#[tauri::command]
pub fn db_get_outgoing(
    state: State<DbState>,
    self_id: String,
    chat_id: Option<i64>,
    states: Option<Vec<String>>,
) -> Result<Vec<OutgoingRecord>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT client_id, chat_id, chat_type, source_group_id, sender_id,
                    sender_name, time, message, payload, raw_message, state,
                    server_message_id, error, retry_count, echo
               FROM outgoing_messages
              WHERE self_id = ?1
              ORDER BY time ASC, id ASC",
        ).map_err(|e| e.to_string())?;

        let state_filter = states.unwrap_or_default();
        let list = stmt
            .query_map(params![self_id], row_to_outgoing_record)
            .map_err(|e| e.to_string())?
            .filter_map(|record| record.ok())
            .filter(|record| chat_id.is_none_or(|id| record.chat_id == id))
            .filter(|record| state_filter.is_empty() || state_filter.contains(&record.state))
            .collect();
        Ok(list)
    })
}

/// 确认消息已保存进正式历史后，从发件箱移除。
#[tauri::command]
pub fn db_delete_outgoing(
    state: State<DbState>,
    self_id: String,
    client_id: String,
) -> Result<bool, String> {
    state.with_conn(|conn| {
        let n = conn.execute(
            "DELETE FROM outgoing_messages WHERE self_id = ?1 AND client_id = ?2",
            params![self_id, client_id],
        ).map_err(|e| e.to_string())?;
        Ok(n > 0)
    })
}

/// 链路关闭时，所有等待回执的发送都进入 uncertain，禁止自动重发。
#[tauri::command]
pub fn db_mark_sending_uncertain(
    state: State<DbState>,
    self_id: String,
    error: Option<String>,
) -> Result<usize, String> {
    state.with_conn(|conn| {
        let now = chrono::Utc::now().timestamp_millis();
        let n = conn.execute(
            "UPDATE outgoing_messages
                SET state = 'uncertain', error = ?2, updated_at = ?3
              WHERE self_id = ?1 AND state = 'sending'",
            params![self_id, error, now],
        ).map_err(|e| e.to_string())?;
        Ok(n)
    })
}

/// 获取某会话最新 n 条消息（正序返回，revoked 消息不包含）
#[tauri::command]
pub fn db_get_latest(
    state: State<DbState>,
    self_id: String,
    chat_id: i64,
    n: i64,
) -> Result<Vec<MsgRecord>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT message_id, chat_id, chat_type, sender_id, sender_name,
                        seq, time, message, raw_message, revoked
                 FROM messages
                 WHERE self_id = ?1 AND chat_id = ?2 AND revoked = 0
                 ORDER BY time DESC, id DESC
                 LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;

        let mut list: Vec<MsgRecord> = stmt
            .query_map(params![self_id, chat_id, n], row_to_record)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        // DESC 查询 → 翻转为正序（旧→新）
        list.reverse();
        Ok(list)
    })
}

/// 获取当前账号最近活跃会话的最后一条消息，用于启动时从数据库重建会话列表。
#[tauri::command]
pub fn db_get_recent_sessions(
    state: State<DbState>,
    self_id: String,
    limit: i64,
) -> Result<Vec<MsgRecord>, String> {
    state.with_conn(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT message_id, chat_id, chat_type, sender_id, sender_name,
                        seq, time, message, raw_message, revoked
                 FROM (
                     SELECT message_id, chat_id, chat_type, sender_id, sender_name,
                            seq, time, message, raw_message, revoked, id,
                            ROW_NUMBER() OVER (
                                PARTITION BY chat_id
                                ORDER BY time DESC, id DESC
                            ) AS session_rank
                     FROM messages
                     WHERE self_id = ?1 AND revoked = 0
                 )
                 WHERE session_rank = 1
                 ORDER BY time DESC, id DESC
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;

        let list = stmt
            .query_map(params![self_id, limit.clamp(1, 500)], row_to_record)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(list)
    })
}

/// 获取锚点消息之前（更旧）的 n 条，不含锚点本身，正序返回
///
/// 典型用途：上拉加载更多历史。
#[tauri::command]
pub fn db_get_before(
    state: State<DbState>,
    self_id: String,
    chat_id: i64,
    message_id: String,
    n: i64,
) -> Result<Vec<MsgRecord>, String> {
    state.with_conn(|conn| {
        let anchor = get_anchor(conn, &self_id, &message_id)
            .ok_or_else(|| format!("message_id '{}' not found in local db", message_id))?;

        let mut stmt = conn
            .prepare(
                "SELECT message_id, chat_id, chat_type, sender_id, sender_name,
                        seq, time, message, raw_message, revoked
                 FROM messages
                 WHERE self_id = ?1 AND chat_id = ?2 AND revoked = 0
                   AND (time < ?3 OR (time = ?3 AND id < ?4))
                 ORDER BY time DESC, id DESC
                 LIMIT ?5",
            )
            .map_err(|e| e.to_string())?;

        let mut list: Vec<MsgRecord> = stmt
            .query_map(
                params![self_id, chat_id, anchor.0, anchor.1, n],
                row_to_record,
            )
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        list.reverse();
        Ok(list)
    })
}

/// 获取指定时间戳之前（更旧）的 n 条，不含时间更新于锚点之后的消息，正序返回。
///
/// 典型用途：没有 seq/message_id 可用时，按 time 作为上拉历史锚点。
#[tauri::command]
pub fn db_get_before_by_time(
    state: State<DbState>,
    self_id: String,
    chat_id: i64,
    before_time: i64,
    n: i64,
) -> Result<Vec<MsgRecord>, String> {
    if before_time <= 0 || n <= 0 {
        return Ok(vec![]);
    }

    state.with_conn(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT message_id, chat_id, chat_type, sender_id, sender_name,
                        seq, time, message, raw_message, revoked
                 FROM messages
                 WHERE self_id = ?1 AND chat_id = ?2 AND revoked = 0
                   AND time <= ?3
                 ORDER BY time DESC, id DESC
                 LIMIT ?4",
            )
            .map_err(|e| e.to_string())?;

        let mut list: Vec<MsgRecord> = stmt
            .query_map(params![self_id, chat_id, before_time, n], row_to_record)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        list.reverse();
        Ok(list)
    })
}

/// 获取锚点消息之后（更新）的 n 条，不含锚点本身，正序返回
///
/// 典型用途：跳转到指定消息后加载后续内容。
#[tauri::command]
pub fn db_get_after(
    state: State<DbState>,
    self_id: String,
    chat_id: i64,
    message_id: String,
    n: i64,
) -> Result<Vec<MsgRecord>, String> {
    state.with_conn(|conn| {
        let anchor = get_anchor(conn, &self_id, &message_id)
            .ok_or_else(|| format!("message_id '{}' not found in local db", message_id))?;

        let mut stmt = conn
            .prepare(
                "SELECT message_id, chat_id, chat_type, sender_id, sender_name,
                        seq, time, message, raw_message, revoked
                 FROM messages
                 WHERE self_id = ?1 AND chat_id = ?2 AND revoked = 0
                   AND (time > ?3 OR (time = ?3 AND id > ?4))
                 ORDER BY time ASC, id ASC
                 LIMIT ?5",
            )
            .map_err(|e| e.to_string())?;

        let list: Vec<MsgRecord> = stmt
            .query_map(
                params![self_id, chat_id, anchor.0, anchor.1, n],
                row_to_record,
            )
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(list)
    })
}

/// 在指定会话中按关键词全文搜索消息（在 raw_message 中匹配）
///
/// 返回匹配的消息列表，正序（旧→新）。
#[tauri::command]
pub fn db_search_messages(
    state: State<DbState>,
    self_id: String,
    chat_id: i64,
    query: String,
) -> Result<Vec<MsgRecord>, String> {
    state.with_conn(|conn| {
        let pattern = format!("%{}%", query);

        let mut stmt = conn
            .prepare(
                "SELECT message_id, chat_id, chat_type, sender_id, sender_name,
                        seq, time, message, raw_message, revoked
                 FROM messages
                 WHERE self_id = ?1 AND chat_id = ?2 AND revoked = 0
                   AND raw_message LIKE ?3
                 ORDER BY time ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;

        let list: Vec<MsgRecord> = stmt
            .query_map(params![self_id, chat_id, pattern], row_to_record)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(list)
    })
}

/// 将某条消息标记为已撤回
///
/// 返回是否命中（true = 找到并更新了该消息）。
#[tauri::command]
pub fn db_revoke_message(
    state: State<DbState>,
    self_id: String,
    message_id: String,
) -> Result<bool, String> {
    state.with_conn(|conn| {
        let n = conn
            .execute(
                "UPDATE messages SET revoked = 1
                 WHERE self_id = ?1 AND message_id = ?2",
                params![self_id, message_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    })
}

/// 存储统计结果
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStats {
    /// 当前账号已保存的有效消息条数（不含已撤回）
    pub total_messages: i64,
    /// 已缓存的图片张数
    pub image_count: i64,
    /// 图片缓存占用的原始字节总量（BLOB 合计）
    pub image_cache_bytes: i64,
    /// 数据库文件大小（字节）
    pub db_size_bytes: u64,
}

/// 获取当前账号的消息存储统计信息
#[tauri::command]
pub fn db_get_stats(
    state: State<DbState>,
    app_handle: tauri::AppHandle,
    self_id: String,
) -> Result<DbStats, String> {
    state.with_conn(|conn| {
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE self_id = ?1 AND revoked = 0",
                params![self_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let (image_count, image_cache_bytes): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(data)), 0) FROM images WHERE self_id = ?1",
                params![self_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or((0, 0));

        let data_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;
        let db_size = std::fs::metadata(data_dir.join("messages.db"))
            .map(|m| m.len())
            .unwrap_or(0);

        Ok(DbStats {
            total_messages: total,
            image_count,
            image_cache_bytes,
            db_size_bytes: db_size,
        })
    })
}

/// 已缓存图片（返回给前端用于展示）
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedImage {
    pub mime_type: String,
    /// base64 编码的原始图片字节
    pub data: String,
}

/// 分批清理图片缓存时的进度
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbClearImagesProgress {
    pub self_id: String,
    pub total: i64,
    pub deleted: i64,
    pub batch_deleted: i64,
    /// 0 ~ 100
    pub progress: f64,
    pub done: bool,
}

/// 图片缓存清理结果
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbClearImagesResult {
    pub total: i64,
    pub deleted: i64,
    pub batches: i64,
}

/// 将图片缓存到本地数据库
///
/// `data` 为 base64 编码的原始图片字节，后端将解码后以 BLOB 形式加密存储。
#[tauri::command]
pub fn db_cache_image(
    state: State<DbState>,
    self_id: String,
    url_hash: String,
    mime_type: String,
    data: String,
) -> Result<(), String> {
    state.with_conn(|conn| {
        let bytes = general_purpose::STANDARD
            .decode(&data)
            .map_err(|e| e.to_string())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        conn.execute(
            "INSERT OR IGNORE INTO images (self_id, url_hash, mime_type, data, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![self_id, url_hash, mime_type, bytes, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// 从本地数据库获取已缓存的图片
///
/// 返回 `CachedImage`（含 MIME 类型和 base64 编码数据），若未缓存则返回 `None`。
#[tauri::command]
pub fn db_get_image(
    state: State<DbState>,
    self_id: String,
    url_hash: String,
) -> Result<Option<CachedImage>, String> {
    state.with_conn(|conn| {
        let result: rusqlite::Result<(String, Vec<u8>)> = conn.query_row(
            "SELECT mime_type, data FROM images WHERE self_id = ?1 AND url_hash = ?2",
            params![self_id, url_hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        );
        match result {
            Ok((mime_type, bytes)) => Ok(Some(CachedImage {
                mime_type,
                data: general_purpose::STANDARD.encode(&bytes),
            })),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
}

/// 清理当前账号的图片缓存
///
/// 返回实际删除的图片条数。
#[tauri::command]
pub fn db_clear_images(
    state: State<DbState>,
    app_handle: AppHandle,
    self_id: String,
) -> Result<DbClearImagesResult, String> {
    state.with_conn(|conn| {
        let batch_size = 500i64;
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM images WHERE self_id = ?1",
                params![self_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let _ = app_handle.emit(
            "db:clearImagesProgress",
            DbClearImagesProgress {
                self_id: self_id.clone(),
                total,
                deleted: 0,
                batch_deleted: 0,
                progress: if total == 0 { 100.0 } else { 0.0 },
                done: total == 0,
            },
        );

        let mut deleted = 0i64;
        let mut batches = 0i64;

        while deleted < total {
            let batch_deleted = conn
                .execute(
                    "DELETE FROM images
                     WHERE id IN (
                        SELECT id FROM images WHERE self_id = ?1 LIMIT ?2
                     )",
                    params![self_id, batch_size],
                )
                .map_err(|e| e.to_string())? as i64;

            if batch_deleted == 0 {
                break;
            }

            deleted += batch_deleted;
            batches += 1;
            let progress = if total > 0 {
                ((deleted as f64 / total as f64) * 100.0).min(100.0)
            } else {
                100.0
            };

            let _ = app_handle.emit(
                "db:clearImagesProgress",
                DbClearImagesProgress {
                    self_id: self_id.clone(),
                    total,
                    deleted,
                    batch_deleted,
                    progress,
                    done: false,
                },
            );
        }

        let _ = app_handle.emit(
            "db:clearImagesProgress",
            DbClearImagesProgress {
                self_id: self_id.clone(),
                total,
                deleted,
                batch_deleted: 0,
                progress: 100.0,
                done: true,
            },
        );

        info!(
            "已分批清理账号 {} 的图片缓存：{} / {} 条，共 {} 批",
            self_id, deleted, total, batches
        );
        Ok(DbClearImagesResult {
            total,
            deleted,
            batches,
        })
    })
}

// ── 内部工具 ─────────────────────────────────────────────────

/// 通过 message_id 查询锚点的 (time, rowid)
fn get_anchor(conn: &Connection, self_id: &str, message_id: &str) -> Option<(i64, i64)> {
    conn.query_row(
        "SELECT time, id FROM messages WHERE self_id = ?1 AND message_id = ?2",
        params![self_id, message_id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )
    .ok()
}

/// 将 rusqlite 行映射为 MsgRecord
fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<MsgRecord> {
    Ok(MsgRecord {
        message_id: row.get(0)?,
        chat_id: row.get(1)?,
        chat_type: row.get(2)?,
        sender_id: row.get(3)?,
        sender_name: row.get(4)?,
        seq: row.get(5)?,
        time: row.get(6)?,
        message: row.get(7)?,
        raw_message: row.get(8)?,
        revoked: row.get::<_, i32>(9)? != 0,
    })
}

fn row_to_outgoing_record(row: &rusqlite::Row) -> rusqlite::Result<OutgoingRecord> {
    Ok(OutgoingRecord {
        client_id: row.get(0)?,
        chat_id: row.get(1)?,
        chat_type: row.get(2)?,
        source_group_id: row.get(3)?,
        sender_id: row.get(4)?,
        sender_name: row.get(5)?,
        time: row.get(6)?,
        message: row.get(7)?,
        payload: row.get(8)?,
        raw_message: row.get(9)?,
        state: row.get(10)?,
        server_message_id: row.get(11)?,
        error: row.get(12)?,
        retry_count: row.get(13)?,
        echo: row.get(14)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebuild_moves_database_files_but_keeps_key() {
        let test_dir = std::env::temp_dir().join(format!(
            "stapxs-db-rebuild-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        fs::create_dir_all(&test_dir).unwrap();
        for name in [
            "messages.db",
            "messages.db-wal",
            "messages.db-shm",
            "messages.db-journal",
        ] {
            fs::write(test_dir.join(name), name.as_bytes()).unwrap();
        }
        fs::write(test_dir.join("messages.dbkey"), b"keep-this-key").unwrap();

        let result = backup_database_files(&test_dir).unwrap();
        let backup_dir = PathBuf::from(result.backup_directory.unwrap());

        assert_eq!(result.moved_files, 4);
        assert!(test_dir.join("messages.dbkey").exists());
        assert!(!test_dir.join("messages.db").exists());
        assert!(backup_dir.join("messages.db").exists());
        assert!(backup_dir.join("messages.db-wal").exists());
        assert!(backup_dir.join("messages.db-shm").exists());
        assert!(backup_dir.join("messages.db-journal").exists());

        fs::remove_dir_all(&test_dir).unwrap();
    }
}
