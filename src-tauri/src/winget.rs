//! Aşama 2a — `winget install <id>` as a Tauri command, security-reviewed.
//!
//! Windows only — lib.rs swaps in `winget_unsupported.rs` (same command
//! names/signatures) on other platforms.
//!
//! SECURITY BOUNDARY: exactly like `launchers.rs` (see its module doc
//! comment), this module gives the webview a very narrow capability, never
//! an arbitrary-process-execution one. `winget_install` takes a single
//! `id: String` from the webview and does nothing else with caller input —
//! no version, no source, no override args, no custom installer arguments.
//! That `id` is checked against a fixed allowlist (`is_allowlisted`) before
//! it ever reaches `Command::new`, and even once past that check it is used
//! only as the value of winget's own `--id` argv element (never
//! interpolated into a string, never passed to a shell). The rest of the
//! command line (`install`, `-e`, `--accept-source-agreements`, ...) is a
//! fixed `Vec<String>` this module owns — the webview cannot influence it at
//! all.
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::{log_line, platform};

/// Package ids this command will install, beyond what `launchers.rs`'s own
/// CATALOG already lists (see `is_allowlisted`) — things Aşama 2a's Node
/// version check (Node.js itself) and future stages (Python, Pandoc, for the
/// source-ingest pipeline) need to be able to offer a one-click winget
/// install for, without themselves being a "local LLM server" launcher.
/// `winget show --id <id> -e` was re-run against all three while building
/// this module and all three resolved (see the Aşama 2a report).
const EXTRA_ALLOWLISTED_PACKAGES: &[(&str, &str)] = &[
    ("OpenJS.NodeJS.22", "https://nodejs.org/en/download"),
    ("Python.Python.3.12", "https://www.python.org/downloads/"),
    ("JohnMacFarlane.Pandoc", "https://pandoc.org/installing.html"),
];

/// True only for an EXACT (case-sensitive) match against the allowlist —
/// never a prefix/substring match. A near-miss like `"Ollama.Ollama "`
/// (trailing space) or `"Ollama.Ollama;calc"` must be rejected just as hard
/// as something wholly unrelated: this is the one and only gate between a
/// webview-supplied string and an argv element handed to `winget.exe`, so
/// "looks close enough" is never acceptable here.
fn is_allowlisted(id: &str) -> bool {
    crate::launchers::winget_catalog_entries().iter().any(|(allowed, _)| *allowed == id)
        || EXTRA_ALLOWLISTED_PACKAGES.iter().any(|(allowed, _)| *allowed == id)
}

/// The download page to point the user at when winget itself is missing, or
/// when they'd rather install by hand — looked up from the very same table
/// `is_allowlisted` checks against, so it can never disagree with it.
fn download_url_for(id: &str) -> Option<&'static str> {
    crate::launchers::winget_catalog_entries()
        .into_iter()
        .chain(EXTRA_ALLOWLISTED_PACKAGES.iter().copied())
        .find(|(allowed, _)| *allowed == id)
        .map(|(_, url)| url)
}

/// Resolves a working `winget.exe`.
///
/// Deliberately does NOT reuse `launchers.rs`'s `resolve_via_where` (which
/// filters out any path containing "windowsapps") — for winget specifically,
/// `%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe` is not a redirector
/// stub for an absent target the way an unconfigured `python.exe`/`node.exe`
/// alias would be. It's a real `IO_REPARSE_TAG_APPEXECLINK` reparse point
/// Windows itself resolves at process-creation time to the actual
/// DesktopAppInstaller package binary — Microsoft ships winget through this
/// exact path on every Windows 10/11 install with App Installer present,
/// there being no other supported "plain .exe on PATH" location for it.
///
/// Verified directly while building this module: `Path::exists()` on this
/// path correctly returns `true` and `Command::new(path).spawn()` correctly
/// runs it — even though `attrib`/PowerShell's `Test-Path` on the *same*
/// path report it as missing (they try to resolve the reparse point's
/// stored target, which points into the WindowsApps package store and is
/// not directly stat-able that way; `CreateProcess`, and apparently Rust's
/// own `GetFileAttributesExW`-based `metadata()` call, handle this reparse
/// tag correctly instead of trying to walk to that target). So this
/// function's `.exists()` check is trustworthy; don't "fix" it into a
/// `where`-only lookup or a `symlink_metadata` check based on a PowerShell
/// experiment alone.
fn resolve_winget_exe() -> Option<PathBuf> {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local_app_data).join("Microsoft").join("WindowsApps").join("winget.exe");
        if p.exists() {
            return Some(p);
        }
    }
    // Fallback for the (rare) machine where the alias itself is missing or
    // disabled in Settings > Apps > Advanced app settings > App execution
    // aliases, but winget is still reachable some other way on PATH.
    let mut where_cmd = Command::new("where");
    where_cmd.arg("winget");
    platform::no_window(&mut where_cmd);
    let output = where_cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .find(|p| p.exists())
}

#[tauri::command]
pub(crate) async fn winget_available() -> bool {
    tauri::async_runtime::spawn_blocking(resolve_winget_exe).await.ok().flatten().is_some()
}

// ---------------------------------------------------------------------------
// Single-flight guard — only one winget_install at a time.
// ---------------------------------------------------------------------------

pub(crate) struct WingetState {
    installing: Mutex<bool>,
}

impl WingetState {
    pub(crate) fn new() -> Self {
        Self {
            installing: Mutex::new(false),
        }
    }
}

fn try_claim_installing(installing: &Mutex<bool>) -> bool {
    let mut guard = installing.lock().unwrap();
    if *guard {
        return false;
    }
    *guard = true;
    true
}

fn release_installing(installing: &Mutex<bool>) {
    *installing.lock().unwrap() = false;
}

/// RAII guard mirroring `launchers.rs`'s `StartingGuard` — released on every
/// exit path from `winget_install` (early `?`/`return Err`, or falling off
/// the end), since `Drop::drop` always runs.
struct InstallGuard {
    app: AppHandle,
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        let state = self.app.state::<WingetState>();
        release_installing(&state.installing);
    }
}

fn reserve_installing(app: &AppHandle) -> Option<InstallGuard> {
    let state = app.state::<WingetState>();
    if try_claim_installing(&state.installing) {
        Some(InstallGuard { app: app.clone() })
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Progress line cleaning
// ---------------------------------------------------------------------------

/// Strips winget's spinner/progress-bar noise from one raw chunk of output
/// (already split on `\r`/`\n` — see `drain_progress`) so the frontend's log
/// area gets readable text instead of a scramble of cursor-control bytes.
/// Handles:
///   - ANSI CSI escape sequences (`ESC '[' ... <final byte 0x40-0x7E>`),
///     which winget can still emit for coloring even when stdout isn't a
///     real console.
///   - Stray C0 control bytes (e.g. `\x08` backspace, used to erase-and-
///     redraw a spinner character in place) — dropped outright.
///   - A chunk that, once cleaned, is just one of the four characters
///     winget's CLI spinner cycles through (`-`, `\`, `|`, `/`) with nothing
///     else — that's pure animation, not information.
///
/// Returns `None` for anything that cleans down to nothing worth showing.
/// Pure and unit-tested — no I/O.
fn clean_progress_line(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    let mut cleaned = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&n) {
                        break;
                    }
                }
            }
            continue;
        }
        if c.is_control() && c != '\t' {
            continue;
        }
        cleaned.push(c);
    }
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || matches!(trimmed, "-" | "\\" | "|" | "/") {
        return None;
    }
    Some(trimmed.to_string())
}

#[derive(Serialize, Clone)]
struct WingetProgress {
    id: String,
    line: String,
}

#[derive(Serialize, Clone)]
struct WingetDone {
    id: String,
    success: bool,
    #[serde(rename = "exitCode")]
    exit_code: Option<i32>,
}

/// Reads `reader` byte-by-byte, splitting on EITHER `\r` or `\n` (unlike
/// `BufRead::lines()`, which only splits on `\n` and would otherwise buffer
/// an entire `\r`-only progress-bar animation into one giant "line" until a
/// real newline eventually shows up) — emitting a cleaned `winget-progress`
/// event for each non-empty, non-spinner segment. Runs on its own OS thread
/// (see `winget_install`), one per pipe, exactly like `spawn_sidecar`'s
/// stdout/stderr drain threads in lib.rs.
fn drain_progress(mut reader: impl std::io::Read, app: &AppHandle, id: &str) {
    let mut buf: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' || byte[0] == b'\r' {
                    if !buf.is_empty() {
                        if let Some(line) = clean_progress_line(&buf) {
                            log_line(app, &format!("[winget {id}] {line}"));
                            let _ = app.emit("winget-progress", WingetProgress { id: id.to_string(), line });
                        }
                        buf.clear();
                    }
                } else {
                    buf.push(byte[0]);
                }
            }
            Err(_) => break,
        }
    }
    if !buf.is_empty() {
        if let Some(line) = clean_progress_line(&buf) {
            log_line(app, &format!("[winget {id}] {line}"));
            let _ = app.emit("winget-progress", WingetProgress { id: id.to_string(), line });
        }
    }
}

// ---------------------------------------------------------------------------
// Exit-code classification
// ---------------------------------------------------------------------------

/// winget HRESULTs, as `i32` (Rust's `ExitStatus::code()` return type) —
/// same 32-bit pattern as the hex value, just reinterpreted as signed.
/// Confirmed against the generated reference table at
/// <https://github.com/microsoft/winget-cli/blob/master/doc/windows/package-manager/winget/returnCodes.md>
/// (fetched directly, not from memory — an earlier guess at these two
/// specific values while planning this module was wrong; the real codes
/// are these).
const ERR_PACKAGE_ALREADY_INSTALLED: i32 = 0x8A150061_u32 as i32; // APPINSTALLER_CLI_ERROR_PACKAGE_ALREADY_INSTALLED
const ERR_INSTALL_ALREADY_INSTALLED: i32 = 0x8A15010D_u32 as i32; // APPINSTALLER_CLI_ERROR_INSTALL_ALREADY_INSTALLED
const ERR_UPDATE_NOT_APPLICABLE: i32 = 0x8A15002B_u32 as i32; // APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE ("No applicable update found")

/// `0` is the obvious success case. The other three are all "the package is
/// already at least as new as what we'd install" outcomes that a plain
/// `winget install --id X -e` can legitimately return instead of `0` when
/// run against something already present (exactly which of the three
/// depends on winget version/source metadata) — from this app's point of
/// view all three mean "the thing we wanted installed is already there",
/// which is success, not failure.
fn is_success_exit_code(code: i32) -> bool {
    matches!(code, 0 | ERR_PACKAGE_ALREADY_INSTALLED | ERR_INSTALL_ALREADY_INSTALLED | ERR_UPDATE_NOT_APPLICABLE)
}

// ---------------------------------------------------------------------------
// The command itself
// ---------------------------------------------------------------------------

/// Hard cap on how long one `winget install` is allowed to run — some
/// installers (Node's MSI, in particular) can sit for a while, but nothing
/// legitimate should ever approach 20 minutes; past that this is almost
/// certainly a hung installer UI (see the UAC note below) or a stalled
/// download, and the process is killed rather than left running forever
/// under the single-flight lock.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// Installs `id` via `winget install --id <id> -e --accept-source-agreements
/// --accept-package-agreements --silent --disable-interactivity`, streaming
/// cleaned output lines as `winget-progress` events and finishing with one
/// `winget-done` event, then returning `Ok(())`/`Err(...)` to match.
///
/// NOTE on UAC: several packages this app can be asked to install (Node.js's
/// MSI among them) run an installer that elevates via a UAC prompt even
/// under `--silent`, because the MSI itself requests admin rights to write
/// to Program Files / register itself — that prompt is the OS's own secure
/// desktop dialog, entirely outside this process's control (winget can't
/// suppress it, and this app doesn't try to). It's expected; the frontend's
/// log area will simply pause during it.
#[tauri::command]
pub(crate) async fn winget_install(app: AppHandle, id: String) -> Result<(), String> {
    if !is_allowlisted(&id) {
        return Err(format!("'{id}' kurulum için izin verilen paketler listesinde değil."));
    }

    let Some(_guard) = reserve_installing(&app) else {
        return Err("başka bir kurulum sürüyor".to_string());
    };

    // Native, Rust-side consent before anything is installed: the allowlist
    // bounds WHAT can be installed, but any script in the webview can still
    // invoke this command, so the user must see and approve each install
    // (including that winget's source/package agreements are accepted on
    // their behalf) in a dialog the page cannot draw or click itself.
    let app_for_dialog = app.clone();
    let prompt = format!(
        "'{id}' paketi winget ile kurulacak.\n\n\
         Devam ederseniz winget kaynak ve paket sözleşmeleri sizin adınıza kabul edilir; \
         kurulum programı yönetici izni (UAC) isteyebilir."
    );
    let approved = tauri::async_runtime::spawn_blocking(move || {
        app_for_dialog
            .dialog()
            .message(prompt)
            .title("Vault Chat — kurulum onayı")
            .buttons(MessageDialogButtons::OkCancelCustom("Kur".to_string(), "Vazgeç".to_string()))
            .blocking_show()
    })
    .await
    .map_err(|e| format!("onay penceresi açılamadı: {e}"))?;
    if !approved {
        let _ = app.emit("winget-done", WingetDone { id: id.clone(), success: false, exit_code: None });
        return Err("Kurulum iptal edildi.".to_string());
    }

    let winget_path = tauri::async_runtime::spawn_blocking(resolve_winget_exe)
        .await
        .map_err(|e| format!("winget arama görevi başarısız: {e}"))?;
    let Some(winget_path) = winget_path else {
        let url = download_url_for(&id).unwrap_or("https://aka.ms/getwinget");
        let msg = format!("winget bulunamadı. Paketi elle kurmak için: {url}");
        log_line(&app, &format!("winget_install({id}): {msg}"));
        return Err(msg);
    };

    let args: Vec<String> = vec![
        "install".to_string(),
        "--id".to_string(),
        id.clone(),
        "-e".to_string(),
        "--accept-source-agreements".to_string(),
        "--accept-package-agreements".to_string(),
        "--silent".to_string(),
        "--disable-interactivity".to_string(),
    ];

    let mut command = Command::new(&winget_path);
    command.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    platform::no_window(&mut command);
    let mut child: Child = command.spawn().map_err(|e| format!("winget başlatılamadı: {e}"))?;

    let stdout_handle = child.stdout.take().map(|stdout| {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || drain_progress(stdout, &app, &id))
    });
    let stderr_handle = child.stderr.take().map(|stderr| {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || drain_progress(stderr, &app, &id))
    });

    let start = Instant::now();
    let exit_code: Option<i32> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if start.elapsed() > INSTALL_TIMEOUT {
                    log_line(&app, &format!("winget_install({id}): 20 dakikalık sınır aşıldı, süreç sonlandırılıyor"));
                    let _ = child.kill();
                    break None;
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            Err(e) => {
                log_line(&app, &format!("winget_install({id}): try_wait başarısız: {e}"));
                break None;
            }
        }
    };

    // Pipes close (EOF) the moment the child exits/is killed, so these
    // threads finish almost immediately — joined off the async runtime's
    // worker thread via spawn_blocking rather than blocking it directly.
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Some(h) = stdout_handle {
            let _ = h.join();
        }
        if let Some(h) = stderr_handle {
            let _ = h.join();
        }
    })
    .await;

    let success = exit_code.map(is_success_exit_code).unwrap_or(false);
    let _ = app.emit("winget-done", WingetDone { id: id.clone(), success, exit_code });

    if success {
        Ok(())
    } else {
        match exit_code {
            Some(code) => Err(format!("winget kurulumu başarısız oldu (çıkış kodu: {code}).")),
            None => Err("winget kurulumu zaman aşımına uğradı ve sonlandırıldı.".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- allowlist ------------------------------------------------------

    #[test]
    fn catalog_winget_ids_are_allowlisted() {
        for (id, _) in crate::launchers::winget_catalog_entries() {
            assert!(is_allowlisted(id), "{id} from the launcher catalog should be allowlisted");
        }
    }

    #[test]
    fn extra_packages_are_allowlisted() {
        assert!(is_allowlisted("OpenJS.NodeJS.22"));
        assert!(is_allowlisted("Python.Python.3.12"));
        assert!(is_allowlisted("JohnMacFarlane.Pandoc"));
    }

    #[test]
    fn unrelated_id_is_rejected() {
        assert!(!is_allowlisted("Totally.Made.Up"));
    }

    #[test]
    fn case_variant_is_rejected() {
        // Exact match only — allowlisting is case-SENSITIVE, so a
        // differently-cased id must not slip through.
        assert!(!is_allowlisted("ollama.ollama"));
        assert!(!is_allowlisted("OLLAMA.OLLAMA"));
    }

    #[test]
    fn trailing_whitespace_near_miss_is_rejected() {
        assert!(!is_allowlisted("Ollama.Ollama "));
        assert!(!is_allowlisted(" Ollama.Ollama"));
    }

    #[test]
    fn injection_style_near_miss_is_rejected() {
        assert!(!is_allowlisted("Ollama.Ollama;calc"));
        assert!(!is_allowlisted("Ollama.Ollama\ncalc"));
        assert!(!is_allowlisted("Ollama.Ollama\0"));
    }

    #[test]
    fn download_url_lookup_matches_allowlist() {
        assert_eq!(download_url_for("OpenJS.NodeJS.22"), Some("https://nodejs.org/en/download"));
        assert!(download_url_for("Totally.Made.Up").is_none());
        // Every allowlisted id must have a URL — the frontend relies on
        // always getting somewhere to send the user when winget is missing.
        for (id, _) in crate::launchers::winget_catalog_entries() {
            assert!(download_url_for(id).is_some(), "{id} has no download URL");
        }
    }

    // -- progress line cleaning ------------------------------------------

    #[test]
    fn plain_line_passes_through_trimmed() {
        assert_eq!(clean_progress_line(b"  Downloading  "), Some("Downloading".to_string()));
    }

    #[test]
    fn lone_spinner_frame_is_dropped() {
        for frame in ["-", "\\", "|", "/"] {
            assert_eq!(clean_progress_line(frame.as_bytes()), None, "frame {frame:?} should be dropped");
        }
    }

    #[test]
    fn spinner_frame_with_surrounding_whitespace_is_dropped() {
        assert_eq!(clean_progress_line(b"  \\  "), None);
    }

    #[test]
    fn backspace_control_bytes_are_stripped() {
        // "Downloading\x08\x08\x08" — a common "erase last N chars" pattern
        // for redrawing a byte counter in place.
        let raw = b"Downloading\x08\x08\x08done";
        assert_eq!(clean_progress_line(raw), Some("Downloadingdone".to_string()));
    }

    #[test]
    fn ansi_csi_color_codes_are_stripped() {
        // ESC [ 32 m ... ESC [ 0 m  (green text, then reset) around real text.
        let raw = b"\x1b[32mSuccessfully installed\x1b[0m";
        assert_eq!(clean_progress_line(raw), Some("Successfully installed".to_string()));
    }

    #[test]
    fn empty_or_whitespace_only_is_dropped() {
        assert_eq!(clean_progress_line(b""), None);
        assert_eq!(clean_progress_line(b"   "), None);
    }

    // -- exit code classification ----------------------------------------

    #[test]
    fn zero_is_success() {
        assert!(is_success_exit_code(0));
    }

    #[test]
    fn already_installed_variants_are_success() {
        assert!(is_success_exit_code(ERR_PACKAGE_ALREADY_INSTALLED));
        assert!(is_success_exit_code(ERR_INSTALL_ALREADY_INSTALLED));
        assert!(is_success_exit_code(ERR_UPDATE_NOT_APPLICABLE));
    }

    #[test]
    fn arbitrary_nonzero_code_is_failure() {
        assert!(!is_success_exit_code(1));
        assert!(!is_success_exit_code(-1));
        assert!(!is_success_exit_code(0x8A150001_u32 as i32)); // APPINSTALLER_CLI_ERROR_INTERNAL_ERROR
    }

    // -- single-flight guard ----------------------------------------------

    #[test]
    fn concurrent_install_claim_is_refused_until_released() {
        let installing: Mutex<bool> = Mutex::new(false);
        assert!(try_claim_installing(&installing));
        assert!(!try_claim_installing(&installing), "a second concurrent claim must be refused");
        release_installing(&installing);
        assert!(try_claim_installing(&installing), "after release, a fresh claim must succeed");
    }
}
