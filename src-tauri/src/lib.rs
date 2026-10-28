use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::http::{Method, Request, Response, StatusCode};
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::sync::watch;

const DEFAULT_API_ORIGIN: &str = "https://enise-docs-api-mb66o5jbpa-ew.a.run.app";
const SESSION_COOKIE_NAME: &str = "enise_session";
const MAX_GATEWAY_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_PENDING_STREAM_CANCELS: usize = 1024;
const FORWARDED_REQUEST_HEADERS: &[&str] = &[
    "accept",
    "content-type",
    "range",
    "if-range",
    "if-none-match",
    "if-modified-since",
];
const FORWARDED_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "cache-control",
    "content-range",
    "accept-ranges",
    "content-disposition",
    "etag",
    "last-modified",
    "retry-after",
    "x-cache-status",
    "x-model3d-meta",
    "x-backend",
];

#[derive(Default, Clone, Serialize, Deserialize)]
struct PersistedRuntime {
    #[serde(default)]
    enise_session: Option<String>,
    #[serde(default)]
    api_origin: Option<String>,
}

struct GatewayState {
    client: reqwest::Client,
    chat_client: reqwest::Client,
    runtime: RwLock<PersistedRuntime>,
    storage_path: RwLock<Option<PathBuf>>,
    default_origin: String,
    // None is a cancellation received before the stream command was registered.
    active_streams: RwLock<HashMap<String, Option<watch::Sender<bool>>>>,
}

impl GatewayState {
    fn new() -> Self {
        let compile_origin = option_env!("ENISE_API_ORIGIN").unwrap_or("");
        let runtime_origin = std::env::var("ENISE_API_ORIGIN").unwrap_or_default();
        let default_origin = normalize_origin(&runtime_origin)
            .or_else(|| normalize_origin(compile_origin))
            .unwrap_or_else(|| DEFAULT_API_ORIGIN.to_string());

        let client = reqwest::Client::builder()
            .user_agent("ENISE-Docs-Tauri/1.0")
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .build()
            .expect("impossible d'initialiser le client HTTP Tauri");

        let chat_client = reqwest::Client::builder()
            .user_agent("ENISE-Docs-Tauri/1.0")
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("impossible d'initialiser le client SSE Tauri");

        Self {
            client,
            chat_client,
            runtime: RwLock::new(PersistedRuntime::default()),
            storage_path: RwLock::new(None),
            default_origin,
            active_streams: RwLock::new(HashMap::new()),
        }
    }

    fn init_storage(&self, dir: PathBuf) {
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        let file_path = dir.join("enise-runtime.json");
        if let Ok(raw) = fs::read_to_string(&file_path) {
            if let Ok(mut parsed) = serde_json::from_str::<PersistedRuntime>(&raw) {
                parsed.api_origin = parsed.api_origin.as_deref().and_then(normalize_origin);
                parsed.enise_session = parsed.enise_session.filter(|v| is_safe_cookie_value(v));
                if let Ok(mut guard) = self.runtime.write() {
                    *guard = parsed;
                }
            }
        }
        if let Ok(mut path_guard) = self.storage_path.write() {
            *path_guard = Some(file_path);
        }
    }

    fn persist(&self) {
        let Some(path) = self.storage_path.read().ok().and_then(|g| g.clone()) else {
            return;
        };
        let Some(snapshot) = self.runtime.read().ok().map(|g| g.clone()) else {
            return;
        };
        if let Ok(serialized) = serde_json::to_string_pretty(&snapshot) {
            if fs::write(&path, serialized).is_ok() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
                }
            }
        }
    }

    fn current_origin(&self) -> String {
        self.runtime
            .read()
            .ok()
            .and_then(|g| g.api_origin.clone())
            .unwrap_or_else(|| self.default_origin.clone())
    }

    fn session_token(&self) -> Option<String> {
        self.runtime
            .read()
            .ok()
            .and_then(|g| g.enise_session.clone())
    }

    fn capture_set_cookies(&self, headers: &reqwest::header::HeaderMap) {
        let mut updated: Option<Option<String>> = None;
        for header_val in headers.get_all(reqwest::header::SET_COOKIE) {
            let Ok(raw) = header_val.to_str() else {
                continue;
            };
            if let Some(parsed) = parse_session_set_cookie(raw) {
                updated = Some(parsed);
            }
        }
        if let Some(next_session) = updated {
            if let Ok(mut guard) = self.runtime.write() {
                guard.enise_session = next_session;
            }
            self.persist();
        }
    }
}

fn normalize_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let parsed = reqwest::Url::parse(trimmed).ok()?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    let host = parsed.host_str()?;
    let mut origin = format!("{}://{}", parsed.scheme(), host);
    if let Some(port) = parsed.port() {
        origin.push(':');
        origin.push_str(&port.to_string());
    }
    Some(origin)
}

fn is_safe_cookie_value(val: &str) -> bool {
    !val.is_empty()
        && val.len() <= 4096
        && !val
            .chars()
            .any(|c| c == ';' || c == '\r' || c == '\n' || c.is_control())
}

fn parse_session_set_cookie(raw: &str) -> Option<Option<String>> {
    let mut segments = raw.split(';');
    let first = segments.next()?.trim();
    let (name, value) = first.split_once('=')?;
    if name.trim() != SESSION_COOKIE_NAME {
        return None;
    }
    let clean_val = value.trim();
    let mut expired = clean_val.is_empty();
    for attr in segments {
        let lower = attr.trim().to_ascii_lowercase();
        if lower == "max-age=0" || lower.starts_with("max-age=-") {
            expired = true;
        }
    }
    if expired {
        return Some(None);
    }
    if is_safe_cookie_value(clean_val) {
        Some(Some(clean_val.to_string()))
    } else {
        None
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ChatStreamMessage {
    Chunk { text: String },
    Done,
    Error { status: u16, message: String },
}

#[tauri::command]
fn get_api_origin(state: State<'_, Arc<GatewayState>>) -> String {
    state.current_origin()
}

#[tauri::command]
fn set_api_origin(state: State<'_, Arc<GatewayState>>, origin: String) -> Result<String, String> {
    if origin.trim().is_empty() {
        if let Ok(mut guard) = state.runtime.write() {
            guard.api_origin = None;
        }
        state.persist();
        return Ok(state.current_origin());
    }
    let normalized = normalize_origin(&origin)
        .ok_or_else(|| "URL d’origine API invalide (attendu : https://domaine).".to_string())?;
    if let Ok(mut guard) = state.runtime.write() {
        guard.api_origin = Some(normalized);
    }
    state.persist();
    Ok(state.current_origin())
}

#[tauri::command]
fn tauri_chat_cancel(state: State<'_, Arc<GatewayState>>, stream_id: String) {
    if let Ok(mut map) = state.active_streams.write() {
        if let Some(Some(tx)) = map.get(&stream_id) {
            let _ = tx.send(true);
        } else if !map.contains_key(&stream_id) && map.len() < MAX_PENDING_STREAM_CANCELS {
            // IPC calls can arrive out of order. Remember an early cancel so
            // the subsequent stream command never starts an upstream request.
            map.insert(stream_id, None);
        }
    }
}

#[tauri::command]
async fn tauri_chat_stream(
    state: State<'_, Arc<GatewayState>>,
    stream_id: String,
    body: String,
    on_event: Channel<ChatStreamMessage>,
) -> Result<(), String> {
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let gateway = Arc::clone(&*state);
    if let Ok(mut map) = gateway.active_streams.write() {
        if matches!(map.remove(&stream_id), Some(None)) {
            return Ok(());
        }
        map.insert(stream_id.clone(), Some(cancel_tx));
    }

    let result = run_chat_stream(&gateway, body, &on_event, &mut cancel_rx).await;

    if let Ok(mut map) = gateway.active_streams.write() {
        map.remove(&stream_id);
    }
    result
}

async fn run_chat_stream(
    state: &GatewayState,
    body: String,
    on_event: &Channel<ChatStreamMessage>,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let target = format!("{}/api/chat", state.current_origin());
    let mut builder = state
        .chat_client
        .post(&target)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body);

    if let Some(token) = state.session_token() {
        builder = builder.header(
            reqwest::header::COOKIE,
            format!("{SESSION_COOKIE_NAME}={token}"),
        );
    }

    let mut upstream = tokio::select! {
        _ = cancel_rx.changed() => return Ok(()),
        res = builder.send() => match res {
            Ok(resp) => resp,
            Err(_) => {
                let _ = on_event.send(ChatStreamMessage::Error {
                    status: 502,
                    message: "Connexion au service d’assistant impossible.".to_string(),
                });
                return Ok(());
            }
        }
    };

    state.capture_set_cookies(upstream.headers());

    let status = upstream.status().as_u16();
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if !upstream.status().is_success() || !content_type.contains("text/event-stream") {
        let err_bytes = upstream.bytes().await.unwrap_or_default();
        let message = serde_json::from_slice::<serde_json::Value>(&err_bytes)
            .ok()
            .and_then(|val| val.get("error").and_then(|e| e.as_str()).map(str::to_owned))
            .unwrap_or_else(|| "L’assistant n’a pas pu répondre.".to_string());
        let _ = on_event.send(ChatStreamMessage::Error { status, message });
        return Ok(());
    }

    let mut pending_utf8: Vec<u8> = Vec::new();
    loop {
        let next_chunk = tokio::select! {
            _ = cancel_rx.changed() => return Ok(()),
            chunk = upstream.chunk() => chunk,
        };

        match next_chunk {
            Ok(Some(bytes)) => {
                pending_utf8.extend_from_slice(&bytes);
                let valid_len = match std::str::from_utf8(&pending_utf8) {
                    Ok(valid) => valid.len(),
                    Err(err) => err.valid_up_to(),
                };
                if valid_len > 0 {
                    let text = String::from_utf8_lossy(&pending_utf8[..valid_len]).into_owned();
                    pending_utf8.drain(..valid_len);
                    let _ = on_event.send(ChatStreamMessage::Chunk { text });
                }
            }
            Ok(None) => {
                if !pending_utf8.is_empty() {
                    let text = String::from_utf8_lossy(&pending_utf8).into_owned();
                    let _ = on_event.send(ChatStreamMessage::Chunk { text });
                }
                let _ = on_event.send(ChatStreamMessage::Done);
                break;
            }
            Err(_) => {
                let _ = on_event.send(ChatStreamMessage::Error {
                    status: 502,
                    message: "Flux interrompu avec l’assistant.".to_string(),
                });
                break;
            }
        }
    }

    Ok(())
}

fn gateway_origin_allowed(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "eniseapi://localhost"
            | "http://eniseapi.localhost"
            | "https://eniseapi.localhost"
    ) {
        return true;
    }
    // Tauri mobile dev may rewrite localhost to a LAN address. This exception
    // is never compiled into release builds and is limited to the dev port.
    if !cfg!(debug_assertions) {
        return false;
    }
    // Origin is a serialized origin, not a URL: require the exact scheme and
    // port, then accept only a literal private/loopback address or localhost.
    // Paths, credentials, queries and misleading domain suffixes all fail.
    let Some(host) = origin
        .strip_prefix("http://")
        .and_then(|value| value.strip_suffix(":3000"))
    else {
        return false;
    };
    host == "localhost"
        || host
            .parse::<std::net::Ipv4Addr>()
            .map(|addr| addr.is_private() || addr.is_loopback())
            .unwrap_or(false)
}

fn cors_response_builder(
    origin_header: Option<&str>,
    status: StatusCode,
) -> tauri::http::response::Builder {
    let allow_origin = match origin_header {
        Some(origin) if !origin.is_empty() => origin,
        _ => "*",
    };
    let mut builder = Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", allow_origin)
        .header("Access-Control-Allow-Methods", "GET, HEAD, POST, PATCH, DELETE, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range, If-Range, Content-Type, Authorization, Accept")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Range, Content-Length, Accept-Ranges, ETag, Last-Modified, X-Cache-Status, X-Model3D-Meta, Retry-After",
        )
        .header("X-Content-Type-Options", "nosniff");

    if allow_origin != "*" {
        builder = builder
            .header("Access-Control-Allow-Credentials", "true")
            .header("Vary", "Origin");
    }
    builder
}

fn json_gateway_error(
    origin_header: Option<&str>,
    status: StatusCode,
    message: &str,
) -> Response<Vec<u8>> {
    let payload = serde_json::json!({ "error": message })
        .to_string()
        .into_bytes();
    cors_response_builder(origin_header, status)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Content-Length", payload.len().to_string())
        .body(payload)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

async fn handle_gateway_request(
    state: Arc<GatewayState>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let req_origin = request
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let origin_ref = req_origin.as_deref();

    // The gateway injects the user's session. Never reflect an arbitrary
    // origin: a remote iframe must not be able to read private API responses.
    if origin_ref.is_some_and(|origin| !gateway_origin_allowed(origin)) {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .header("Cache-Control", "no-store")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    if request.method() == Method::OPTIONS {
        return cors_response_builder(origin_ref, StatusCode::NO_CONTENT)
            .header("Access-Control-Max-Age", "86400")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let path_only = request.uri().path();

    if !path_only.starts_with("/api/") && path_only != "/api" {
        return json_gateway_error(
            origin_ref,
            StatusCode::NOT_FOUND,
            "Route passerelle introuvable.",
        );
    }

    let Ok(method) = reqwest::Method::from_bytes(request.method().as_str().as_bytes()) else {
        return json_gateway_error(
            origin_ref,
            StatusCode::METHOD_NOT_ALLOWED,
            "Méthode HTTP invalide.",
        );
    };

    let target_url = format!("{}{}", state.current_origin(), path_and_query);
    let mut builder = state.client.request(method.clone(), &target_url);

    for name in FORWARDED_REQUEST_HEADERS {
        if let Some(val) = request.headers().get(*name).and_then(|v| v.to_str().ok()) {
            builder = builder.header(*name, val);
        }
    }

    if let Some(token) = state.session_token() {
        builder = builder.header(
            reqwest::header::COOKIE,
            format!("{SESSION_COOKIE_NAME}={token}"),
        );
    }

    let body_bytes = request.into_body();
    if !body_bytes.is_empty() && method != reqwest::Method::GET && method != reqwest::Method::HEAD {
        builder = builder.body(body_bytes);
    }

    let mut upstream = match builder.send().await {
        Ok(resp) => resp,
        Err(_) => {
            return json_gateway_error(
                origin_ref,
                StatusCode::BAD_GATEWAY,
                "Connexion au service documentaire impossible.",
            );
        }
    };

    state.capture_set_cookies(upstream.headers());

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    // HEAD has no response body but its Content-Length describes the full PDF;
    // replacing it with the buffered body's length (zero) breaks size checks.
    let head_length = if method == reqwest::Method::HEAD {
        upstream
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    } else {
        None
    };
    let mut resp_builder = cors_response_builder(origin_ref, status);

    for header_name in FORWARDED_RESPONSE_HEADERS {
        if let Some(val) = upstream
            .headers()
            .get(*header_name)
            .and_then(|v| v.to_str().ok())
        {
            resp_builder = resp_builder.header(*header_name, val);
        }
    }

    let mut collected = Vec::new();
    while let Some(chunk) = match upstream.chunk().await {
        Ok(c) => c,
        Err(_) => {
            return json_gateway_error(
                origin_ref,
                StatusCode::BAD_GATEWAY,
                "Lecture interrompue depuis le service documentaire.",
            );
        }
    } {
        if collected.len().saturating_add(chunk.len()) > MAX_GATEWAY_BODY_BYTES {
            return json_gateway_error(
                origin_ref,
                StatusCode::PAYLOAD_TOO_LARGE,
                "Ce fichier dépasse la taille maximale du tampon local ; téléchargez-le directement.",
            );
        }
        collected.extend_from_slice(&chunk);
    }

    resp_builder = resp_builder.header(
        "Content-Length",
        head_length.unwrap_or_else(|| collected.len().to_string()),
    );
    resp_builder
        .body(collected)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let gateway_state = Arc::new(GatewayState::new());
    let protocol_state = Arc::clone(&gateway_state);
    let setup_state = Arc::clone(&gateway_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(gateway_state)
        .setup(move |app| {
            if let Ok(app_data_dir) = app.path().app_data_dir() {
                setup_state.init_storage(app_data_dir);
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("eniseapi", move |_ctx, request, responder| {
            let state = Arc::clone(&protocol_state);
            tauri::async_runtime::spawn(async move {
                let response = handle_gateway_request(state, request).await;
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            get_api_origin,
            set_api_origin,
            tauri_chat_stream,
            tauri_chat_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("erreur lors de l'exécution de l'application Tauri ENISE Docs");
}

#[cfg(test)]
mod gateway_origin_tests {
    use super::gateway_origin_allowed;

    #[test]
    fn native_origins_are_allowed() {
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "eniseapi://localhost",
            "http://eniseapi.localhost",
            "https://eniseapi.localhost",
        ] {
            assert!(gateway_origin_allowed(origin), "rejected {origin:?}");
        }
    }

    #[test]
    fn third_party_origins_and_unrelated_local_ports_are_rejected() {
        for origin in [
            "https://example.com",
            "http://tauri.localhost.evil",
            "http://localhost:3001",
            "null",
            "https://localhost:3000",
            "http://localhost.evil:3000",
            "http://user@localhost:3000",
            "http://localhost:3000/path",
        ] {
            assert!(!gateway_origin_allowed(origin), "accepted {origin}");
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn development_exception_is_limited_to_local_network_and_port() {
        assert!(gateway_origin_allowed("http://localhost:3000"));
        assert!(gateway_origin_allowed("http://192.168.1.4:3000"));
        assert!(!gateway_origin_allowed("http://192.168.1.4:3001"));
        assert!(!gateway_origin_allowed("http://8.8.8.8:3000"));
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn development_origins_are_rejected_in_release() {
        assert!(!gateway_origin_allowed("http://localhost:3000"));
        assert!(!gateway_origin_allowed("http://192.168.1.4:3000"));
    }
}
