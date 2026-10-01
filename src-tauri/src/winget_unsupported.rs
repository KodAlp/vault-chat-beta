//! Non-Windows stand-in for `winget.rs` (selected by `#[path]` in lib.rs).
//!
//! winget only exists on Windows, but the Tauri command names, signatures and
//! the `WingetState` managed state must stay identical on every platform so
//! build.rs's ACL manifest, `capabilities/*.json`, the runtime
//! "sidecar-remote" capability and the frontend's `invoke()` calls do not
//! change per OS. Parameter NAMES matter too (Tauri maps them to the JS
//! argument keys), hence `app`/`id` are kept even though they go unused.
use tauri::AppHandle;

/// Same managed-state type as the real module; carries nothing here.
pub(crate) struct WingetState;

impl WingetState {
    pub(crate) fn new() -> Self {
        WingetState
    }
}

#[tauri::command]
pub(crate) async fn winget_available() -> bool {
    false
}

#[tauri::command]
pub(crate) async fn winget_install(app: AppHandle, id: String) -> Result<(), String> {
    let _ = (app, id);
    Err("winget is only available on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winget_is_reported_unavailable() {
        assert!(!tauri::async_runtime::block_on(winget_available()));
    }
}
