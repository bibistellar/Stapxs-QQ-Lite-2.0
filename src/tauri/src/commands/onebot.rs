use log::{info, error};
use once_cell::sync::Lazy;
use std::{collections::HashMap, sync::Mutex};
use tauri::{command, AppHandle, Emitter};
use tungstenite::protocol::frame::coding::CloseCode;

use crate::commands::utils::websocket_client::WebSocketClient;

static WS_CLIENT: Lazy<Mutex<Option<WebSocketClient>>> = Lazy::new(|| Mutex::new(None));
static WS_TARGET: Lazy<Mutex<Option<(String, String)>>> = Lazy::new(|| Mutex::new(None));

#[command]
pub async fn onebot_connect(
    app_handle: AppHandle,
    address: &str,
    token: &str,
) -> Result<(), String> {
    {
        let mut client = WS_CLIENT.lock().unwrap();
        if let Some(existing) = client.take() {
            info!("已有连接，关闭后替换");
            let _ = existing.close();
        }
    }

    info!("正在连接到: {}", address);

    // 地址必须带 ws(s) 协议，否则 http::Uri 只会给出一个看不懂的 “invalid format”
    if !address.starts_with("ws://") && !address.starts_with("wss://") {
        let message = format!("连接地址缺少 ws:// 或 wss:// 协议：{}", address);
        error!("{}", message);
        let mut payload = HashMap::new();
        payload.insert("code", 1000.to_string());
        payload.insert("message", message.clone());
        let _ = app_handle.emit("onebot:onclose", payload);
        return Err(message);
    }

    let separator = if address.contains('?') { "&" } else { "?" };
    let url = format!(
        "{}{}access_token={}",
        address,
        separator,
        urlencoding::encode(token)
    );
    let address = address.to_string();
    let token = token.to_string();
    {
        let mut target = WS_TARGET.lock().unwrap();
        *target = Some((address.clone(), token.clone()));
    }

    let app_handle_open = app_handle.clone();
    let app_handle_msg = app_handle.clone();
    let app_handle_close = app_handle.clone();

    let address_open = address.clone();
    let token_open = token.clone();
    let address_close = address.clone();
    let token_close = token.clone();

    let ws_client = WebSocketClient::create(
        &url,
        move || {
            info!("连接成功: {}", &address_open);
            let mut payload = HashMap::new();
            payload.insert("address", address_open.clone());
            payload.insert("token", token_open.clone());
            let _ = app_handle_open.emit("onebot:onopen", payload);
        },
        move |msg| {
            let _ = app_handle_msg.emit("onebot:onmessage", msg);
        },
        move |code: CloseCode, reason| {
            info!("连接已关闭：{} {:?}", code, reason);
            {
                let mut client = WS_CLIENT.lock().unwrap();
                *client = None;
            }
            {
                let mut target = WS_TARGET.lock().unwrap();
                *target = None;
            }
            let mut payload = HashMap::new();
            payload.insert("code", code.to_string());
            payload.insert("message", reason.to_string());
            payload.insert("address", address_close.clone());
            payload.insert("token", token_close.clone());
            let _ = app_handle_close.emit("onebot:onclose", payload);
        },
    )
    .await
    .map_err(|e| {
        error!("连接失败: {}", e);
        let mut payload = HashMap::new();
        payload.insert("code", 1006.to_string());
        payload.insert("message", e.to_string());
        payload.insert("address", address.clone());
        payload.insert("token", token.clone());
        let _ = app_handle.emit("onebot:onclose", payload);
        let mut target = WS_TARGET.lock().unwrap();
        *target = None;
        e.to_string()
    })?;

    let mut client = WS_CLIENT.lock().unwrap();
    *client = Some(ws_client);
    Ok(())
}

#[command]
pub fn onebot_send(data: &str) -> Result<(), String> {
    let client = WS_CLIENT.lock().unwrap();
    if let Some(ws_client) = &*client {
        ws_client.send(data).map_err(|e| e.to_string())
    } else {
        Err("WebSocketClient not initialized".to_string())
    }
}

#[command]
pub fn onebot_close(app_handle: AppHandle) -> Result<(), String> {
    let mut client = WS_CLIENT.lock().unwrap();
    if let Some(ws_client) = client.take() {
        ws_client.close().map_err(|e| e.to_string())?;
    }

    info!("连接主动关闭");
    let mut payload = HashMap::new();
    payload.insert("code", 1000.to_string());
    payload.insert("message", "".to_string());
    if let Some((address, token)) = WS_TARGET.lock().unwrap().take() {
        payload.insert("address", address);
        payload.insert("token", token);
    }
    let _ = app_handle.emit("onebot:onclose", payload);
    Ok(())
}
