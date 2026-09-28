//! Aşama 1 — local server detection + launchers.
//!
//! This module gives the Rust/Tauri side (and ONLY this side — see the
//! module-level security note below) the ability to:
//!   - detect whether a known local-LLM-server kind (Ollama, LM Studio,
//!     llama.cpp, Jan, LocalAI, vLLM-via-WSL) is installed and/or already
//!     running on its default port,
//!   - persist a small per-kind "launcher" config (program path + argv +
//!     port + auto_start + optional model reference) in
//!     `app_data_dir/launchers.json`,
//!   - start/stop a launcher as a child process we own and track, mirroring
//!     the Job Object + CREATE_NO_WINDOW pattern `spawn_sidecar` in lib.rs
//!     already uses for the Node sidecar.
//!
//! SECURITY BOUNDARY: the Node sidecar has no API into anything in this
//! module. `program` (the exe path Command::new() is given) can only ever
//! come from (a) our own detection logic below, resolving fixed
//! well-known install locations or `where`/`wsl -e which`, or (b) a native
//! file-picker dialog opened from RUST via tauri-plugin-dialog's Rust API
//! (see `pick_launcher_program`) — never from a raw string the webview (or,
//! transitively, anything the Node sidecar could feed the webview) hands
//! over directly. `save_launcher` deliberately has no `program` parameter
//! for exactly this reason. Every spawn here also goes straight through
//! `std::process::Command` with argv as a `Vec<String>` — no shell, no
//! string-joined command line, ever.
//!
//! `args` is normally webview-settable (via `save_launcher`) — EXCEPT for
//! `vllm`, whose `program` is `wsl.exe`: if its args were configurable, a
//! caller could set them to something like `["-e","sh","-c","..."]` and get
//! arbitrary code execution through us, which breaks the very boundary this
//! module exists to hold (the Node sidecar serves the webview, so this
//! would transitively let the sidecar cause process execution). So
//! `save_launcher` unconditionally rejects `args: Some(_)` for `vllm`, and
//! `validate_launcher_config` re-checks at spawn time that a `vllm`
//! launcher's stored `args` are byte-for-byte the catalog's fixed
//! `default_args` — closing the same hole for a hand-edited launchers.json.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use win32job::Job;

use crate::{http_probe_ok, log_line, CREATE_NO_WINDOW};

/// Placeholder argv tokens substituted at start time — see
/// `build_effective_args`. Kept as single argv elements throughout (never
/// concatenated into a string and re-split), so a model path/name containing
/// spaces is never accidentally broken into multiple arguments.
const MODEL_PATH_PLACEHOLDER: &str = "<gguf>";
const MODEL_NAME_PLACEHOLDER: &str = "<model>";
/// Substituted with the launcher's configured `port` at start time — see
/// `build_effective_args`. Without this, a user changing `port` via
/// `save_launcher` would silently desync the actual `--port <N>` flag the
/// child is started with from the port `start_launcher_by_id` waits on.
const PORT_PLACEHOLDER: &str = "<port>";
/// Substituted with `"127.0.0.1:<port>"` (loopback host + the launcher's
/// configured port, joined into ONE string) at start time — see
/// `build_effective_args`. Only used for LocalAI's `--address` flag, which
/// (unlike every other kind here) takes a single `host:port` argv element
/// rather than separate `--host`/`--port` flags. Still obeys the same
/// one-placeholder-one-argv-element rule as `PORT_PLACEHOLDER`: the host part
/// is a fixed literal we build here, never something read from `cfg`, so
/// there's no user-controlled string to accidentally split.
const ADDR_PLACEHOLDER: &str = "<addr>";

/// One entry per local-server kind this app knows how to detect and (when
/// `launchable`) start/stop itself. Pure data — constructing/reading this
/// table does no I/O or process execution.
///
/// Winget ids below were checked with `winget show --id <id> -e` while
/// building this module (all four resolved on this machine: Ollama.Ollama,
/// ElementLabs.LMStudio, ggml.llamacpp, Jan.Jan) — see the Aşama 1 report
/// for the full output. They are still "unverified" in the sense that
/// Aşama 2 (actual install flow) should re-check them, since a winget
/// manifest id can be retired/renamed between now and then.
struct CatalogEntry {
    id: &'static str,
    display_name: &'static str,
    /// Default port this kind's API listens on. For llama.cpp specifically,
    /// the embedding variant uses a different port (8081) so a normal
    /// llama.cpp instance and an embedding-only instance can run side by
    /// side.
    port: u16,
    /// False for Jan: it's a GUI app whose API server is a toggle inside
    /// the app itself, not something we can reliably drive by argv. This
    /// stage only detects Jan's install location.
    launchable: bool,
    winget_id: Option<&'static str>,
    download_url: &'static str,
    /// Argv this kind is started with, before placeholder substitution.
    /// Empty for `launchable: false` entries.
    default_args: &'static [&'static str],
    /// Argv to run (against the SAME `program`) to ask this kind to shut
    /// down gracefully, when the Job Object's kill-on-close can't do it —
    /// currently only LM Studio: `lms server start` detaches and returns
    /// immediately (the real server keeps running as its own process, not
    /// as a child our Job would catch), so `lms server stop` is the only
    /// way we can ask it to exit.
    stop_args: Option<&'static [&'static str]>,
}

static CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        // `ollama serve` has no `--port` flag — the port it binds is set
        // via the `OLLAMA_HOST` env var, applied in `start_launcher_by_id`
        // specifically for this id (`env OLLAMA_HOST=127.0.0.1:<port>`)
        // rather than through argv substitution like the other kinds.
        id: "ollama",
        display_name: "Ollama",
        port: 11434,
        launchable: true,
        winget_id: Some("Ollama.Ollama"),
        download_url: "https://ollama.com/download",
        default_args: &["serve"],
        stop_args: None,
    },
    CatalogEntry {
        // Aşama 2a: confirmed via https://lmstudio.ai/docs/cli/server-start
        // (the "Options" section of `lms server start`) that it takes both
        // `--port <number>` ("Port to run the server on. If not provided,
        // uses the last used port") and `--bind <string>` ("Network address
        // to bind the server to. Use \"0.0.0.0\" to listen on all IPv4
        // interfaces, or \"127.0.0.1\" (default) for localhost only. Can
        // also be set via the LMS_SERVER_HOST environment variable.").
        // `--bind` already defaults to loopback, so pinning it here isn't
        // strictly required by that default — it's set explicitly anyway,
        // matching how every other launchable entry in this catalog states
        // its bind address as a literal argv element rather than leaning on
        // an upstream default that could change between LM Studio versions.
        id: "lmstudio",
        display_name: "LM Studio",
        port: 1234,
        launchable: true,
        winget_id: Some("ElementLabs.LMStudio"),
        download_url: "https://lmstudio.ai",
        default_args: &["server", "start", "--bind", "127.0.0.1", "--port", PORT_PLACEHOLDER],
        stop_args: Some(&["server", "stop"]),
    },
    CatalogEntry {
        id: "llamacpp",
        display_name: "llama.cpp",
        port: 8080,
        launchable: true,
        winget_id: Some("ggml.llamacpp"),
        download_url: "https://github.com/ggml-org/llama.cpp/releases",
        default_args: &["-m", MODEL_PATH_PLACEHOLDER, "--host", "127.0.0.1", "--port", PORT_PLACEHOLDER],
        stop_args: None,
    },
    // Separate catalog id (rather than an `embedding: bool` flag on one
    // "llamacpp" entry) so it gets its own independent launcher config —
    // own port, own auto_start, own running child — and can run at the
    // same time as a normal llama.cpp instance. Both wrap the same
    // `llama-server` binary.
    CatalogEntry {
        id: "llamacpp-embed",
        display_name: "llama.cpp (embedding)",
        port: 8081,
        launchable: true,
        winget_id: Some("ggml.llamacpp"),
        download_url: "https://github.com/ggml-org/llama.cpp/releases",
        default_args: &[
            "-m",
            MODEL_PATH_PLACEHOLDER,
            "--host",
            "127.0.0.1",
            "--port",
            PORT_PLACEHOLDER,
            "--embedding",
        ],
        stop_args: None,
    },
    CatalogEntry {
        id: "jan",
        display_name: "Jan",
        port: 1337,
        launchable: false,
        winget_id: Some("Jan.Jan"),
        download_url: "https://jan.ai",
        default_args: &[],
        stop_args: None,
    },
    CatalogEntry {
        // Aşama 2a: confirmed directly from LocalAI's own CLI flag
        // definition (core/cli/run.go in mudler/LocalAI —
        // https://github.com/mudler/LocalAI/blob/master/core/cli/run.go):
        // `Address string `env:"LOCALAI_ADDRESS,ADDRESS" default:":8080" ...``
        // — i.e. `--address` (env `LOCALAI_ADDRESS`/`ADDRESS`) defaults to
        // `:8080`, a wildcard bind on ALL interfaces, not loopback. That is
        // exactly the security issue this catalog otherwise avoids for
        // every other kind (each of which explicitly pins 127.0.0.1), so
        // `--address` is set explicitly here to `127.0.0.1:<port>` — one
        // argv element via ADDR_PLACEHOLDER, since `--address` (unlike
        // `--host`/`--port` on the other kinds) takes a single combined
        // `host:port` value rather than two separate flags.
        id: "localai",
        display_name: "LocalAI",
        port: 8080,
        launchable: true,
        // No winget package for LocalAI as of this writing — it's normally
        // distributed as a Docker image. Detecting a `docker`-hosted
        // LocalAI is out of scope for this stage (see the Aşama 1 report);
        // only a `local-ai` binary directly on PATH is detected.
        winget_id: None,
        download_url: "https://localai.io",
        default_args: &["run", "--address", ADDR_PLACEHOLDER],
        stop_args: None,
    },
    CatalogEntry {
        id: "vllm",
        display_name: "vLLM (WSL)",
        port: 8000,
        launchable: true,
        winget_id: None,
        download_url: "https://docs.vllm.ai",
        // `program` for this entry is wsl.exe itself (see
        // `detect_installed_path`'s "vllm" arm) — `-e vllm serve ...` runs
        // the real server as a WSL-side process wrapped by wsl.exe on the
        // Windows side. See `shutdown_all`'s doc comment for why "stops on
        // exit" isn't guaranteed for this one.
        //
        // SECURITY: this is the ONLY entry whose `args` are locked — see
        // the module doc comment. Never add a webview-settable `args` path
        // for this id.
        default_args: &[
            "-e",
            "vllm",
            "serve",
            MODEL_NAME_PLACEHOLDER,
            "--host",
            "127.0.0.1",
            "--port",
            PORT_PLACEHOLDER,
        ],
        stop_args: None,
    },
];

fn catalog_entry(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|e| e.id == id)
}

/// `(winget_id, download_url)` for every catalog entry that has a winget
/// package — the single source of truth `winget.rs`'s install allowlist is
/// built from (plus its own few hardcoded extra ids for things this catalog
/// doesn't otherwise know about, like Node.js itself). Deriving from
/// `CATALOG` here, rather than a second hand-maintained list in winget.rs,
/// means a future catalog change (new entry, retired winget id) can't leave
/// that allowlist silently stale.
pub(crate) fn winget_catalog_entries() -> Vec<(&'static str, &'static str)> {
    CATALOG.iter().filter_map(|e| e.winget_id.map(|id| (id, e.download_url))).collect()
}

/// Per-launcher persisted config — `app_data_dir/launchers.json` holds a
/// `Vec` of these. See the module doc comment: `program` only ever gets
/// written by `upsert_launcher_program` (called from `pick_launcher_program`
/// / `redetect_launcher_program`), never by a command that takes it as a
/// plain parameter from the webview.
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct LauncherConfig {
    id: String,
    program: String,
    args: Vec<String>,
    port: u16,
    auto_start: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

/// What `detect_local_servers` reports for one catalog entry.
#[derive(Serialize, Clone)]
pub(crate) struct DetectedServer {
    id: String,
    display_name: String,
    port: u16,
    launchable: bool,
    winget_id: Option<String>,
    download_url: String,
    installed: Option<String>,
    running: bool,
    identified_as: Option<String>,
}

/// A child process we spawned and are tracking, plus what's needed to stop
/// it cleanly.
struct OwnedProc {
    child: Child,
    /// Kill-on-close Job Object — see `create_job_for`. `None` only when
    /// Job Object setup itself failed (logged, non-fatal); the child still
    /// runs and is still tracked.
    job: Option<Job>,
    /// (program, args) to run to ask this launcher to shut down gracefully
    /// — currently only set for LM Studio. `None` means a plain
    /// `child.kill()` (+ Job kill-on-close for the whole tree) is enough.
    stop: Option<(String, Vec<String>)>,
    /// True for launcher kinds whose start command intentionally exits
    /// right after handing off to a detached real server process (LM
    /// Studio). `launcher_status`'s "ours" rule treats such a launcher as
    /// still ours even though `child.try_wait()` no longer returns
    /// `Ok(None)`.
    detached: bool,
}

/// Managed state: every process this app itself spawned via `start_launcher`
/// (or auto-start), keyed by catalog id. Never anything the user started
/// externally — `start_launcher` refuses to spawn a second instance if the
/// port already answers, and `stop_launcher`/`launcher_status` only ever
/// look at what's in this map.
pub(crate) struct LauncherState {
    procs: Mutex<HashMap<String, OwnedProc>>,
    /// Ids currently in the middle of a `start_launcher_by_id` call — see
    /// `reserve_starting`. Guards against the double-start race where two
    /// concurrent start attempts for the same id (e.g. auto-start at
    /// startup racing a user clicking "Start") both see the port closed and
    /// both spawn, with the second `procs.insert` silently overwriting —
    /// and thereby dropping the kill-on-close Job of — the first, healthy
    /// child.
    starting: Mutex<HashSet<String>>,
}

impl LauncherState {
    pub(crate) fn new() -> Self {
        Self {
            procs: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashSet::new()),
        }
    }
}

/// Pure claim/release pair over a plain `Mutex<HashSet<String>>`, split out
/// from `reserve_starting`/`StartingGuard` (which need an `AppHandle`) so
/// the actual reservation logic is unit-testable on its own.
fn try_claim_starting(starting: &Mutex<HashSet<String>>, id: &str) -> bool {
    let mut guard = starting.lock().unwrap();
    if guard.contains(id) {
        return false;
    }
    guard.insert(id.to_string());
    true
}

fn release_starting(starting: &Mutex<HashSet<String>>, id: &str) {
    starting.lock().unwrap().remove(id);
}

/// RAII guard for a claimed `starting` reservation — removes it on every
/// exit path from `start_launcher_by_id` (an early `?` return, an explicit
/// `return Err(...)`, or falling off the end after a successful start),
/// since `Drop::drop` always runs regardless of which path was taken.
struct StartingGuard {
    app: AppHandle,
    id: String,
}

impl Drop for StartingGuard {
    fn drop(&mut self) {
        let state = self.app.state::<LauncherState>();
        release_starting(&state.starting, &self.id);
    }
}

/// Attempts to claim `id` for the duration of one `start_launcher_by_id`
/// call. Returns `None` if another call for the same id is already in
/// progress — the caller treats that as "nothing to do", not an error.
fn reserve_starting(app: &AppHandle, id: &str) -> Option<StartingGuard> {
    let state = app.state::<LauncherState>();
    if try_claim_starting(&state.starting, id) {
        Some(StartingGuard {
            app: app.clone(),
            id: id.to_string(),
        })
    } else {
        None
    }
}

fn launchers_path(app: &AppHandle) -> Result<PathBuf, String> {
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
    Ok(dir.join("launchers.json"))
}

fn launcher_log_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir() başarısız: {e}"))?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("log dizini oluşturulamadı: {e}"))?;
    Ok(dir.join(format!("launcher-{id}.log")))
}

/// Pure parse step, shared by `read_launchers` and its unit tests. An
/// unparseable file is treated exactly like `read_config`'s handling of a
/// corrupt config.json: log it (when an `AppHandle` is available — tests
/// pass `None`) and fall back to an empty list rather than surfacing a raw
/// serde error the user has no way to act on.
fn parse_launchers_or_empty(raw: &str, app_for_log: Option<&AppHandle>) -> Vec<LauncherConfig> {
    match serde_json::from_str(raw) {
        Ok(list) => list,
        Err(e) => {
            if let Some(app) = app_for_log {
                log_line(app, &format!("launchers.json is unparseable ({e}), treating as empty"));
            }
            Vec::new()
        }
    }
}

fn read_launchers(app: &AppHandle) -> Result<Vec<LauncherConfig>, String> {
    let path = launchers_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        let msg = format!("launchers.json okunamadı: {e}");
        log_line(app, &msg);
        msg
    })?;
    Ok(parse_launchers_or_empty(&raw, Some(app)))
}

/// Write-tmp-then-rename so a crash/power-loss mid-write can never leave
/// launchers.json half-written and unparseable — `rename` on the same
/// volume is atomic from the filesystem's point of view.
fn write_launchers_atomic(path: &Path, launchers: &[LauncherConfig]) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(launchers).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Generalizes `resolve_node_binary`'s `where` + WindowsApps-stub-filtering
/// caution to an arbitrary binary name.
fn resolve_via_where(exe_name: &str) -> Option<PathBuf> {
    let output = Command::new("where")
        .arg(exe_name)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.to_lowercase().contains("windowsapps"))
        .map(PathBuf::from)
        .find(|p| p.exists())
}

fn resolve_wsl_exe() -> Option<PathBuf> {
    if let Ok(sysroot) = std::env::var("SystemRoot") {
        let p = PathBuf::from(sysroot).join("System32").join("wsl.exe");
        if p.exists() {
            return Some(p);
        }
    }
    resolve_via_where("wsl")
}

/// `wsl.exe -e which vllm` under a hard ~3s timeout: spawn, then poll
/// `try_wait` rather than a blocking `wait()`, so a hung/misconfigured WSL
/// distro can't stall the whole detection pass. Returns wsl.exe's own path
/// (not something inside the WSL filesystem) — that's what `program` is set
/// to for a vLLM launcher, since wsl.exe is the actual Windows-side process
/// we spawn.
fn detect_vllm_wsl() -> Option<PathBuf> {
    let wsl_path = resolve_wsl_exe()?;
    let mut child = Command::new(&wsl_path)
        .args(["-e", "which", "vllm"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Some(wsl_path) } else { None },
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(3) {
                    let _ = child.kill();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

/// Where each catalog entry is actually installed, if at all. Every branch
/// ends in either a fixed-location `.exists()` check or `resolve_via_where`
/// (which itself checks existence + filters WindowsApps stubs) — never a
/// bare "the command name is probably on PATH" assumption.
fn detect_installed_path(id: &str) -> Option<PathBuf> {
    match id {
        "ollama" => {
            if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                let p = PathBuf::from(local_app_data).join("Programs").join("Ollama").join("ollama.exe");
                if p.exists() {
                    return Some(p);
                }
            }
            resolve_via_where("ollama")
        }
        "lmstudio" => {
            if let Ok(user_profile) = std::env::var("USERPROFILE") {
                let p = PathBuf::from(user_profile).join(".lmstudio").join("bin").join("lms.exe");
                if p.exists() {
                    return Some(p);
                }
            }
            resolve_via_where("lms")
        }
        "llamacpp" | "llamacpp-embed" => resolve_via_where("llama-server"),
        "jan" => {
            let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
            for candidate in ["jan", "Jan"] {
                let p = PathBuf::from(&local_app_data).join("Programs").join(candidate).join("Jan.exe");
                if p.exists() {
                    return Some(p);
                }
            }
            None
        }
        "localai" => resolve_via_where("local-ai"),
        "vllm" => detect_vllm_wsl(),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Ollama,
    LlamaCpp,
    OpenAiCompatible,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Ollama => "ollama",
            Kind::LlamaCpp => "llamacpp",
            Kind::OpenAiCompatible => "openai-compatible",
        }
    }
}

/// One already-fetched HTTP response, as `classify` needs it. Kept as a
/// plain owned struct (rather than borrowing) so tests can build fixtures
/// inline without lifetime gymnastics.
#[derive(Debug, Clone)]
struct ProbeResult {
    path: String,
    status: u16,
    body: String,
}

fn find_probe<'a>(responses: &'a [ProbeResult], path: &str) -> Option<&'a ProbeResult> {
    responses.iter().find(|r| r.path == path)
}

/// Pure classifier over already-fetched (path, status, body) tuples — no
/// network I/O, fully unit-testable with fixtures. Disambiguates the two
/// servers that commonly share port 8080 (llama.cpp vs LocalAI/other
/// OpenAI-compatible servers) by checking llama.cpp's distinctive `/props`
/// shape before falling back to the generic `/v1/models` check.
fn classify(responses: &[ProbeResult]) -> Option<Kind> {
    if let Some(r) = find_probe(responses, "/") {
        if r.status == 200 && r.body.contains("Ollama is running") {
            return Some(Kind::Ollama);
        }
    }
    if let Some(r) = find_probe(responses, "/api/tags") {
        if r.status == 200 {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&r.body) {
                if v.get("models").and_then(|m| m.as_array()).is_some() {
                    return Some(Kind::Ollama);
                }
            }
        }
    }
    if let Some(r) = find_probe(responses, "/props") {
        if r.status == 200 {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&r.body) {
                if v.get("default_generation_settings").is_some() {
                    return Some(Kind::LlamaCpp);
                }
            }
        }
    }
    // Weaker combined signal: llama.cpp's `/health` alone (`{"status":"ok"}`)
    // isn't distinctive by itself — plenty of OpenAI-compatible servers have
    // an identical-looking health endpoint — so it only counts here paired
    // with `/props` having responded at all (even if its body didn't match
    // above, e.g. an older llama.cpp build with a slightly different shape).
    if let (Some(health), Some(_props)) = (find_probe(responses, "/health"), find_probe(responses, "/props")) {
        if health.status == 200 {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&health.body) {
                if v.get("status").and_then(|s| s.as_str()) == Some("ok") {
                    return Some(Kind::LlamaCpp);
                }
            }
        }
    }
    if let Some(r) = find_probe(responses, "/v1/models") {
        if r.status == 200 {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&r.body) {
                if v.get("data").and_then(|d| d.as_array()).is_some() {
                    return Some(Kind::OpenAiCompatible);
                }
            }
        }
    }
    None
}

/// Finds the first occurrence of `needle` in `haystack`, operating on raw
/// bytes rather than a `str` — used to split headers from body and to walk
/// chunk boundaries in `decode_chunked_body` without needing the body to be
/// valid UTF-8 up to that point (unlike a `str`-level `split_once`, which
/// would need every byte before the split to already form valid UTF-8).
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Decodes an HTTP/1.1 `Transfer-Encoding: chunked` body: repeated
/// `<hex-size>\r\n<data>\r\n` chunks, terminated by a zero-size chunk (RFC
/// 7230 §4.1). Deliberately simple, matching what every server this module
/// classifies actually sends — chunk extensions after a `;` are accepted
/// but ignored, trailing headers after the terminating zero chunk are
/// ignored (none of these servers send trailers), and a truncated/
/// incomplete final chunk (e.g. the read loop's timeout fired mid-chunk)
/// just yields whatever was decoded so far rather than erroring.
fn decode_chunked_body(mut rest: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line_end) = find_subslice(rest, b"\r\n") {
        let size_text = String::from_utf8_lossy(&rest[..line_end]);
        let size_hex = size_text.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_hex, 16) else { break };
        let data_start = line_end + 2;
        if size == 0 {
            break;
        }
        let available = rest.len().saturating_sub(data_start);
        let take = size.min(available);
        out.extend_from_slice(&rest[data_start..data_start + take]);
        if take < size {
            break; // Truncated mid-chunk — nothing more to decode.
        }
        // Skip the chunk data's trailing CRLF before the next size line.
        rest = rest.get(data_start + take + 2..).unwrap_or(&[]);
    }
    out
}

/// Raw-TcpStream HTTP GET — no HTTP crate, matching lib.rs's `http_probe_ok`
/// pattern but returning the status + a body capped at 64 KB instead of a
/// plain bool, since detection needs to actually look at the response to
/// tell servers apart. `Connection: close` means we don't need to bound how
/// long we read by content-length parsing — the peer closes the socket when
/// it's done, which is what ends the read loop below.
///
/// Handles `Transfer-Encoding: chunked` responses via `decode_chunked_body`
/// — some OpenAI-compatible servers (llama.cpp among them, depending on
/// build/config) send `/v1/models` and similar JSON responses chunked, and
/// without decoding it first `serde_json::from_str` in `classify` would
/// just fail silently on the raw `<size>\r\n{...}\r\n0\r\n\r\n` framing.
fn http_get(port: u16, path: &str, timeout: Duration) -> Option<(u16, String)> {
    const MAX_BODY_BYTES: usize = 64 * 1024;

    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;

    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                // Generous headroom past the 64 KB body cap so we still
                // capture headers first; this only bounds a misbehaving/
                // huge response from looping forever, not normal replies.
                if buf.len() >= MAX_BODY_BYTES + 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    let header_end = find_subslice(&buf, b"\r\n\r\n")?;
    let headers = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let status_line = headers.lines().next()?;
    let status: u16 = status_line.split_whitespace().nth(1)?.parse().ok()?;

    let raw_body = &buf[(header_end + 4).min(buf.len())..];
    let is_chunked = headers.lines().any(|l| {
        let lower = l.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    let body_bytes: Vec<u8> = if is_chunked { decode_chunked_body(raw_body) } else { raw_body.to_vec() };
    let capped_body = String::from_utf8_lossy(&body_bytes[..body_bytes.len().min(MAX_BODY_BYTES)]).into_owned();
    Some((status, capped_body))
}

fn probe_paths(port: u16) -> Vec<ProbeResult> {
    const PATHS: &[&str] = &["/", "/api/tags", "/props", "/health", "/v1/models"];
    PATHS
        .iter()
        .filter_map(|p| http_get(port, p, Duration::from_millis(500)).map(|(status, body)| ProbeResult { path: p.to_string(), status, body }))
        .collect()
}

fn detect_one(entry: &CatalogEntry) -> DetectedServer {
    let installed = detect_installed_path(entry.id).map(|p| p.to_string_lossy().to_string());
    // Running check is loopback-HTTP-only, on this entry's own default port
    // — never any other host, and never taken from a launcher's saved
    // config (a hand-edited launchers.json can't make this probe hit
    // anything other than 127.0.0.1).
    let running = http_probe_ok(entry.port, None);
    let identified_as = if running { classify(&probe_paths(entry.port)).map(Kind::as_str).map(str::to_string) } else { None };
    DetectedServer {
        id: entry.id.to_string(),
        display_name: entry.display_name.to_string(),
        port: entry.port,
        launchable: entry.launchable,
        winget_id: entry.winget_id.map(str::to_string),
        download_url: entry.download_url.to_string(),
        installed,
        running,
        identified_as,
    }
}

#[tauri::command]
pub(crate) async fn detect_local_servers(_app: AppHandle) -> Result<Vec<DetectedServer>, String> {
    // One blocking-pool thread per entry so the ~3s WSL timeout and the up-
    // to-five-probes-times-500ms-timeout worst case for a non-responding
    // port don't serialize into N× the wait — see the module's Aşama 1
    // report for the measured worst case.
    let mut handles = Vec::with_capacity(CATALOG.len());
    for entry in CATALOG.iter() {
        handles.push(tauri::async_runtime::spawn_blocking(move || detect_one(entry)));
    }
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        out.push(h.await.map_err(|e| format!("algılama görevi başarısız: {e}"))?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Validation (SECURITY — see the module doc comment)
// ---------------------------------------------------------------------------

fn validate_program_path(path: &Path) -> Result<(), String> {
    let ext_ok = path.extension().map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false);
    if !ext_ok {
        return Err("Program bir .exe dosyası olmalı.".to_string());
    }
    if !path.exists() {
        return Err(format!("Program bulunamadı: {}", path.display()));
    }
    Ok(())
}

fn validate_args(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a.contains('\0')) {
        return Err("Argümanlar NUL karakteri içeremez.".to_string());
    }
    Ok(())
}

/// SECURITY: `vllm`'s `program` is `wsl.exe` (see the module doc comment) —
/// `save_launcher` must never accept a caller-supplied `args` override for
/// it, full stop. `validate_launcher_config` enforces the matching rule at
/// spawn time (args must equal the catalog default exactly), closing the
/// same hole for a hand-edited launchers.json; this function is the
/// earlier, save-time half of the same rule.
fn reject_args_override_for_vllm(id: &str, args: &Option<Vec<String>>) -> Result<(), String> {
    if id == "vllm" && args.is_some() {
        return Err("vLLM için argümanlar değiştirilemez; sabit komut satırı kullanılır.".to_string());
    }
    Ok(())
}

fn validate_port(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("Port 1-65535 aralığında olmalı.".to_string());
    }
    Ok(())
}

fn validate_model_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("Model dosyası bulunamadı: {path}"));
    }
    let ext_ok = p.extension().map(|e| e.eq_ignore_ascii_case("gguf")).unwrap_or(false);
    if !ext_ok {
        return Err("Model dosyası .gguf uzantılı olmalı.".to_string());
    }
    Ok(())
}

fn validate_model_name(name: &str) -> Result<(), String> {
    if name.contains('\0') || name.trim().is_empty() {
        return Err("Model adı geçersiz.".to_string());
    }
    // A model name/id is substituted into argv as its own single element
    // (see build_effective_args), never through a shell — so this isn't
    // about shell metacharacters. It's about the substituted value being
    // readable as a FLAG by the target program itself (e.g. a vLLM
    // "model name" of "-e" or "--some-internal-flag" reaching wsl.exe/vllm
    // as if the user had passed that flag). Rejecting a leading `-`
    // closes that off at the one point where user-controlled text becomes
    // an argv element for a launcher whose other args are otherwise fixed.
    if name.starts_with('-') {
        return Err("Model adı '-' ile başlayamaz.".to_string());
    }
    Ok(())
}

/// True only if `args` is exactly the catalog's `default_args`, element for
/// element (including any not-yet-substituted placeholder tokens) — used to
/// lock `vllm`'s argv to the fixed command line. See the module doc comment.
fn args_match_catalog_default(args: &[String], default_args: &[&str]) -> bool {
    args.len() == default_args.len() && args.iter().zip(default_args.iter()).all(|(a, b)| a == b)
}

/// Re-validates a stored launcher config before every actual spawn — defense
/// in depth against a hand-edited launchers.json, since the file is plain
/// JSON on disk and nothing stops a user from opening it in a text editor.
fn validate_launcher_config(entry: &CatalogEntry, cfg: &LauncherConfig) -> Result<(), String> {
    if cfg.id != entry.id {
        return Err("launcher id kataloğa uymuyor.".to_string());
    }
    validate_program_path(Path::new(&cfg.program))?;
    validate_args(&cfg.args)?;
    validate_port(cfg.port)?;
    // SECURITY: vLLM's `program` is wsl.exe — see the module doc comment.
    // Even a launchers.json hand-edited to look otherwise-valid (right
    // extension, existing file, no NUL bytes) must not be allowed to spawn
    // wsl.exe with anything other than the catalog's own fixed argv.
    if entry.id == "vllm" && !args_match_catalog_default(&cfg.args, entry.default_args) {
        return Err("vLLM launcher argümanları kataloğun sabit komut satırıyla eşleşmiyor; reddedildi.".to_string());
    }
    if let Some(mp) = &cfg.model_path {
        validate_model_path(mp)?;
    }
    if let Some(m) = &cfg.model {
        validate_model_name(m)?;
    }
    Ok(())
}

/// Substitutes the model-path/model-name placeholder tokens with the
/// launcher's configured value, one placeholder token -> exactly one argv
/// element — never a split/joined string, so a path or model name
/// containing spaces still arrives at the child process as a single
/// argument.
fn build_effective_args(entry: &CatalogEntry, cfg: &LauncherConfig) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(cfg.args.len());
    for a in &cfg.args {
        if a == MODEL_PATH_PLACEHOLDER {
            let mp = cfg
                .model_path
                .as_deref()
                .ok_or_else(|| format!("{}: model_path ayarlanmadı.", entry.display_name))?;
            validate_model_path(mp)?;
            out.push(mp.to_string());
        } else if a == MODEL_NAME_PLACEHOLDER {
            let m = cfg.model.as_deref().ok_or_else(|| format!("{}: model adı ayarlanmadı.", entry.display_name))?;
            validate_model_name(m)?;
            out.push(m.to_string());
        } else if a == PORT_PLACEHOLDER {
            out.push(cfg.port.to_string());
        } else if a == ADDR_PLACEHOLDER {
            // Host part is the fixed literal "127.0.0.1" — see
            // ADDR_PLACEHOLDER's doc comment — so this is still exactly one
            // argv element, never a user-controlled string that could
            // itself contain a stray argument boundary.
            out.push(format!("127.0.0.1:{}", cfg.port));
        } else {
            out.push(a.clone());
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Commands: store (list/save/delete/pick/redetect)
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn list_launchers(app: AppHandle) -> Result<Vec<LauncherConfig>, String> {
    read_launchers(&app)
}

/// Patches an EXISTING launcher's args/port/auto_start/model reference.
/// Deliberately has no `program` parameter — see the module doc comment.
/// Errors if no launcher exists yet for `id`, since creating one without a
/// program would leave it unstartable anyway; the frontend is expected to
/// call `pick_launcher_program` or `redetect_launcher_program` first.
#[tauri::command]
pub(crate) async fn save_launcher(
    app: AppHandle,
    id: String,
    args: Option<Vec<String>>,
    port: u16,
    auto_start: bool,
    model_path: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let entry = catalog_entry(&id).ok_or_else(|| format!("Bilinmeyen sunucu türü: {id}"))?;
    reject_args_override_for_vllm(&id, &args)?;
    validate_port(port)?;
    if let Some(a) = &args {
        validate_args(a)?;
    }
    if let Some(mp) = &model_path {
        validate_model_path(mp)?;
    }
    if let Some(m) = &model {
        validate_model_name(m)?;
    }

    let path = launchers_path(&app)?;
    let mut launchers = read_launchers(&app)?;
    let Some(existing) = launchers.iter_mut().find(|l| l.id == id) else {
        return Err(format!(
            "{} için önce bir program seçin ('Program Seç' veya 'Yeniden Algıla').",
            entry.display_name
        ));
    };
    existing.port = port;
    existing.auto_start = auto_start;
    if let Some(a) = args {
        existing.args = a;
    }
    existing.model_path = model_path;
    existing.model = model;
    write_launchers_atomic(&path, &launchers)
}

#[tauri::command]
pub(crate) async fn delete_launcher(app: AppHandle, id: String) -> Result<(), String> {
    catalog_entry(&id).ok_or_else(|| format!("Bilinmeyen sunucu türü: {id}"))?;

    // Best-effort: don't leave an owned process running with no config to
    // ever stop it again. Errors from a not-currently-running launcher are
    // expected and ignored here.
    let _ = stop_launcher(app.clone(), id.clone()).await;

    let path = launchers_path(&app)?;
    let mut launchers = read_launchers(&app)?;
    let before = launchers.len();
    launchers.retain(|l| l.id != id);
    if launchers.len() == before {
        return Err("Silinecek bir launcher bulunamadı.".to_string());
    }
    write_launchers_atomic(&path, &launchers)
}

/// Creates the launcher entry for `entry.id` if it doesn't exist yet
/// (seeded with the catalog's default args/port), or just updates its
/// `program` if it does. The ONLY place `program` is ever written from —
/// called from `pick_launcher_program` (native file picker) and
/// `redetect_launcher_program` (our own detection logic) exclusively.
fn upsert_launcher_program(app: &AppHandle, entry: &CatalogEntry, program: &str) -> Result<(), String> {
    let path = launchers_path(app)?;
    let mut list = read_launchers(app)?;
    if let Some(existing) = list.iter_mut().find(|l| l.id == entry.id) {
        existing.program = program.to_string();
    } else {
        list.push(LauncherConfig {
            id: entry.id.to_string(),
            program: program.to_string(),
            args: entry.default_args.iter().map(|s| s.to_string()).collect(),
            port: entry.port,
            auto_start: false,
            model_path: None,
            model: None,
        });
    }
    write_launchers_atomic(&path, &list)
}

/// Opens a native "choose an .exe" file picker via tauri-plugin-dialog's
/// Rust API — never a path the webview supplies directly (see the module
/// doc comment). `blocking_pick_file` blocks its calling thread until the
/// user closes the dialog, so it's run on the async runtime's blocking pool
/// rather than directly in this command's async body.
#[tauri::command]
pub(crate) async fn pick_launcher_program(app: AppHandle, id: String) -> Result<String, String> {
    let entry = catalog_entry(&id).ok_or_else(|| format!("Bilinmeyen sunucu türü: {id}"))?;

    let app_for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog.dialog().file().add_filter("Çalıştırılabilir", &["exe"]).blocking_pick_file()
    })
    .await
    .map_err(|e| format!("dosya seçme görevi başarısız: {e}"))?;

    let Some(file_path) = picked else {
        return Err("Program seçilmedi.".to_string());
    };
    let path = file_path.into_path().map_err(|e| format!("seçilen yol çözümlenemedi: {e}"))?;
    validate_program_path(&path)?;
    let program = path.to_string_lossy().to_string();
    upsert_launcher_program(&app, entry, &program)?;
    Ok(program)
}

/// Re-runs our own detection for this one entry and stores the result as
/// the launcher's `program` — the "reset to auto-detected" action.
#[tauri::command]
pub(crate) async fn redetect_launcher_program(app: AppHandle, id: String) -> Result<String, String> {
    let entry = catalog_entry(&id).ok_or_else(|| format!("Bilinmeyen sunucu türü: {id}"))?;
    let detected = tauri::async_runtime::spawn_blocking(move || detect_installed_path(entry.id))
        .await
        .map_err(|e| format!("algılama görevi başarısız: {e}"))?;
    let Some(path) = detected else {
        return Err(format!(
            "{} kurulu bulunamadı. Elle seçmek için 'Program Seç' seçeneğini kullanın.",
            entry.display_name
        ));
    };
    validate_program_path(&path)?;
    let program = path.to_string_lossy().to_string();
    upsert_launcher_program(&app, entry, &program)?;
    Ok(program)
}

// ---------------------------------------------------------------------------
// Commands: start/stop/status
// ---------------------------------------------------------------------------

fn create_job_for(app: &AppHandle, child: &Child, id: &str) -> Option<Job> {
    // Best-effort, matching spawn_sidecar's Job Object setup exactly: a
    // failure here must not fail the whole start — it only narrows the
    // cleanup guarantee on an abnormal exit, which is better than not
    // starting at all.
    match Job::create() {
        Ok(job) => {
            let assign = job.query_extended_limit_info().and_then(|mut info| {
                info.limit_kill_on_job_close();
                job.set_extended_limit_info(&info)?;
                job.assign_process(child.as_raw_handle() as isize)
            });
            match assign {
                Ok(()) => Some(job),
                Err(e) => {
                    log_line(app, &format!("Job Object assign failed for launcher {id} (non-fatal): {e}"));
                    None
                }
            }
        }
        Err(e) => {
            log_line(app, &format!("Job Object create failed for launcher {id} (non-fatal): {e}"));
            None
        }
    }
}

/// Last couple KB of a launcher's log file, for inline error messages when a
/// start attempt fails — mirrors spawn_sidecar's `stderr_tail` but read back
/// from the file instead of kept in memory, since here stdout/stderr are
/// redirected straight to files rather than piped + drained.
fn read_log_tail(path: &Path) -> String {
    const TAIL_BYTES: u64 = 4096;
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    use std::io::{Seek, SeekFrom};
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TAIL_BYTES);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = String::new();
    let _ = f.read_to_string(&mut buf);
    buf
}

/// Shared by the `start_launcher` command and the auto-start startup path.
/// Never spawns a second instance of something already answering on its
/// port — that check happens unconditionally, first thing, for every
/// caller.
async fn start_launcher_by_id(app: &AppHandle, id: &str) -> Result<(), String> {
    let entry = catalog_entry(id).ok_or_else(|| format!("Bilinmeyen sunucu türü: {id}"))?;
    if !entry.launchable {
        return Err(format!(
            "{} bu aşamada uygulama tarafından başlatılamıyor; API sunucusu kendi arayüzünden açılmalı.",
            entry.display_name
        ));
    }

    // Claim `id` for the rest of this call. If another start attempt for
    // the same id is already in flight (auto-start at app startup racing a
    // user-initiated `start_launcher`, most plausibly), just no-op — bound
    // to `_reservation` (not `_`) so it stays alive, and therefore keeps
    // `id` claimed, until this function returns by ANY path, `?` included.
    let Some(_reservation) = reserve_starting(app, id) else {
        log_line(app, &format!("start_launcher({id}): a start attempt is already in progress, skipping"));
        return Ok(());
    };

    let launchers = read_launchers(app)?;
    let cfg = launchers
        .into_iter()
        .find(|l| l.id == id)
        .ok_or_else(|| format!("{} için önce bir program seçin.", entry.display_name))?;
    validate_launcher_config(entry, &cfg)?;

    // Never start a second instance, never touch a user-started server:
    // if the port already answers, hand back success without spawning
    // anything, and don't record it as one of ours.
    if http_probe_ok(cfg.port, None) {
        log_line(app, &format!("start_launcher({id}): port {} already answering, treating as external", cfg.port));
        return Ok(());
    }

    let args = build_effective_args(entry, &cfg)?;

    let log_path = launcher_log_path(app, id)?;
    let out_file = std::fs::File::create(&log_path).map_err(|e| format!("günlük dosyası oluşturulamadı: {e}"))?;
    let err_file = out_file.try_clone().map_err(|e| format!("günlük dosyası kopyalanamadı: {e}"))?;

    let mut command = Command::new(&cfg.program);
    command.args(&args).creation_flags(CREATE_NO_WINDOW).stdout(Stdio::from(out_file)).stderr(Stdio::from(err_file));
    // Ollama has no `--port`/`--host` flag of its own — see the catalog
    // entry's doc comment. This is the one place `cfg.port` reaches Ollama
    // at all, so without it, changing `port` via `save_launcher` would
    // silently do nothing for this specific kind.
    if entry.id == "ollama" {
        command.env("OLLAMA_HOST", format!("127.0.0.1:{}", cfg.port));
    }
    let mut child = command.spawn().map_err(|e| format!("{} başlatılamadı: {e}", entry.display_name))?;

    let job = create_job_for(app, &child, id);

    let start = Instant::now();
    let ready = loop {
        // A zero/successful exit before the port ever answers is expected
        // for LM Studio's detach-and-return `lms server start` — the real
        // server keeps running as a separate process. Only a NON-zero exit
        // here is treated as an actual startup failure.
        if let Ok(Some(status)) = child.try_wait() {
            if !status.success() {
                let tail = read_log_tail(&log_path);
                return Err(format!("{} hata ile kapandı ({status}).\n{tail}", entry.display_name));
            }
        }
        if http_probe_ok(cfg.port, None) {
            break true;
        }
        if start.elapsed() > Duration::from_secs(20) {
            break false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    if !ready {
        let _ = child.kill();
        let tail = read_log_tail(&log_path);
        return Err(format!(
            "{} 20 saniye içinde port {} üzerinde yanıt vermedi.\n{tail}",
            entry.display_name, cfg.port
        ));
    }

    let stop = entry.stop_args.map(|a| (cfg.program.clone(), a.iter().map(|s| s.to_string()).collect::<Vec<_>>()));
    let detached = entry.stop_args.is_some();
    let state = app.state::<LauncherState>();
    {
        let mut procs = state.procs.lock().unwrap();
        // Should be unreachable given the reservation above (only one
        // start_launcher_by_id call for this id can ever be past that
        // point at a time) plus the port-probe gate earlier in this same
        // function — but never overwrite a still-alive OwnedProc's insert
        // slot under any circumstance, since that would drop its
        // kill-on-close Job and have the kernel kill a healthy process.
        if let Some(existing) = procs.get_mut(id) {
            if matches!(existing.child.try_wait(), Ok(None)) {
                log_line(app, &format!("start_launcher({id}): a live OwnedProc unexpectedly already exists, refusing to overwrite it"));
                let _ = child.kill();
                return Err(format!("{} için zaten çalışan bir örnek izleniyor.", entry.display_name));
            }
        }
        procs.insert(id.to_string(), OwnedProc { child, job, stop, detached });
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn start_launcher(app: AppHandle, id: String) -> Result<(), String> {
    start_launcher_by_id(&app, &id).await
}

/// Runs a graceful-stop command (LM Studio's `lms server stop`) with a hard
/// ~5s timeout — spawn + poll `try_wait`, kill on timeout, exactly like
/// `detect_vllm_wsl`'s pattern. Best-effort: any failure here is logged,
/// never propagated, since the caller still falls through to `child.kill()`
/// + dropping the Job either way.
fn run_stop_command(app: &AppHandle, id: &str, program: &str, args: &[String]) {
    let child = Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            log_line(app, &format!("stop command for launcher {id} failed to spawn (non-fatal): {e}"));
            return;
        }
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(5) {
                    log_line(app, &format!("stop command for launcher {id} timed out after 5s, killing it"));
                    let _ = child.kill();
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return,
        }
    }
}

/// Stops ONLY a launcher we ourselves started (i.e. currently in
/// `LauncherState`) — a server the user started externally is never
/// touched, and this command errors rather than silently no-op'ing if
/// asked to stop something not in our map.
#[tauri::command]
pub(crate) async fn stop_launcher(app: AppHandle, id: String) -> Result<(), String> {
    catalog_entry(&id).ok_or_else(|| format!("Bilinmeyen sunucu türü: {id}"))?;

    let owned = {
        let state = app.state::<LauncherState>();
        let removed = state.procs.lock().unwrap().remove(&id);
        removed
    };
    let Some(mut owned) = owned else {
        return Err("Bu sunucuyu biz başlatmadık; sadece kendi başlattığımız sunucular durdurulabilir.".to_string());
    };

    if let Some((program, args)) = owned.stop.clone() {
        let app2 = app.clone();
        let id2 = id.clone();
        tauri::async_runtime::spawn_blocking(move || run_stop_command(&app2, &id2, &program, &args))
            .await
            .map_err(|e| format!("durdurma komutu görevi başarısız: {e}"))?;
    }
    let _ = owned.child.kill();
    drop(owned.job); // kill-on-close terminates the whole tree, if it was assigned.
    Ok(())
}

#[tauri::command]
pub(crate) async fn launcher_status(app: AppHandle, id: String) -> Result<String, String> {
    let entry = catalog_entry(&id).ok_or_else(|| format!("Bilinmeyen sunucu türü: {id}"))?;
    let launchers = read_launchers(&app)?;
    let port = launchers.iter().find(|l| l.id == id).map(|l| l.port).unwrap_or(entry.port);

    if !http_probe_ok(port, None) {
        return Ok("stopped".to_string());
    }
    let ours = {
        let state = app.state::<LauncherState>();
        let mut guard = state.procs.lock().unwrap();
        match guard.get_mut(&id) {
            Some(owned) => matches!(owned.child.try_wait(), Ok(None)) || owned.detached,
            None => false,
        }
    };
    Ok(if ours { "running_ours" } else { "running_external" }.to_string())
}

// ---------------------------------------------------------------------------
// Startup (seed + auto-start) / shutdown — called from lib.rs's setup()/run()
// ---------------------------------------------------------------------------

async fn seed_initial_launchers() -> Vec<LauncherConfig> {
    // First-run seed: if Ollama is already installed, offer it pre-
    // configured with auto_start on, since it's by far the most common
    // local server this app's users already have. Nothing else is seeded —
    // every other kind needs an explicit user action (pick/redetect) before
    // it has a `program` to start at all.
    let detected = tauri::async_runtime::spawn_blocking(|| detect_installed_path("ollama")).await.ok().flatten();
    let Some(path) = detected else {
        return Vec::new();
    };
    let entry = catalog_entry("ollama").expect("ollama is always in CATALOG");
    vec![LauncherConfig {
        id: entry.id.to_string(),
        program: path.to_string_lossy().to_string(),
        args: entry.default_args.iter().map(|s| s.to_string()).collect(),
        port: entry.port,
        auto_start: true,
        model_path: None,
        model: None,
    }]
}

/// Called from lib.rs's `setup()` as its own spawned task — must not block
/// the sidecar's own startup or the splash page's `check_and_start` IPC
/// call, which is why this is fired-and-forgotten from `setup()` rather
/// than awaited there.
pub(crate) async fn startup(app: AppHandle) {
    let path = match launchers_path(&app) {
        Ok(p) => p,
        Err(e) => {
            log_line(&app, &format!("launcher startup: {e}"));
            return;
        }
    };

    if !path.exists() {
        let seeded = seed_initial_launchers().await;
        // Written even when empty, so this seeding branch only ever runs
        // once — every later launch sees the file already exists and skips
        // straight to reading it, regardless of whether Ollama was found.
        if let Err(e) = write_launchers_atomic(&path, &seeded) {
            log_line(&app, &format!("launchers.json seed write failed: {e}"));
        }
    }

    let launchers = match read_launchers(&app) {
        Ok(l) => l,
        Err(e) => {
            log_line(&app, &format!("launcher startup: {e}"));
            return;
        }
    };

    // Run every auto_start launcher's start attempt in parallel — each one
    // already skips cleanly if its port is externally occupied
    // (start_launcher_by_id's own check), so there's no ordering
    // requirement between them.
    let mut handles = Vec::new();
    for cfg in launchers.into_iter().filter(|l| l.auto_start) {
        let app = app.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            if let Err(e) = start_launcher_by_id(&app, &cfg.id).await {
                log_line(&app, &format!("auto-start of launcher {} failed: {e}", cfg.id));
            }
        }));
    }
    for h in handles {
        let _ = h.await;
    }
}

/// Called from lib.rs's `RunEvent::ExitRequested` handler, alongside (not
/// instead of) the existing Node sidecar shutdown. Only ever touches
/// processes THIS app started (i.e. currently in `LauncherState`) — an
/// externally-started Ollama/LM Studio/etc. the user was already running is
/// never killed.
pub(crate) fn shutdown_all(app: &AppHandle) {
    let owned: Vec<(String, OwnedProc)> = {
        let state = app.state::<LauncherState>();
        let drained = state.procs.lock().unwrap().drain().collect();
        drained
    };
    for (id, mut proc) in owned {
        if let Some((program, args)) = proc.stop.clone() {
            log_line(app, &format!("shutdown: running stop command for launcher {id}"));
            run_stop_command(app, &id, &program, &args);
        }
        let _ = proc.child.kill();
        // `proc` (and its Job, if assignment succeeded) is dropped here at
        // the end of the loop body — JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE then
        // terminates the whole process tree (e.g. Ollama's runner
        // subprocesses), not just the one child handle killed above.
        //
        // vLLM (WSL) caveat: `proc.child` for a vLLM launcher is wsl.exe's
        // own wrapper process on the Windows side, not the real `vllm`
        // process running inside the WSL VM. Killing wsl.exe does not
        // reliably stop that inner process — it isn't part of any Windows
        // Job Object, and WSL gives no guarantee that terminating the
        // Windows-side wrapper propagates into the Linux-side process tree.
        // "Stops on exit" is therefore NOT guaranteed for this one kind.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;
    use std::net::TcpListener;

    // -- catalog integrity ---------------------------------------------

    #[test]
    fn catalog_ids_are_unique() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|e| e.id).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "duplicate catalog id");
    }

    #[test]
    fn catalog_ports_are_non_zero() {
        for entry in CATALOG {
            assert_ne!(entry.port, 0, "{} has a zero port", entry.id);
        }
    }

    #[test]
    fn launchable_catalog_entries_have_args() {
        for entry in CATALOG {
            if entry.launchable {
                assert!(!entry.default_args.is_empty(), "{} is launchable but has no default_args", entry.id);
            }
        }
    }

    #[test]
    fn catalog_lookup_is_case_sensitive_and_exact() {
        assert!(catalog_entry("ollama").is_some());
        assert!(catalog_entry("Ollama").is_none());
        assert!(catalog_entry("not-a-real-id").is_none());
    }

    // -- classify ---------------------------------------------------------

    fn probe(path: &str, status: u16, body: &str) -> ProbeResult {
        ProbeResult {
            path: path.to_string(),
            status,
            body: body.to_string(),
        }
    }

    #[test]
    fn classifies_ollama_from_root_text() {
        let responses = vec![probe("/", 200, "Ollama is running")];
        assert_eq!(classify(&responses), Some(Kind::Ollama));
    }

    #[test]
    fn classifies_ollama_from_api_tags() {
        let responses = vec![probe("/api/tags", 200, r#"{"models":[{"name":"llama3:8b"}]}"#)];
        assert_eq!(classify(&responses), Some(Kind::Ollama));
    }

    #[test]
    fn classifies_llamacpp_from_props() {
        let responses = vec![probe("/props", 200, r#"{"default_generation_settings":{"n_ctx":4096}}"#)];
        assert_eq!(classify(&responses), Some(Kind::LlamaCpp));
    }

    #[test]
    fn classifies_llamacpp_from_combined_health_and_props() {
        let responses = vec![probe("/health", 200, r#"{"status":"ok"}"#), probe("/props", 200, r#"{"unexpected":true}"#)];
        assert_eq!(classify(&responses), Some(Kind::LlamaCpp));
    }

    #[test]
    fn health_alone_without_props_is_not_llamacpp() {
        let responses = vec![probe("/health", 200, r#"{"status":"ok"}"#)];
        assert_eq!(classify(&responses), None);
    }

    #[test]
    fn classifies_localai_style_openai_compatible_from_v1_models() {
        let responses = vec![probe("/v1/models", 200, r#"{"object":"list","data":[{"id":"gpt-x"}]}"#)];
        assert_eq!(classify(&responses), Some(Kind::OpenAiCompatible));
    }

    #[test]
    fn garbage_body_classifies_as_none() {
        let responses = vec![probe("/", 200, "not json, not ollama, nothing recognizable")];
        assert_eq!(classify(&responses), None);
    }

    #[test]
    fn empty_responses_classify_as_none() {
        assert_eq!(classify(&[]), None);
    }

    /// Port 8080 is llama.cpp's AND LocalAI's shared default — this is the
    /// disambiguation case the module doc comment calls out: a failed/
    /// mismatched `/props` plus a matching `/v1/models` must resolve to
    /// OpenAiCompatible, not LlamaCpp.
    #[test]
    fn disambiguates_shared_port_8080_towards_openai_compatible() {
        let responses = vec![probe("/props", 404, ""), probe("/v1/models", 200, r#"{"data":[]}"#)];
        assert_eq!(classify(&responses), Some(Kind::OpenAiCompatible));
    }

    // -- launcher validation ------------------------------------------

    #[test]
    fn non_catalog_id_is_rejected() {
        assert!(catalog_entry("totally-made-up").is_none());
    }

    #[test]
    fn non_exe_program_is_rejected() {
        let dir = std::env::temp_dir().join(format!("vault-chat-launchers-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let not_exe = dir.join("not-a-program.txt");
        std::fs::write(&not_exe, b"hello").unwrap();
        let err = validate_program_path(&not_exe).unwrap_err();
        assert!(err.contains(".exe"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_program_is_rejected_even_with_exe_extension() {
        let missing = std::env::temp_dir().join("vault-chat-does-not-exist.exe");
        let err = validate_program_path(&missing).unwrap_err();
        assert!(err.contains("bulunamadı"));
    }

    #[test]
    fn nul_in_args_is_rejected() {
        let args = vec!["--flag".to_string(), "bad\0value".to_string()];
        assert!(validate_args(&args).is_err());
    }

    #[test]
    fn clean_args_pass_validation() {
        let args = vec!["serve".to_string()];
        assert!(validate_args(&args).is_ok());
    }

    #[test]
    fn zero_port_is_rejected() {
        assert!(validate_port(0).is_err());
    }

    #[test]
    fn non_gguf_model_path_is_rejected() {
        let dir = std::env::temp_dir().join(format!("vault-chat-launchers-model-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wrong_ext = dir.join("model.bin");
        std::fs::write(&wrong_ext, b"not really a model").unwrap();
        let err = validate_model_path(wrong_ext.to_str().unwrap()).unwrap_err();
        assert!(err.contains(".gguf"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_gguf_model_path_is_rejected() {
        let missing = std::env::temp_dir().join("vault-chat-does-not-exist.gguf");
        assert!(validate_model_path(missing.to_str().unwrap()).is_err());
    }

    #[test]
    fn model_name_starting_with_dash_is_rejected() {
        assert!(validate_model_name("-e").is_err());
        assert!(validate_model_name("--host").is_err());
    }

    #[test]
    fn ordinary_model_name_passes_validation() {
        assert!(validate_model_name("meta-llama/Llama-3-8B").is_ok());
    }

    // -- vLLM args lock (SECURITY) -------------------------------------

    #[test]
    fn save_launcher_helper_rejects_any_args_override_for_vllm() {
        let malicious = Some(vec!["-e".to_string(), "sh".to_string(), "-c".to_string(), "calc.exe".to_string()]);
        assert!(reject_args_override_for_vllm("vllm", &malicious).is_err());
        // Even an args value that LOOKS harmless must still be rejected —
        // the rule is "never from the webview for this id", not "only
        // reject args that look dangerous".
        let harmless_looking = Some(vec!["serve".to_string()]);
        assert!(reject_args_override_for_vllm("vllm", &harmless_looking).is_err());
    }

    #[test]
    fn save_launcher_helper_allows_args_override_for_other_ids() {
        assert!(reject_args_override_for_vllm("ollama", &Some(vec!["serve".to_string()])).is_ok());
        assert!(reject_args_override_for_vllm("vllm", &None).is_ok());
    }

    #[test]
    fn args_match_catalog_default_detects_tampering() {
        let entry = catalog_entry("vllm").unwrap();
        let matching: Vec<String> = entry.default_args.iter().map(|s| s.to_string()).collect();
        assert!(args_match_catalog_default(&matching, entry.default_args));

        let tampered = vec!["-e".to_string(), "sh".to_string(), "-c".to_string(), "calc.exe".to_string()];
        assert!(!args_match_catalog_default(&tampered, entry.default_args));

        // Same tokens, extra one appended — still a mismatch by length.
        let mut extended = matching.clone();
        extended.push("--extra".to_string());
        assert!(!args_match_catalog_default(&extended, entry.default_args));
    }

    fn temp_fake_exe(name: &str) -> PathBuf {
        // Per-name dir: tests run in parallel and each one removes its own
        // dir afterwards, so a shared dir let one test delete another's exe.
        let dir = std::env::temp_dir().join(format!("vault-chat-launchers-vllm-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, b"fake exe").unwrap();
        p
    }

    #[test]
    fn validate_launcher_config_rejects_tampered_vllm_args() {
        let entry = catalog_entry("vllm").unwrap();
        let program = temp_fake_exe("wsl.exe");
        let cfg = LauncherConfig {
            id: "vllm".to_string(),
            program: program.to_string_lossy().to_string(),
            args: vec!["-e".to_string(), "sh".to_string(), "-c".to_string(), "calc.exe".to_string()],
            port: 8000,
            auto_start: false,
            model_path: None,
            model: Some("meta-llama/Llama-3-8B".to_string()),
        };
        let err = validate_launcher_config(entry, &cfg).unwrap_err();
        assert!(err.contains("vLLM"));
        let _ = std::fs::remove_dir_all(program.parent().unwrap());
    }

    #[test]
    fn validate_launcher_config_accepts_untampered_vllm_args() {
        let entry = catalog_entry("vllm").unwrap();
        let program = temp_fake_exe("wsl2.exe");
        let cfg = LauncherConfig {
            id: "vllm".to_string(),
            program: program.to_string_lossy().to_string(),
            args: entry.default_args.iter().map(|s| s.to_string()).collect(),
            port: 8000,
            auto_start: false,
            model_path: None,
            model: Some("meta-llama/Llama-3-8B".to_string()),
        };
        assert!(validate_launcher_config(entry, &cfg).is_ok());
        let _ = std::fs::remove_dir_all(program.parent().unwrap());
    }

    // -- launchers.json serde roundtrip + unparseable -> empty --------

    #[test]
    fn launcher_config_roundtrips_through_json() {
        let original = vec![LauncherConfig {
            id: "ollama".to_string(),
            program: r"C:\Users\Alp\AppData\Local\Programs\Ollama\ollama.exe".to_string(),
            args: vec!["serve".to_string()],
            port: 11434,
            auto_start: true,
            model_path: None,
            model: None,
        }];
        let raw = serde_json::to_string_pretty(&original).unwrap();
        let parsed = parse_launchers_or_empty(&raw, None);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "ollama");
        assert_eq!(parsed[0].port, 11434);
        assert!(parsed[0].auto_start);
        assert_eq!(parsed[0].model_path, None);
    }

    #[test]
    fn unparseable_launchers_json_becomes_empty() {
        let parsed = parse_launchers_or_empty("{ not valid json at all", None);
        assert!(parsed.is_empty());
    }

    #[test]
    fn empty_array_parses_to_empty() {
        let parsed = parse_launchers_or_empty("[]", None);
        assert!(parsed.is_empty());
    }

    #[test]
    fn write_launchers_atomic_then_read_back_roundtrips() {
        let dir = std::env::temp_dir().join(format!("vault-chat-launchers-atomic-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("launchers.json");
        let launchers = vec![LauncherConfig {
            id: "lmstudio".to_string(),
            program: r"C:\Users\Alp\.lmstudio\bin\lms.exe".to_string(),
            args: vec!["server".to_string(), "start".to_string()],
            port: 1234,
            auto_start: false,
            model_path: None,
            model: None,
        }];
        write_launchers_atomic(&path, &launchers).unwrap();
        assert!(path.exists());
        // The .tmp file must not linger after a successful rename.
        assert!(!path.with_extension("json.tmp").exists());
        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed = parse_launchers_or_empty(&raw, None);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "lmstudio");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // -- args substitution --------------------------------------------

    #[test]
    fn model_path_is_substituted_as_a_single_argv_element() {
        let entry = catalog_entry("llamacpp").unwrap();
        let dir = std::env::temp_dir().join(format!("vault-chat-launchers-argv-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let model = dir.join("my model with spaces.gguf");
        std::fs::write(&model, b"fake gguf").unwrap();
        let cfg = LauncherConfig {
            id: "llamacpp".to_string(),
            program: r"C:\llama-server.exe".to_string(),
            args: entry.default_args.iter().map(|s| s.to_string()).collect(),
            port: 8080,
            auto_start: false,
            model_path: Some(model.to_string_lossy().to_string()),
            model: None,
        };
        let args = build_effective_args(entry, &cfg).unwrap();
        // Exactly one element holds the whole path, spaces and all — never
        // split into "my", "model", "with", "spaces.gguf".
        assert_eq!(args[0], "-m");
        assert_eq!(args[1], model.to_string_lossy().to_string());
        assert_eq!(args.len(), entry.default_args.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn starting_llamacpp_without_model_path_fails_with_clear_error() {
        let entry = catalog_entry("llamacpp").unwrap();
        let cfg = LauncherConfig {
            id: "llamacpp".to_string(),
            program: r"C:\llama-server.exe".to_string(),
            args: entry.default_args.iter().map(|s| s.to_string()).collect(),
            port: 8080,
            auto_start: false,
            model_path: None,
            model: None,
        };
        let err = build_effective_args(entry, &cfg).unwrap_err();
        assert!(err.contains("model_path"));
    }

    #[test]
    fn vllm_model_name_is_substituted_as_a_single_argv_element() {
        let entry = catalog_entry("vllm").unwrap();
        let cfg = LauncherConfig {
            id: "vllm".to_string(),
            program: r"C:\Windows\System32\wsl.exe".to_string(),
            args: entry.default_args.iter().map(|s| s.to_string()).collect(),
            port: 8000,
            auto_start: false,
            model_path: None,
            model: Some("meta-llama/Llama-3-8B".to_string()),
        };
        let args = build_effective_args(entry, &cfg).unwrap();
        assert!(args.contains(&"meta-llama/Llama-3-8B".to_string()));
    }

    #[test]
    fn port_placeholder_is_substituted_with_the_configured_port_not_the_catalog_default() {
        let entry = catalog_entry("llamacpp").unwrap(); // catalog default port is 8080
        let dir = std::env::temp_dir().join(format!("vault-chat-launchers-port-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let model = dir.join("model.gguf");
        std::fs::write(&model, b"fake gguf").unwrap();
        let cfg = LauncherConfig {
            id: "llamacpp".to_string(),
            program: r"C:\llama-server.exe".to_string(),
            args: entry.default_args.iter().map(|s| s.to_string()).collect(),
            port: 19090, // user changed the port away from the 8080 default
            auto_start: false,
            model_path: Some(model.to_string_lossy().to_string()),
            model: None,
        };
        let args = build_effective_args(entry, &cfg).unwrap();
        assert!(args.contains(&"19090".to_string()), "expected substituted port 19090 in {args:?}");
        assert!(!args.contains(&"8080".to_string()), "stale catalog-default port leaked into {args:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lmstudio_port_placeholder_is_substituted_and_bind_is_pinned_to_loopback() {
        let entry = catalog_entry("lmstudio").unwrap();
        let cfg = LauncherConfig {
            id: "lmstudio".to_string(),
            program: r"C:\lms.exe".to_string(),
            args: entry.default_args.iter().map(|s| s.to_string()).collect(),
            port: 4321,
            auto_start: false,
            model_path: None,
            model: None,
        };
        let args = build_effective_args(entry, &cfg).unwrap();
        assert!(args.contains(&"--bind".to_string()));
        assert!(args.contains(&"127.0.0.1".to_string()));
        assert!(args.contains(&"--port".to_string()));
        assert!(args.contains(&"4321".to_string()));
    }

    #[test]
    fn localai_address_placeholder_is_substituted_as_a_single_host_port_argv_element() {
        let entry = catalog_entry("localai").unwrap();
        let cfg = LauncherConfig {
            id: "localai".to_string(),
            program: r"C:\local-ai.exe".to_string(),
            args: entry.default_args.iter().map(|s| s.to_string()).collect(),
            port: 9090,
            auto_start: false,
            model_path: None,
            model: None,
        };
        let args = build_effective_args(entry, &cfg).unwrap();
        // Must be ONE argv element ("127.0.0.1:9090"), never split into
        // "127.0.0.1" and "9090" as two separate elements — that would be a
        // different (broken) command line for `--address`.
        assert!(args.contains(&"127.0.0.1:9090".to_string()), "expected combined host:port in {args:?}");
        assert!(!args.contains(&"127.0.0.1".to_string()));
        assert!(!args.contains(&"9090".to_string()));
        // Never the LocalAI-default wildcard bind.
        assert!(!args.iter().any(|a| a.contains(":8080") && !a.starts_with("127.0.0.1")));
    }

    #[test]
    fn vllm_port_placeholder_is_also_substituted() {
        let entry = catalog_entry("vllm").unwrap();
        let cfg = LauncherConfig {
            id: "vllm".to_string(),
            program: r"C:\Windows\System32\wsl.exe".to_string(),
            args: entry.default_args.iter().map(|s| s.to_string()).collect(),
            port: 8123,
            auto_start: false,
            model_path: None,
            model: Some("meta-llama/Llama-3-8B".to_string()),
        };
        let args = build_effective_args(entry, &cfg).unwrap();
        assert!(args.contains(&"8123".to_string()));
    }

    // -- double-start race guard ----------------------------------------

    #[test]
    fn concurrent_start_reservation_prevents_double_claim() {
        let starting: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
        assert!(try_claim_starting(&starting, "ollama"));
        // A second concurrent attempt for the SAME id must be refused —
        // this is what stops two concurrent start_launcher_by_id calls from
        // both reaching the spawn+insert below and one overwriting the
        // other's OwnedProc (dropping its kill-on-close Job).
        assert!(!try_claim_starting(&starting, "ollama"));
        // A different id is unaffected.
        assert!(try_claim_starting(&starting, "lmstudio"));
        release_starting(&starting, "ollama");
        // After release (mirrors StartingGuard::drop), a fresh attempt for
        // the same id succeeds again.
        assert!(try_claim_starting(&starting, "ollama"));
    }

    // -- chunked Transfer-Encoding decoding ------------------------------

    #[test]
    fn decodes_chunked_body_from_the_classic_rfc7230_example() {
        let raw = b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        let decoded = decode_chunked_body(raw);
        assert_eq!(String::from_utf8(decoded).unwrap(), "Wikipedia");
    }

    #[test]
    fn decodes_chunked_json_body_and_ignores_chunk_extensions() {
        let body = r#"{"data":[{"id":"x"}]}"#; // 22 bytes
        let raw = format!("{:x};ext=1\r\n{body}\r\n0\r\n\r\n", body.len());
        let decoded = decode_chunked_body(raw.as_bytes());
        assert_eq!(String::from_utf8(decoded).unwrap(), body);
    }

    #[test]
    fn decode_chunked_body_handles_a_truncated_final_chunk_gracefully() {
        // Claims 10 (0xa) bytes but only 3 are actually present, as if the
        // read loop's timeout fired mid-chunk.
        let raw = b"a\r\nabc";
        let decoded = decode_chunked_body(raw);
        assert_eq!(decoded, b"abc");
    }

    #[test]
    fn decode_chunked_body_on_garbage_size_line_yields_nothing() {
        let raw = b"not-hex\r\ndata\r\n0\r\n\r\n";
        assert!(decode_chunked_body(raw).is_empty());
    }

    #[test]
    fn http_get_decodes_a_chunked_response_from_a_real_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            let _ = reader.read_line(&mut request_line);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let response = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n7\r\n{\"a\":1}\r\n0\r\n\r\n";
            let _ = stream.write_all(response.as_bytes());
        });
        let (status, body) = http_get(port, "/v1/models", Duration::from_secs(2)).expect("expected a response");
        assert_eq!(status, 200);
        assert_eq!(body, r#"{"a":1}"#);
        handle.join().unwrap();
    }

    #[test]
    fn classify_still_works_on_a_chunked_v1_models_response() {
        // End-to-end sanity: what http_get hands classify() after decoding
        // a chunked response must parse as JSON exactly like a plain one.
        let body = r#"{"object":"list","data":[{"id":"gpt-x"}]}"#;
        let responses = vec![probe("/v1/models", 200, body)];
        assert_eq!(classify(&responses), Some(Kind::OpenAiCompatible));
    }

    // -- http_get against a real (local, ephemeral) TCP listener ------

    #[test]
    fn http_get_reads_status_and_body_from_a_real_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            let _ = reader.read_line(&mut request_line);
            // Drain the rest of the headers.
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let body = r#"{"status":"ok"}"#;
            let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            let _ = stream.write_all(response.as_bytes());
        });
        let (status, body) = http_get(port, "/health", Duration::from_secs(2)).expect("expected a response");
        assert_eq!(status, 200);
        assert_eq!(body, r#"{"status":"ok"}"#);
        handle.join().unwrap();
    }

    #[test]
    fn http_get_returns_none_for_a_closed_port() {
        // Port 0 never accepts connections; connect() fails immediately.
        assert!(http_get(0, "/", Duration::from_millis(200)).is_none());
    }
}
