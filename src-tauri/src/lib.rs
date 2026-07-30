use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent};

#[derive(Serialize, Deserialize, Clone)]
struct VaultConfig {
    vault_path: String,
    vault_name: String,
}

#[derive(Serialize)]
struct StartResult {
    #[serde(rename = "needsConfig")]
    needs_config: bool,
    url: Option<String>,
}

/// Holds the spawned Node child so it can be killed on app quit. Windows'
/// `Child::kill()` maps to TerminateProcess (not a catchable signal), so
/// the sidecar's own graceful SIGTERM handling (in adapter-node's
/// build/index.js) is unreachable from here — accepted gap, all three
/// SQLite DBs are opened in WAL mode (crash-safe) on the Node side.
///
/// Known limitation: the kill-on-quit path only runs for a *graceful*
/// close (`RunEvent::ExitRequested`). If `app.exe` is force-killed or
/// crashes, `node.exe` is orphaned — confirmed directly (`taskkill /F` on
/// the parent left the sidecar PID running). The robust fix is a Windows
/// Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, which needs
/// `unsafe` Win32 code; deferred as a follow-up rather than done here.
/// The cost of the gap is a stray process, not data loss (WAL again).
struct SidecarState(Mutex<Option<Child>>);

/// Always-on (not debug_assertions-gated) diagnostic log — a packaged
/// release build has no console attached and this splash→sidecar flow
/// happens before any window content is visible, so a plain text file next
/// to config.json is the only practical way to see what happened on a
/// machine this wasn't tested on. Best-effort: a logging failure must
/// never abort the real spawn attempt it's trying to describe. Deliberately
/// sparse — only the failure paths a real user could actually hit (Node
/// missing, spawn failed, port never opened) are logged; the step-by-step
/// success narration used while bringing this up was pulled once the
/// sidecar was confirmed working end to end.
fn log_line(app: &AppHandle, msg: &str) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("launch.log")) {
        use std::io::Write;
        let _ = f.write_all(format!("[{}] {msg}\n", chrono_now()).as_bytes());
    }
}

/// No chrono dependency for one log timestamp — SystemTime's raw offset is
/// perfectly readable enough for a debug log line.
fn chrono_now() -> String {
    format!(
        "{:?}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
    )
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

/// A missing config.json and an unparseable one are treated identically
/// (`Ok(None)`) — both mean "show the first-run picker again." Without
/// this, a hand-edited or partially-written config.json permanently locks
/// the user out with a raw serde error and no way back to the picker.
/// Only a genuine I/O failure (e.g. permissions) — not user-recoverable by
/// re-picking a folder — is still surfaced as `Err`.
fn read_config(app: &AppHandle) -> Result<Option<VaultConfig>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    match serde_json::from_str(&raw) {
        Ok(cfg) => Ok(Some(cfg)),
        Err(e) => {
            log_line(app, &format!("read_config: config.json is unparseable ({e}), treating as absent"));
            Ok(None)
        }
    }
}

fn write_config(app: &AppHandle, cfg: &VaultConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())
}

/// Resolve a working `node` binary defensively — mirrors convertQueue.ts's
/// resolvePythonBin() caution about the Windows Store App Execution Alias
/// redirector: `where node` can return a path that "exists" as a redirector
/// stub but isn't a real Node install, so every candidate is validated with
/// both a filesystem check and excluding WindowsApps paths.
fn resolve_node_binary() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(p).join("nodejs").join("node.exe"));
    }
    if let Ok(p) = std::env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(p).join("nodejs").join("node.exe"));
    }
    if let Ok(p) = std::env::var("NVM_SYMLINK") {
        candidates.push(PathBuf::from(p).join("node.exe"));
    }
    if let Some(found) = candidates.into_iter().find(|c| c.exists()) {
        return Some(found);
    }

    // Fixed install-location guesses miss real-world setups (e.g. a custom
    // install drive) — `where` finds whatever's actually on PATH. Each
    // candidate is still validated to exist on disk and isn't a Windows
    // Store App Execution Alias redirector stub (mirrors convertQueue.ts's
    // resolvePythonBin() caution about the same redirector).
    let output = Command::new("where").arg("node").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.to_lowercase().contains("windowsapps"))
        .map(PathBuf::from)
        .find(|p| p.exists())
}

/// Binds to port 0 to ask the OS for a free loopback port, then immediately
/// releases it — the standard "reserve a free port" technique. Avoids
/// needing to parse the child's stdout for its actual bound port at all.
fn get_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

async fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    false
}

async fn spawn_sidecar(app: &AppHandle, cfg: &VaultConfig) -> Result<String, String> {
    let node_bin = match resolve_node_binary() {
        Some(p) => p,
        None => {
            let msg = "Node.js bulunamadı. Vault Chat masaüstü sürümü sisteminizde kurulu bir Node.js (22+) \
         gerektirir — https://nodejs.org adresinden kurup tekrar deneyin."
                .to_string();
            log_line(app, &msg);
            return Err(msg);
        }
    };

    match Command::new(&node_bin).arg("--version").output() {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            let msg = format!(
                "Node.js çalıştırılamadı ({}). Kurulumu doğrulayın.",
                node_bin.display()
            );
            log_line(app, &format!("{msg} stderr={}", String::from_utf8_lossy(&out.stderr)));
            return Err(msg);
        }
        Err(e) => {
            let msg = format!(
                "Node.js çalıştırılamadı ({}). Kurulumu doğrulayın.",
                node_bin.display()
            );
            log_line(app, &format!("{msg} ({e})"));
            return Err(msg);
        }
    }

    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    // `bundle.resources` is the ARRAY form (["../dist-server/**/*"]) rather
    // than the map form, because the map form ({"../dist-server/build":
    // "server/build", ...}) deterministically fails to build on this project
    // with "os error 183 (file already exists)" while walking node_modules,
    // and the `"../dist-server/build/**/*": "server/build"` glob form
    // FLATTENS the whole tree into one directory — which silently produces a
    // server that dies at startup with ERR_MODULE_NOT_FOUND, since
    // adapter-node's index.js imports ./server/chunks/handler-*.js by
    // relative path. The array form preserves structure correctly; Tauri
    // encodes the leading `../` of the source glob as a literal `_up_`
    // directory, hence this path.
    let server_dir = resource_dir.join("_up_").join("dist-server");
    let entry = server_dir.join("build").join("index.js");
    if !entry.exists() {
        let msg = format!("Sunucu dosyası bulunamadı: {}", entry.display());
        log_line(app, &msg);
        return Err(msg);
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    let library_dir = app_data_dir.join("library");
    let skills_dir = app_data_dir.join("skills");
    let port = get_free_port()?;

    let child = Command::new(&node_bin)
        .arg(&entry)
        .current_dir(&server_dir)
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("VAULT_PATH", &cfg.vault_path)
        .env("PUBLIC_VAULT_NAME", &cfg.vault_name)
        .env("OLLAMA_URL", "http://localhost:11434")
        .env("CHATS_DB_PATH", app_data_dir.join("chats.db"))
        .env("STUDY_DB_PATH", app_data_dir.join("study.db"))
        .env("INDEX_DB_PATH", app_data_dir.join("vault-index.db"))
        .env("SECRETS_PATH", app_data_dir.join("secrets.json"))
        .env("PROVIDERS_PATH", server_dir.join("data").join("providers.json"))
        .env("LIBRARY_PATH", &library_dir)
        .env("SKILLS_DIR", &skills_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Sunucu başlatılamadı: {e}");
            log_line(app, &msg);
            return Err(msg);
        }
    };

    let ready = wait_for_port(port, Duration::from_secs(15)).await;
    if !ready {
        // Surface the child's own stderr — this is the single most useful
        // diagnostic (e.g. a Node ABI mismatch, a missing native module) and
        // otherwise this failure would be a bare timeout with no cause.
        let _ = child.kill();
        let mut stderr_text = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            use std::io::Read;
            let _ = stderr.read_to_string(&mut stderr_text);
        }
        log_line(app, &format!("port never opened; child stderr: {stderr_text}"));
        return Err(format!("Sunucu 15 saniye içinde başlamadı.\n{stderr_text}"));
    }

    let state = app.state::<SidecarState>();
    *state.0.lock().unwrap() = Some(child);

    Ok(format!("http://127.0.0.1:{port}"))
}

/// Called once by the splash page on load. Returns immediately if no vault
/// is configured yet (frontend shows the picker form); otherwise spawns the
/// sidecar and returns the URL to navigate to.
#[tauri::command]
async fn check_and_start(app: AppHandle) -> Result<StartResult, String> {
    match read_config(&app)? {
        None => Ok(StartResult {
            needs_config: true,
            url: None,
        }),
        Some(cfg) => {
            let url = spawn_sidecar(&app, &cfg).await?;
            Ok(StartResult {
                needs_config: false,
                url: Some(url),
            })
        }
    }
}

/// Called by the splash page's first-run form once the user picks a vault
/// folder (via @tauri-apps/plugin-dialog on the JS side) and confirms.
#[tauri::command]
async fn save_vault_config_and_start(
    app: AppHandle,
    vault_path: String,
    vault_name: String,
) -> Result<String, String> {
    let cfg = VaultConfig {
        vault_path,
        vault_name,
    };
    write_config(&app, &cfg)?;
    spawn_sidecar(&app, &cfg).await
}

/// Called from the running app's Settings page to change the vault path/
/// name for the *next* launch — VAULT_PATH is only read at server startup,
/// so this deliberately does not touch (or restart) the already-running
/// sidecar. Returns the current config for the settings UI to read on load.
#[tauri::command]
async fn get_vault_config(app: AppHandle) -> Result<Option<VaultConfig>, String> {
    read_config(&app)
}

#[tauri::command]
async fn update_vault_config(
    app: AppHandle,
    vault_path: String,
    vault_name: String,
) -> Result<(), String> {
    write_config(
        &app,
        &VaultConfig {
            vault_path,
            vault_name,
        },
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(SidecarState(Mutex::new(None)))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_and_start,
            save_vault_config_and_start,
            get_vault_config,
            update_vault_config
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            let state = app_handle.state::<SidecarState>();
            let mut guard = state.0.lock().unwrap();
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
        }
    });
}
