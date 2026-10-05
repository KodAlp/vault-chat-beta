mod launchers;
mod platform;
mod secrets_key;
// winget is a Windows-only package manager; other platforms get a stub with
// the same Tauri command names/signatures (so build.rs's ACL manifest and the
// capability files stay identical on every OS).
#[cfg(windows)]
mod winget;
#[cfg(not(windows))]
#[path = "winget_unsupported.rs"]
mod winget;

use platform::ProcessGuard;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize, Deserialize, Clone)]
struct VaultConfig {
    vault_path: String,
    vault_name: String,
}

/// What the splash page shows a dedicated panel for instead of the generic
/// error box — `kind` is either `"missing"` (no usable Node binary found or
/// resolvable one won't even run) or `"wrong_version"` (a Node was found
/// and runs, but its major doesn't match `required`). `found` is the raw
/// `node --version` text when one WAS obtained (always `None` for
/// `"missing"`, always `Some` for `"wrong_version"`).
#[derive(Serialize, Clone)]
struct NodeProblem {
    kind: String,
    found: Option<String>,
    required: String,
}

#[derive(Serialize)]
struct StartResult {
    #[serde(rename = "needsConfig")]
    needs_config: bool,
    url: Option<String>,
    // Backward-compatible with the existing `needsConfig`/`url` shape the
    // splash page already reads — this is simply never present on an older
    // build's response, and `Option` + skip_serializing_if means an OK
    // start still serializes to exactly the same two fields as before.
    #[serde(rename = "nodeProblem", skip_serializing_if = "Option::is_none")]
    node_problem: Option<NodeProblem>,
}

/// What `spawn_sidecar` actually accomplished — kept distinct from a plain
/// `Result<String, String>` because a Node problem is a NORMAL, expected
/// outcome the splash needs to render its own panel for (see `NodeProblem`),
/// not a generic failure string dumped into the splash's catch-all error
/// box. Every other failure path in `spawn_sidecar` (resource dir missing,
/// server entry file missing, sidecar process itself failed to spawn, port
/// never opened) still returns a plain `Err(String)` — those really are
/// "something went wrong we don't have a dedicated UI for."
enum SidecarOutcome {
    Started(String),
    NodeProblem(NodeProblem),
}

/// The Node major this build's better-sqlite3 native addon was compiled
/// against — embedded by build.rs (see its own doc comment) from the BUILD
/// machine's `node --version`, falling back to package.json's declared
/// `engines.node` lower bound if `node` wasn't runnable there. Compared
/// against the SIDECAR's own `node --version` in `resolve_and_verify_node`.
const VAULTCHAT_NODE_MAJOR: &str = env!("VAULTCHAT_NODE_MAJOR");

fn required_node_major() -> u32 {
    // The literal this build embedded is always digits-only (see build.rs)
    // — `unwrap_or(22)` here is just an extra layer of never-panic caution,
    // matching package.json's own declared lower bound as the last-resort
    // fallback value.
    VAULTCHAT_NODE_MAJOR.parse().unwrap_or(22)
}

/// Parses the major version number out of a `node --version`-style string
/// — `"v22.11.0"` -> `22`, and just as happily `"22.11.0"` (no leading `v`)
/// -> `22`. Pure, no I/O, so it's unit-tested directly against both real
/// and garbage input rather than only exercised indirectly through a real
/// `node --version` call.
fn parse_node_major_version(version_text: &str) -> Option<u32> {
    let trimmed = version_text.trim();
    let no_v = trimmed.strip_prefix('v').unwrap_or(trimmed);
    let major_str = no_v.split('.').next()?;
    if major_str.is_empty() {
        return None;
    }
    major_str.parse().ok()
}

/// Resolves a Node binary via `resolve_node_binary()` and confirms both that
/// it actually runs and that its major version matches
/// `required_node_major()` — a mismatched major isn't "might not work",
/// it's a different Node ABI (NODE_MODULE_VERSION), which fails to even
/// `require()` better-sqlite3's compiled `.node` file inside the sidecar,
/// so this gate runs BEFORE the sidecar is ever spawned rather than letting
/// it crash after the fact with a much less legible native-addon error.
fn resolve_and_verify_node() -> Result<PathBuf, NodeProblem> {
    let required = VAULTCHAT_NODE_MAJOR.to_string();
    let Some(node_bin) = resolve_node_binary() else {
        return Err(NodeProblem {
            kind: "missing".to_string(),
            found: None,
            required,
        });
    };

    let mut version_cmd = Command::new(&node_bin);
    version_cmd.arg("--version");
    platform::no_window(&mut version_cmd);
    let output = version_cmd.output();
    let version_text = match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        // Exists on disk but won't run (broken install, permissions, a
        // WindowsApps stub that slipped past resolve_node_binary's own
        // filter, ...). Same remedy as "missing" from the user's side —
        // (re)install Node — so it's reported the same way rather than
        // inventing a third UI state for what's practically identical.
        _ => {
            return Err(NodeProblem {
                kind: "missing".to_string(),
                found: None,
                required,
            })
        }
    };

    match parse_node_major_version(&version_text) {
        Some(major) if major == required_node_major() => Ok(node_bin),
        Some(_) => Err(NodeProblem {
            kind: "wrong_version".to_string(),
            found: Some(version_text),
            required,
        }),
        None => Err(NodeProblem {
            kind: "missing".to_string(),
            found: Some(version_text),
            required,
        }),
    }
}

/// Re-checks Node without touching the sidecar — called from the splash
/// page right after a winget-driven Node install finishes, before it
/// retries `check_and_start`. Finds a just-installed Node with NO relaunch
/// needed: `resolve_node_binary` checks the fixed
/// `%ProgramFiles%\nodejs\node.exe` location FIRST (see its own doc
/// comment), which is exactly where Node's official Windows installer (the
/// one `winget install --id OpenJS.NodeJS.22` runs) places it — unlike a
/// `where`/PATH-based lookup, which would only see this already-running
/// process's stale, captured-at-launch PATH and could miss a fresh install
/// entirely until the app itself restarts.
#[derive(Serialize)]
struct NodeStatus {
    ok: bool,
    #[serde(rename = "nodeProblem", skip_serializing_if = "Option::is_none")]
    node_problem: Option<NodeProblem>,
}

#[tauri::command]
async fn recheck_node() -> NodeStatus {
    match resolve_and_verify_node() {
        Ok(_) => NodeStatus {
            ok: true,
            node_problem: None,
        },
        Err(problem) => NodeStatus {
            ok: false,
            node_problem: Some(problem),
        },
    }
}

/// Holds the spawned Node child (stopped explicitly on a *graceful* quit —
/// on Windows `Child::kill()` maps to TerminateProcess, not a catchable
/// signal, so the sidecar's own SIGTERM handling in adapter-node's
/// build/index.js is unreachable from there; on Unix `ProcessGuard` sends
/// SIGTERM first, which adapter-node does handle) and the `ProcessGuard`
/// that owns its process tree (handles the *abnormal* exit case. Windows: a
/// force-kill or crash of `app.exe` closes all of its handles, including the
/// Job Object's — and since `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is set on
/// it, Windows itself terminates every process still assigned to the job as
/// part of that handle cleanup, entirely below the level `TerminateProcess`
/// bypasses. No user-space code runs for that path; the job just has to
/// still be alive, i.e. not dropped early, which is why it's kept here
/// rather than as a local in `spawn_sidecar`. Confirmed directly before this
/// fix: `taskkill /F` on the parent left the sidecar's PID running. Linux:
/// `PR_SET_PDEATHSIG`; macOS: no crash-time protection, see platform.rs).
struct SidecarState {
    child: Mutex<Option<Child>>,
    guard: Mutex<Option<ProcessGuard>>,
    /// The URL of the currently-running sidecar, if any — lets
    /// `spawn_sidecar` recognize "I'm already up" and hand back the same
    /// URL instead of spawning a second node.exe (see the guard at the top
    /// of that function for why a second spawn is actively dangerous, not
    /// just wasteful). Deliberately the PLAIN `http://127.0.0.1:{port}` URL,
    /// never the one-time `?vc_session=` variant — see spawn_sidecar's
    /// session-token doc comment for why reusing that query value here
    /// would be both unnecessary (the webview's cookie already carries the
    /// session by the time anything reads this again) and wrong (handing
    /// the same token out on a second navigation defeats "one-time").
    url: Mutex<Option<String>>,
    /// The remote origin (`http://127.0.0.1:{port}`) a runtime IPC
    /// capability has already been granted for, if any — see the capability
    /// registration at the end of `spawn_sidecar`. Guards against
    /// re-registering the SAME origin if `spawn_sidecar` is ever entered a
    /// second time while `state.child`/`state.url` still describe a live
    /// process (shouldn't happen given the early-return guard at the top of
    /// that function, but this is a cheap, purely defensive second layer —
    /// `add_capability` itself is additive/idempotent-safe to call again
    /// with a new origin after a real respawn on a different port).
    capability_origin: Mutex<Option<String>>,
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
    let dir = app.path().app_data_dir().map_err(|e| {
        let msg = format!("app_data_dir() başarısız: {e}");
        log_line(app, &msg);
        msg
    })?;
    std::fs::create_dir_all(&dir).map_err(|e| {
        let msg = format!("app_data_dir oluşturulamadı: {e}");
        log_line(app, &msg);
        msg
    })?;
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
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        let msg = format!("config.json okunamadı: {e}");
        log_line(app, &msg);
        msg
    })?;
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
#[cfg(windows)]
fn resolve_node_binary() -> Option<PathBuf> {
    let node_exe = platform::exe_name("node");
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(p).join("nodejs").join(&node_exe));
    }
    if let Ok(p) = std::env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(p).join("nodejs").join(&node_exe));
    }
    if let Ok(p) = std::env::var("NVM_SYMLINK") {
        candidates.push(PathBuf::from(p).join(&node_exe));
    }
    if let Some(found) = candidates.into_iter().find(|c| c.exists()) {
        return Some(found);
    }

    // Fixed install-location guesses miss real-world setups (e.g. a custom
    // install drive) — `where` finds whatever's actually on PATH. Each
    // candidate is still validated to exist on disk and isn't a Windows
    // Store App Execution Alias redirector stub (mirrors convertQueue.ts's
    // resolvePythonBin() caution about the same redirector).
    let mut where_cmd = Command::new("where");
    where_cmd.arg("node");
    platform::no_window(&mut where_cmd);
    let output = where_cmd.output().ok()?;
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

/// Resolve a working `node` binary on Linux/macOS: `$PATH` first, then the
/// usual install locations (system package, Homebrew, Volta, nvm, fnm) —
/// a GUI-launched app often inherits a minimal PATH that misses the latter
/// (`find_in_path` therefore also searches the login shell's PATH).
/// The caller (`resolve_and_verify_node`) still verifies that the binary
/// runs and has the required major version.
#[cfg(unix)]
fn resolve_node_binary() -> Option<PathBuf> {
    let node = platform::exe_name("node");
    if let Some(found) = platform::find_in_path(&node) {
        return Some(found);
    }

    let mut candidates: Vec<PathBuf> =
        ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"].iter().map(|dir| Path::new(dir).join(&node)).collect();
    if let Some(home) = platform::home_dir() {
        candidates.push(home.join(".volta").join("bin").join(&node));
        let major = required_node_major();
        // nvm: ~/.nvm/versions/node/v<major>.x.y/bin/node
        if let Some(dir) = platform::highest_version_dir(&home.join(".nvm").join("versions").join("node"), major) {
            candidates.push(dir.join("bin").join(&node));
        }
        // fnm: ~/.local/share/fnm (Linux) or ~/Library/Application Support/fnm (macOS)
        for base in [
            home.join(".local").join("share").join("fnm").join("node-versions"),
            home.join("Library").join("Application Support").join("fnm").join("node-versions"),
        ] {
            if let Some(dir) = platform::highest_version_dir(&base, major) {
                candidates.push(dir.join("installation").join("bin").join(&node));
            }
        }
    }
    candidates.into_iter().find(|c| platform::is_executable_file(c))
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
///
/// `session_token`, when given, is sent as an `x-vc-session` header — the
/// alternative the Node sidecar accepts to its normal session cookie (see
/// spawn_sidecar's `VC_SESSION_TOKEN` contract). This probe runs BEFORE any
/// browser navigation has ever happened, so there is no cookie yet; without
/// this header a sidecar that gates every route (not just app routes) on a
/// valid session would answer this plain `GET /` with a 401/redirect rather
/// than the `HTTP/` status line this function is waiting for, and startup
/// would time out even though the server is actually up. Callers probing
/// some OTHER local server (launchers.rs, for unrelated local-LLM servers
/// like Ollama/LM Studio) pass `None` — sending our own sidecar's session
/// token to a third-party process would make no sense and reveal it
/// pointlessly.
fn http_probe_ok(port: u16, session_token: Option<&str>) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    if stream.set_read_timeout(Some(Duration::from_millis(500))).is_err() {
        return false;
    }
    let mut request = String::from("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(token) = session_token {
        request.push_str(&format!("x-vc-session: {token}\r\n"));
    }
    request.push_str("\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 16];
    matches!(stream.read(&mut buf), Ok(n) if n > 0 && buf.starts_with(b"HTTP/"))
}

/// adapter-node's `index.js` prints `Listening on http://127.0.0.1:NNNNN`
/// the moment `httpServer.listen()`'s callback fires — i.e. only after the
/// OS has actually bound the port. Parsing that line (sent with `PORT=0`,
/// letting Node/the OS pick a genuinely free port atomically at bind time)
/// replaces the old reserve-a-port-then-hope-nothing-steals-it-before-Node-
/// binds-it race entirely, rather than narrowing it.
fn parse_listening_port(line: &str) -> Option<u16> {
    line.rsplit_once(':')?.1.trim().parse().ok()
}

/// Waits for the sidecar to report its bound port (via `port_rx`, fed by the
/// stdout drain thread's `parse_listening_port`), then additionally confirms
/// it with a real HTTP round-trip — belt and suspenders: the "Listening on"
/// line alone proves the OS-level bind succeeded, `http_probe_ok` catches
/// the rarer case of a crash in the instant right after. `session_token` is
/// forwarded to `http_probe_ok` — see that function's doc comment.
async fn wait_for_sidecar_ready(port_rx: std::sync::mpsc::Receiver<u16>, timeout: Duration, session_token: &str) -> Option<u16> {
    let start = std::time::Instant::now();
    let mut port: Option<u16> = None;
    while start.elapsed() < timeout {
        if port.is_none() {
            if let Ok(p) = port_rx.try_recv() {
                port = Some(p);
            }
        }
        if let Some(p) = port {
            if http_probe_ok(p, Some(session_token)) {
                return Some(p);
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const MCP_ENDPOINT_FILE: &str = "mcp-endpoint.json";

/// Publishes where the sidecar listens plus the MCP token for the MCP stdio
/// process (mcp/app-client.ts reads it; format shared with
/// src/lib/server/mcp-endpoint.ts): `{ url, mcpToken, pid, startedAt }`. The
/// session token is deliberately NOT in here. Written to a temp file first and
/// renamed over the target, so a reader never sees half a file; owner-only
/// (0600) on Unix, the per-user app-data ACL on Windows.
fn write_mcp_endpoint(dir: &Path, url: &str, token: &str, pid: u32) -> Result<(), String> {
    use std::io::Write;
    // utc_timestamp_now() is "YYYYMMDDTHHMMSSZ"; the Node side writes ISO 8601.
    let ts = secrets_key::utc_timestamp_now();
    let started_at = if ts.len() == 16 {
        format!("{}-{}-{}T{}:{}:{}Z", &ts[0..4], &ts[4..6], &ts[6..8], &ts[9..11], &ts[11..13], &ts[13..15])
    } else {
        ts
    };
    let body = serde_json::json!({ "url": url, "mcpToken": token, "pid": pid, "startedAt": started_at });
    let text = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())? + "\n";

    let target = dir.join(MCP_ENDPOINT_FILE);
    let tmp = dir.join(format!("{MCP_ENDPOINT_FILE}.tmp"));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp).map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

/// Removes mcp-endpoint.json, but only if it still names `pid` — a newer app
/// instance may have replaced it already. Best-effort: any failure is ignored.
fn remove_mcp_endpoint(dir: &Path, pid: u32) {
    let target = dir.join(MCP_ENDPOINT_FILE);
    let Ok(raw) = std::fs::read_to_string(&target) else { return };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
    if value.get("pid").and_then(|p| p.as_u64()) == Some(u64::from(pid)) {
        let _ = std::fs::remove_file(&target);
    }
}

/// The runtime IPC capability granted to the sidecar's own origin (see
/// `spawn_sidecar`'s registration of it) — pulled out as its own function
/// so the ACL regression test below (`ipc_acl_tests`) exercises the EXACT
/// same permission list production code grants, rather than a hand-copied
/// second list that could silently drift out of sync with it.
///
/// `CapabilityBuilder::remote` takes a URLPattern (see tauri-utils's
/// `RemoteUrlPattern::from_str`); passing the bare origin with no path
/// segment is sufficient — that parser fills a missing/empty/`"/"`
/// pathname in with `"*"` itself, so this already matches `/`,
/// `/?vc_session=...`, `/settings`, etc. without needing an explicit
/// trailing `/*`.
///
/// Least privilege: ONLY the commands pages under `src/` actually call —
/// NOT `check_and_start` / `save_vault_config_and_start` / `recheck_node`,
/// which only the splash page (a local origin, covered by
/// `capabilities/default.json` instead) ever invokes. Every `"allow-*"`
/// identifier here comes from the app ACL manifest build.rs's
/// `AppManifest::commands(&[...])` generates — see that file's doc comment
/// for why an app manifest had to exist at all before any of this could be
/// granted to a remote origin.
fn sidecar_remote_capability(url: String) -> tauri::ipc::CapabilityBuilder {
    tauri::ipc::CapabilityBuilder::new("sidecar-remote")
        .window("main")
        .remote(url)
        .permission("core:default")
        .permission("core:event:default")
        // Custom title bar + F11 (WindowTitleBar.svelte / +layout.svelte): the page runs on the
        // sidecar's remote origin, so these are granted here as well as in capabilities/default.json.
        .permission("core:window:allow-start-dragging")
        .permission("core:window:allow-minimize")
        .permission("core:window:allow-toggle-maximize")
        .permission("core:window:allow-close")
        .permission("core:window:allow-set-fullscreen")
        .permission("dialog:default")
        .permission("opener:default")
        .permission("allow-winget-install")
        .permission("allow-winget-available")
        .permission("allow-get-vault-config")
        .permission("allow-update-vault-config")
        .permission("allow-save-text-file")
        .permission("allow-reset-secrets-storage")
        .permission("allow-detect-local-servers")
        .permission("allow-list-launchers")
        .permission("allow-save-launcher")
        .permission("allow-pick-launcher-program")
        .permission("allow-redetect-launcher-program")
        .permission("allow-start-launcher")
        .permission("allow-stop-launcher")
        .permission("allow-launcher-status")
}

/// Stops the sidecar's process tree and every launcher process. Shared by the
/// normal exit path and by reset_secrets_storage, because `AppHandle::restart`
/// exits the process WITHOUT emitting `RunEvent::ExitRequested`.
fn stop_all_children(app_handle: &AppHandle) {
    let state = app_handle.state::<SidecarState>();
    let mut child_slot = state.child.lock().unwrap();
    let process_guard = state.guard.lock().unwrap().take();
    if let Some(mut child) = child_slot.take() {
        let pid = child.id();
        // Windows: Child::kill() + dropping the Job (tree kill).
        // Unix: SIGTERM to the sidecar's process group first
        // (adapter-node shuts down gracefully on it), then SIGKILL
        // if it hasn't exited after ~3s.
        ProcessGuard::stop_or_kill(process_guard, &mut child);
        // The sidecar is gone, so its MCP endpoint file is stale — remove it so an MCP client reports
        // "app not running" instead of timing out on a dead port.
        if let Ok(dir) = app_handle.path().app_data_dir() {
            remove_mcp_endpoint(&strip_verbatim_prefix(&dir), pid);
        }
    }
    drop(child_slot);

    launchers::shutdown_all(app_handle);
}

/// User-initiated recovery from a permanently "locked" secrets store (corrupt
/// DPAPI blob after a Windows password reset, an inaccessible keychain item...):
/// sets secrets.json aside (renamed to secrets.json.locked-<UTC timestamp>,
/// never deleted), removes the key (Windows: secrets.key renamed likewise;
/// macOS/Linux: keyring entry deleted), then restarts the app so the sidecar
/// comes back with a fresh key resolution. See
/// secrets_key::reset_secrets_storage_with for the step order and rollback.
///
/// The sidecar is stopped BEFORE any file is touched so nothing can write
/// secrets.json mid-reset. On failure the app keeps running (the sidecar is
/// gone, so the window needs a manual restart) and the error is returned to
/// the caller. Only granted to the settings pages' origin — see
/// sidecar_remote_capability.
#[tauri::command]
async fn reset_secrets_storage(app: AppHandle) -> Result<(), String> {
    let app_data_dir = strip_verbatim_prefix(&app.path().app_data_dir().map_err(|e| format!("app_data_dir() başarısız: {e}"))?);
    stop_all_children(&app);
    let timestamp = secrets_key::utc_timestamp_now();
    let ops = secrets_key::OsResetOps::new(&app_data_dir);
    let result = tauri::async_runtime::spawn_blocking(move || secrets_key::reset_secrets_storage_with(&ops, &timestamp))
        .await
        .map_err(|e| format!("sıfırlama görevi çöktü: {e}"))?;
    match result {
        Ok(backup) => {
            log_line(&app, &format!("secrets storage reset; backup: {backup:?}"));
            app.restart()
        }
        Err(e) => {
            log_line(&app, &format!("secrets storage reset failed: {e}"));
            Err(e)
        }
    }
}

async fn spawn_sidecar(app: &AppHandle, cfg: &VaultConfig) -> Result<SidecarOutcome, String> {
    let state = app.state::<SidecarState>();
    {
        // A second `spawn_sidecar` call (e.g. the splash page's `main()`
        // re-running after a webview reload) must not spawn a duplicate
        // node.exe: the state-storage at the end of this function
        // unconditionally overwrites `state.guard`, and dropping the OLD
        // ProcessGuard kills the OLD process tree (Windows: its Job has
        // `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` set, so the kernel silently
        // terminates the still-healthy child; Unix: SIGKILL to its group).
        // If one is already running, hand back its URL instead of spawning
        // a second one.
        let mut child_guard = state.child.lock().unwrap();
        if let Some(child) = child_guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                if let Some(url) = state.url.lock().unwrap().clone() {
                    return Ok(SidecarOutcome::Started(url));
                }
            }
        }
    }

    // See resolve_and_verify_node's doc comment — a wrong-major Node is
    // reported back as a NodeProblem (a normal, UI-visible outcome the
    // splash renders its own panel for), not as a generic Err(String).
    let node_bin = match resolve_and_verify_node() {
        Ok(p) => p,
        Err(problem) => {
            log_line(
                app,
                &format!(
                    "node check failed: kind={} found={:?} required={}",
                    problem.kind, problem.found, problem.required
                ),
            );
            return Ok(SidecarOutcome::NodeProblem(problem));
        }
    };

    let resource_dir = strip_verbatim_prefix(&app.path().resource_dir().map_err(|e| {
        let msg = format!("resource_dir() başarısız: {e}");
        log_line(app, &msg);
        msg
    })?);
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

    let app_data_dir = strip_verbatim_prefix(&app.path().app_data_dir().map_err(|e| {
        let msg = format!("app_data_dir() başarısız: {e}");
        log_line(app, &msg);
        msg
    })?);
    std::fs::create_dir_all(&app_data_dir).map_err(|e| {
        let msg = format!("app_data_dir oluşturulamadı: {e}");
        log_line(app, &msg);
        msg
    })?;
    let skills_dir = app_data_dir.join("skills");

    // L2 — see secrets_key.rs for the per-OS key store and the fail-closed
    // rules. The result is passed on as SECRETS_PROTECTION (+ SECRETS_KEY_HEX
    // when encrypted); a problem here never blocks startup, but a key that
    // exists and cannot be read yields "locked" instead of a regenerated key.
    // Blocking IO (D-Bus / Keychain, possibly an unlock prompt) — keep it off
    // the async executor thread.
    let secrets_dir = app_data_dir.clone();
    let secrets_protection = tauri::async_runtime::spawn_blocking(move || secrets_key::load_secrets_protection(&secrets_dir))
        .await
        .unwrap_or(secrets_key::SecretsProtection::Locked);
    log_line(app, &format!("secrets protection: {}", secrets_protection.env_value()));

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

    // Per-launch session token: the sidecar is reachable over plain HTTP on
    // loopback, which any OTHER local process (not just this app) can also
    // connect to — the token is what lets Node's hooks.server.ts tell "the
    // window Tauri itself just navigated here" apart from some unrelated
    // process probing the same port. Generated fresh on every real spawn
    // (never persisted to disk, unlike the secrets key above), handed
    // to Node via env, and round-tripped back to this window as the `?vc_
    // session=` query param on the FIRST url it's told to navigate to — see
    // this function's `url_with_token` below. Node is expected to read that
    // param, set an HttpOnly cookie from it, and 303-redirect to the
    // token-free URL so the token itself never lingers in the webview's own
    // navigation/session-restore history. Unlike the secrets key, a failure
    // here is NOT treated as best-effort: without a token the sidecar would
    // either have to run unauthenticated (defeats the point) or reject the
    // very first request this app makes to it, so a getrandom failure aborts
    // the spawn instead of silently starting an unusable sidecar.
    let mut session_token_bytes = [0u8; 32];
    getrandom::getrandom(&mut session_token_bytes).map_err(|e| {
        let msg = format!("oturum anahtarı üretilemedi: {e}");
        log_line(app, &msg);
        msg
    })?;
    let session_token = hex_encode(&session_token_bytes);

    // A SECOND, separate per-launch token for the MCP stdio process (mcp/): it
    // lets that process call the sidecar's /api/mcp/* routes (create a vault,
    // stage an import) and nothing else — hooks.server.ts's mcp-gate refuses it
    // on every other path, and the session token above never opens /api/mcp/*.
    // Handed to Node as VC_MCP_TOKEN and published, once the port is known, in
    // <app_data_dir>/mcp-endpoint.json (see write_mcp_endpoint). Unlike the
    // session token this is best-effort: without it the sidecar simply answers
    // 503 on /api/mcp/*, and the rest of the app is unaffected.
    let mcp_token = {
        let mut bytes = [0u8; 32];
        match getrandom::getrandom(&mut bytes) {
            Ok(()) => Some(hex_encode(&bytes)),
            Err(e) => {
                log_line(app, &format!("MCP anahtarı üretilemedi (MCP yazma araçları kapalı): {e}"));
                None
            }
        }
    };

    // DATA_DIR replaces the old LIBRARY_PATH/INDEX_DB_PATH/STUDY_DB_PATH trio
    // (Faz 8) — vaults.ts derives every vault's paths from DATA_DIR/vaults/<id>/
    // itself now, migrating automatically on first launch after the upgrade
    // (see migrateVaults.ts, run from hooks.server.ts). VAULT_PATH is still
    // passed through — it's the folder the first-run picker chose — but is
    // no longer the indexer's root; nothing currently reads it server-side
    // (the Obsidian import dialog still takes its source path as manual
    // user input, not a VAULT_PATH default).
    let mut cmd = Command::new(&node_bin);
    cmd.arg(&entry)
        .current_dir(&server_dir)
        .env("HOST", "127.0.0.1")
        // "0" lets the OS assign a genuinely free port atomically at Node's
        // own bind() call — no separate reserve-then-release step for
        // something else to steal in between (see parse_listening_port).
        .env("PORT", "0")
        .env("DATA_DIR", &app_data_dir)
        .env("VAULT_PATH", &cfg.vault_path)
        .env("PUBLIC_VAULT_NAME", &cfg.vault_name)
        .env("CHATS_DB_PATH", app_data_dir.join("chats.db"))
        .env("SECRETS_PATH", app_data_dir.join("secrets.json"))
        .env("PROVIDERS_PATH", &providers_path)
        .env("SKILLS_DIR", &skills_dir)
        // See the session-token doc comment above — Node's hooks.server.ts
        // accepts either this exact value as an `x-vc-session` header (used
        // by this file's own readiness probe below, before any cookie
        // exists) or the HttpOnly cookie it sets from the URL's query param
        // on first navigation.
        .env("VC_SESSION_TOKEN", &session_token)
        // adapter-node caps request bodies at 512 KB unless told otherwise
        // (its files/handler.js: `parse_as_bytes(env('BODY_SIZE_LIMIT',
        // '512K'))`), so every source upload over that size came back 413
        // before ever reaching the route — a small .docx slipped through
        // while any real .pdf/.pptx/.xlsx did not. The app does its own
        // per-file check at 100 MB (library.ts's MAX_UPLOAD_BYTES); this is
        // the outer backstop, set high enough that a multi-file batch still
        // fits but an absurd body is still refused.
        .env("BODY_SIZE_LIMIT", "1G");
    // Always set; SECRETS_KEY_HEX only accompanies "encrypted" — see
    // secrets.ts's createSecretStore().
    cmd.env("SECRETS_PROTECTION", secrets_protection.env_value());
    if let Some(key_hex) = secrets_protection.key_hex() {
        cmd.env("SECRETS_KEY_HEX", key_hex);
    }
    if let Some(token) = &mcp_token {
        cmd.env("VC_MCP_TOKEN", token);
    }
    // Unix: give the sidecar the same PATH we resolved Node with, so its own
    // python/pandoc/ollama lookups work when launched from Finder/a desktop file.
    #[cfg(unix)]
    {
        log_line(app, &platform::search_path_summary());
        cmd.env("PATH", platform::effective_search_path());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    platform::no_window(&mut cmd);
    // Unix: own session/process group (+ PDEATHSIG on Linux) so the whole
    // tree can be signalled as a unit. No-op on Windows.
    ProcessGuard::prepare(&mut cmd);
    let child = cmd.spawn();

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
    const STDERR_TAIL_MAX_BYTES: usize = 8192;
    let (port_tx, port_rx) = std::sync::mpsc::channel::<u16>();
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                log_line(&app, &format!("[sidecar stdout] {line}"));
                if let Some(port) = parse_listening_port(&line) {
                    let _ = port_tx.send(port);
                }
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
                    // Only used for the timeout branch's inline error text
                    // below — bound it so a chatty/looping crash can't grow
                    // this indefinitely for the rest of the session.
                    if t.len() > STDERR_TAIL_MAX_BYTES {
                        let excess = t.len() - STDERR_TAIL_MAX_BYTES;
                        t.drain(..excess);
                    }
                }
            }
        });
    }

    // Best-effort: a guard failure must not fail the whole spawn — the
    // sidecar is already running, this only affects cleanup on an abnormal
    // exit, which is a narrower gap than not spawning at all. Attached right
    // after spawn (not after readiness) so the timeout path below can also
    // take the whole process tree down.
    let mut guard = match ProcessGuard::attach(&child) {
        Ok(g) => Some(g),
        Err(e) => {
            log_line(app, &format!("process guard attach failed (non-fatal): {e}"));
            None
        }
    };

    let port = match wait_for_sidecar_ready(port_rx, Duration::from_secs(15), &session_token).await {
        Some(p) => p,
        None => {
            ProcessGuard::stop_or_kill(guard.take(), &mut child);
            let stderr_text = stderr_tail.lock().map(|t| t.clone()).unwrap_or_default();
            log_line(app, &format!("port never opened; child stderr: {stderr_text}"));
            return Err(format!("Sunucu 15 saniye içinde başlamadı.\n{stderr_text}"));
        }
    };

    let url = format!("http://127.0.0.1:{port}");

    // Tell the MCP process where this sidecar is (best-effort — see mcp_token above).
    if let Some(token) = &mcp_token {
        if let Err(e) = write_mcp_endpoint(&app_data_dir, &url, token, child.id()) {
            log_line(app, &format!("mcp-endpoint.json yazılamadı (non-fatal): {e}"));
        }
    }

    // Grants IPC access (core commands + the specific custom app commands
    // listed below, each requiring its own "allow-*" ACL permission — see
    // build.rs's `AppManifest::commands` doc comment for why that's
    // required at all) to exactly THIS sidecar's origin, for exactly this
    // launch. Static `capabilities/default.json` used to carry a
    // `"remote": {"urls": ["http://127.0.0.1:*"]}}` block instead, which
    // granted the same IPC surface to ANY page on ANY loopback port — since
    // `PORT=0` means the sidecar's actual port is only known here, at
    // runtime, a wildcard was the only way a static capability file could
    // have covered it at all.
    {
        let mut cap_origin = state.capability_origin.lock().unwrap();
        if cap_origin.as_deref() != Some(url.as_str()) {
            let capability = sidecar_remote_capability(url.clone());
            if let Err(e) = app.add_capability(capability) {
                // Not treated as fatal: the sidecar itself is already up and
                // working (core commands like window/event/dialog/opener
                // still come from the LOCAL capability the splash page
                // loaded with, which is never revoked), this only means the
                // page won't be able to reach custom app commands over IPC
                // — logged loudly since that's a real functional gap, not a
                // security one.
                log_line(app, &format!("add_capability(sidecar-remote) failed (non-fatal): {e}"));
            } else {
                *cap_origin = Some(url.clone());
            }
        }
    }

    *state.child.lock().unwrap() = Some(child);
    *state.guard.lock().unwrap() = guard;
    *state.url.lock().unwrap() = Some(url.clone());

    // The one-time token rides ONLY on the url handed back from an ACTUAL
    // spawn (this return), never on `state.url` (see that field's doc
    // comment) — Node reads `?vc_session=`, sets an HttpOnly cookie from it,
    // and 303-redirects to the token-free `url` so the token itself never
    // ends up in the webview's navigation history.
    let url_with_token = format!("{url}/?vc_session={session_token}");
    Ok(SidecarOutcome::Started(url_with_token))
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
            node_problem: None,
        }),
        Some(cfg) => match spawn_sidecar(&app, &cfg).await? {
            SidecarOutcome::Started(url) => Ok(StartResult {
                needs_config: false,
                url: Some(url),
                node_problem: None,
            }),
            SidecarOutcome::NodeProblem(problem) => Ok(StartResult {
                needs_config: false,
                url: None,
                node_problem: Some(problem),
            }),
        },
    }
}

/// Called by the splash page's first-run form once the user picks a vault
/// folder (via @tauri-apps/plugin-dialog on the JS side) and confirms.
/// Returns the same `StartResult` shape `check_and_start` does (rather than
/// a bare URL string, as before this stage) so a Node problem hit on THIS
/// path — a first-run user whose machine has no/wrong-major Node — gets the
/// exact same dedicated panel instead of the generic error box.
#[tauri::command]
async fn save_vault_config_and_start(
    app: AppHandle,
    vault_path: String,
    vault_name: String,
) -> Result<StartResult, String> {
    let cfg = VaultConfig {
        vault_path,
        vault_name,
    };
    write_config(&app, &cfg)?;
    match spawn_sidecar(&app, &cfg).await? {
        SidecarOutcome::Started(url) => Ok(StartResult {
            needs_config: false,
            url: Some(url),
            node_problem: None,
        }),
        SidecarOutcome::NodeProblem(problem) => Ok(StartResult {
            needs_config: false,
            url: None,
            node_problem: Some(problem),
        }),
    }
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

/// Reduces a caller-supplied suggested filename to just its file-name
/// component — e.g. `"../../secrets/notes.md"` -> `"notes.md"`. Used by
/// `save_text_file` before ever handing the string to the dialog's
/// `set_file_name()`: that string only ever seeds the SAVE DIALOG's default
/// filename box (the user still explicitly confirms/edits it and picks the
/// real destination folder), so this isn't closing an actual path-escape —
/// there is none, the dialog owns the destination — but it does stop a
/// crafted suggestion from pre-filling the box with something that reads as
/// a path instead of a plain filename. Falls back to a fixed default rather
/// than an empty string so the dialog never opens with a blank name.
fn sanitize_suggested_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "export".to_string())
}

/// Opens the native "Save As" dialog itself (Rust side) and writes `contents`
/// to whatever path the user picks — replaces the old `write_text_file`,
/// which took a raw destination `path` string straight from the webview's
/// `invoke()` call. That command's doc comment assumed the path could only
/// ever arrive there via the frontend's own `@tauri-apps/plugin-dialog`
/// `save()` picker, but nothing in the IPC layer enforced that: ANY script
/// running in the webview (not just ExportMenu's own code) could call
/// `invoke('write_text_file', { path: 'C:\\Users\\...\\anything', contents })`
/// directly and overwrite any file the current user can write to. Doing the
/// picker round-trip in Rust instead (same pattern as launchers.rs's
/// `pick_launcher_program`/`blocking_pick_file`) means the destination is
/// always a path the user just chose in a native OS dialog, never a string
/// the caller supplies — the webview only ever gets to suggest a starting
/// filename and content, not a destination.
///
/// `extension` is validated to be exactly `"md"` or `"json"` — the only two
/// formats ExportMenu ever exports — so the file-type filter itself can't
/// become another caller-controlled string. `suggested_name` is reduced to
/// its bare file-name component first (see `sanitize_suggested_name`).
///
/// Returns `Ok(None)` when the user dismisses the dialog without choosing a
/// location (an ordinary outcome — matches the old
/// `@tauri-apps/plugin-dialog` `save()` contract the frontend already
/// handles) and `Ok(Some(path))` with the path actually written to.
#[tauri::command]
async fn save_text_file(
    app: AppHandle,
    suggested_name: String,
    extension: String,
    contents: String,
) -> Result<Option<String>, String> {
    if extension != "md" && extension != "json" {
        return Err(format!("Desteklenmeyen dosya uzantısı: {extension}"));
    }
    let filter_name = if extension == "md" { "Markdown" } else { "JSON" };
    let file_name = sanitize_suggested_name(&suggested_name);

    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(&file_name)
            .add_filter(filter_name, &[extension.as_str()])
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("kaydetme görevi başarısız: {e}"))?;

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| format!("seçilen yol çözümlenemedi: {e}"))?;
    std::fs::write(&path, contents).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(SidecarState {
            child: Mutex::new(None),
            guard: Mutex::new(None),
            url: Mutex::new(None),
            capability_origin: Mutex::new(None),
        })
        .manage(launchers::LauncherState::new())
        .manage(winget::WingetState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            check_and_start,
            save_vault_config_and_start,
            recheck_node,
            get_vault_config,
            update_vault_config,
            save_text_file,
            reset_secrets_storage,
            launchers::detect_local_servers,
            launchers::list_launchers,
            launchers::save_launcher,
            launchers::delete_launcher,
            launchers::pick_launcher_program,
            launchers::redetect_launcher_program,
            launchers::start_launcher,
            launchers::stop_launcher,
            launchers::launcher_status,
            winget::winget_install,
            winget::winget_available
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

            // Safety net for tauri.conf.json's "visible": false — the window
            // is meant to be shown by the frontend (splash/index.html
            // immediately, or +layout.svelte's onMount once a dev-mode
            // launch has actually painted content) the moment there's
            // something real to show instead of a blank/white flash. If
            // that JS never runs at all (a genuine bug — bundle failed to
            // load, uncaught error before the show() call), the window must
            // not stay hidden forever with no way for the user to even see
            // an error. is_visible() is checked right before forcing it, so
            // this never fights a window the frontend already showed (the
            // normal case) or one the user closed in the meantime.
            if let Some(window) = app.get_webview_window("main") {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    if matches!(window.is_visible(), Ok(false)) {
                        let _ = window.show();
                    }
                });
            }

            // Local-server launcher seed + auto-start (Aşama 1) — spawned as
            // its own task rather than awaited here, so a slow `where`/WSL
            // detection pass can never delay this setup() closure returning,
            // which would in turn delay the sidecar/splash flow above.
            let launchers_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                launchers::startup(launchers_app_handle).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            stop_all_children(app_handle);
        }
    });
}

#[cfg(test)]
mod node_version_tests {
    use super::{parse_node_major_version, required_node_major};

    #[test]
    fn parses_standard_v_prefixed_version() {
        assert_eq!(parse_node_major_version("v22.11.0"), Some(22));
    }

    #[test]
    fn parses_a_different_major_and_minor() {
        assert_eq!(parse_node_major_version("v20.1.0"), Some(20));
    }

    #[test]
    fn parses_without_a_leading_v() {
        assert_eq!(parse_node_major_version("22.1.0"), Some(22));
    }

    #[test]
    fn trims_surrounding_whitespace_and_trailing_newline() {
        assert_eq!(parse_node_major_version("  v22.11.0\n"), Some(22));
    }

    #[test]
    fn garbage_input_yields_none() {
        assert_eq!(parse_node_major_version("not a version"), None);
        assert_eq!(parse_node_major_version(""), None);
        assert_eq!(parse_node_major_version("v"), None);
        assert_eq!(parse_node_major_version("."), None);
    }

    /// This build's own embedded VAULTCHAT_NODE_MAJOR (via build.rs) must
    /// itself be parseable back into a sane major — otherwise
    /// required_node_major()'s `unwrap_or(22)` fallback would be silently
    /// masking a build.rs bug rather than this test catching it directly.
    #[test]
    fn required_node_major_is_a_plausible_value() {
        let major = required_node_major();
        assert!((16..=99).contains(&major), "implausible required Node major: {major}");
    }
}
