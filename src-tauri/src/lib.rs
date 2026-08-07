use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Passed via `Command::creation_flags` for every child we spawn (node.exe
/// is a console-subsystem binary) — without it, Windows gives the child its
/// own visible console window even though app.exe itself is a GUI-subsystem
/// process (`windows_subsystem = "windows"` in main.rs only hides app.exe's
/// own console, not a child's). The sidecar is long-lived, so that window
/// would sit open — visibly, unclosably from the user's side — for the
/// entire session.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent};
use win32job::Job;

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

/// Holds the spawned Node child (killed explicitly on a *graceful* quit —
/// Windows' `Child::kill()` maps to TerminateProcess, not a catchable
/// signal, so the sidecar's own SIGTERM handling in adapter-node's
/// build/index.js is unreachable from here) and the Windows Job Object it's
/// assigned to (handles the *abnormal* exit case: a force-kill or crash of
/// `app.exe` closes all of its handles, including the job's — and since
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is set on it, Windows itself
/// terminates every process still assigned to the job as part of that
/// handle cleanup, entirely below the level `TerminateProcess` bypasses.
/// No user-space code runs for that path; the job just has to still be
/// alive, i.e. not dropped early, which is why it's kept here rather than
/// as a local in `spawn_sidecar`). Confirmed directly before this fix:
/// `taskkill /F` on the parent left the sidecar's PID running.
struct SidecarState {
    child: Mutex<Option<Child>>,
    job: Mutex<Option<Job>>,
}

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

/// Tauri's `resource_dir()`/`app_data_dir()` resolve via `canonicalize()`
/// internally, which on Windows always returns the extended-length verbatim
/// form (`\\?\C:\...`). Rust's own file APIs understand that prefix fine,
/// but handing a `\\?\`-prefixed path to node.exe as a plain argv breaks its
/// own `resolveMainPath`/`realpathSync`, which mis-splits the root and calls
/// `lstat('C:')` — crashing with EISDIR before any app code runs. Every path
/// passed to the Node sidecar (as an argv or via env) must go through this
/// first.
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// A bare TCP connect only proves the OS accepted a handshake — not that the
/// HTTP server behind it will actually serve the very next request. That gap
/// was real: the webview's first navigation (splash/index.html's plain
/// `window.location.href = url`, no retry) occasionally hit
/// ERR_CONNECTION_REFUSED even though a TCP-only check had already reported
/// the port open moments earlier. Issue a real HTTP round-trip instead so
/// "ready" means the server actually answered a request.
fn http_probe_ok(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    if stream.set_read_timeout(Some(Duration::from_millis(500))).is_err() {
        return false;
    }
    if stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 16];
    matches!(stream.read(&mut buf), Ok(n) if n > 0 && buf.starts_with(b"HTTP/"))
}

async fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if http_probe_ok(port) {
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

    match Command::new(&node_bin)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
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

    let resource_dir = strip_verbatim_prefix(&app.path().resource_dir().map_err(|e| e.to_string())?);
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

    let app_data_dir = strip_verbatim_prefix(&app.path().app_data_dir().map_err(|e| e.to_string())?);
    std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    let skills_dir = app_data_dir.join("skills");
    let port = get_free_port()?;

    // providers.json must live in app_data_dir (writable by a standard
    // user), not the resource dir (server_dir/data) — that one sits under
    // Program Files on a per-machine install, and config-store.ts's
    // settings-UI writers (toggling a provider, saving an API key) hit
    // EPERM there. Seed it from the bundled default on first launch only —
    // every later launch's edits must survive untouched, not get
    // overwritten by the bundle's copy.
    let providers_path = app_data_dir.join("providers.json");
    if !providers_path.exists() {
        let bundled_providers = server_dir.join("data").join("providers.json");
        if let Err(e) = std::fs::copy(&bundled_providers, &providers_path) {
            // Best-effort: config-store.ts's own readFileSync will surface a
            // clear error to the settings UI if this seed never lands and
            // the file genuinely doesn't exist — better than failing the
            // whole spawn over a missing default.
            log_line(app, &format!("providers.json seed failed (non-fatal): {e}"));
        }
    }

    // DATA_DIR replaces the old LIBRARY_PATH/INDEX_DB_PATH/STUDY_DB_PATH trio
    // (Faz 8) — vaults.ts derives every vault's paths from DATA_DIR/vaults/<id>/
    // itself now, migrating automatically on first launch after the upgrade
    // (see migrateVaults.ts, run from hooks.server.ts). VAULT_PATH is still
    // passed through — it's the folder the first-run picker chose — but is
    // no longer the indexer's root; nothing currently reads it server-side
    // (the Obsidian import dialog still takes its source path as manual
    // user input, not a VAULT_PATH default).
    let child = Command::new(&node_bin)
        .arg(&entry)
        .current_dir(&server_dir)
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("DATA_DIR", &app_data_dir)
        .env("VAULT_PATH", &cfg.vault_path)
        .env("PUBLIC_VAULT_NAME", &cfg.vault_name)
        .env("OLLAMA_URL", "http://127.0.0.1:11434")
        .env("CHATS_DB_PATH", app_data_dir.join("chats.db"))
        .env("SECRETS_PATH", app_data_dir.join("secrets.json"))
        .env("PROVIDERS_PATH", &providers_path)
        .env("SKILLS_DIR", &skills_dir)
        .creation_flags(CREATE_NO_WINDOW)
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

    // Continuously drain + log the sidecar's stdout/stderr for its whole
    // life, not just this startup window — a crash minutes into a session
    // (native addon abort, uncaught JS exception, anything) used to vanish
    // into an unread OS pipe with zero trace, since the old code only ever
    // read these pipes in the timeout branch below. Plain OS threads, not
    // awaited, so this never blocks spawn_sidecar's own async flow;
    // AppHandle is Clone+Send+Sync, safe to move in. `stderr_tail` also
    // keeps the last lines around so the "didn't start in time" error below
    // can still show something inline, not just "go check the log file".
    let stderr_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                log_line(&app, &format!("[sidecar stdout] {line}"));
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        let tail = stderr_tail.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log_line(&app, &format!("[sidecar stderr] {line}"));
                if let Ok(mut t) = tail.lock() {
                    t.push_str(&line);
                    t.push('\n');
                }
            }
        });
    }

    let ready = wait_for_port(port, Duration::from_secs(15)).await;
    if !ready {
        let _ = child.kill();
        let stderr_text = stderr_tail.lock().map(|t| t.clone()).unwrap_or_default();
        log_line(app, &format!("port never opened; child stderr: {stderr_text}"));
        return Err(format!("Sunucu 15 saniye içinde başlamadı.\n{stderr_text}"));
    }

    // Best-effort: a Job Object failure must not fail the whole spawn — the
    // sidecar is already up and working, this only affects cleanup on an
    // abnormal exit, which is a narrower gap than not spawning at all.
    let job = match Job::create() {
        Ok(job) => {
            let assign_result = job.query_extended_limit_info().and_then(|mut info| {
                info.limit_kill_on_job_close();
                job.set_extended_limit_info(&info)?;
                job.assign_process(child.as_raw_handle() as isize)
            });
            match assign_result {
                Ok(()) => Some(job),
                Err(e) => {
                    log_line(app, &format!("Job Object assign failed (non-fatal): {e}"));
                    None
                }
            }
        }
        Err(e) => {
            log_line(app, &format!("Job Object create failed (non-fatal): {e}"));
            None
        }
    };

    let state = app.state::<SidecarState>();
    *state.child.lock().unwrap() = Some(child);
    *state.job.lock().unwrap() = job;

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
        .manage(SidecarState {
            child: Mutex::new(None),
            job: Mutex::new(None),
        })
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

            // System tray: a persistent indicator the sidecar is running,
            // quick access to bring the window forward, and a fast quit.
            // Deliberately doesn't change close-button behavior (no
            // minimize-to-tray) — that's a bigger UX shift than "add a tray
            // icon," and the graceful-quit path is already verified working.
            let show_item = MenuItemBuilder::with_id("show", "Göster").build(app)?;
            let menu = MenuBuilder::new(app).item(&show_item).separator().quit_with_text("Çıkış").build()?;
            let mut tray_builder = TrayIconBuilder::new().menu(&menu).tooltip("Vault Chat");
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let tray = tray_builder
                .on_menu_event(|app, event| {
                    if event.id() == "show" {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            app.manage(tray);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            let state = app_handle.state::<SidecarState>();
            let mut guard = state.child.lock().unwrap();
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
            // The Job (if assignment succeeded) is dropped along with
            // SidecarState when the process exits regardless — explicit
            // drop here isn't needed since CloseHandle-on-exit is automatic,
            // but the child.kill() above is faster for the graceful path.
        }
    });
}
