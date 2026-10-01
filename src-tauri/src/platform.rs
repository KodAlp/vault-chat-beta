//! OS-specific process plumbing shared by lib.rs (Node sidecar), launchers.rs
//! (local LLM servers) and winget.rs.
//!
//! Everything that differs between Windows and POSIX lives here so the rest
//! of the crate can stay free of `#[cfg]` noise:
//!
//!   - `no_window`: Windows hides the console window of every child we spawn
//!     (`CREATE_NO_WINDOW`); a no-op elsewhere.
//!   - `ProcessGuard`: "kill this child's WHOLE process tree when we stop it
//!     or when the app dies". Windows: a Job Object with
//!     `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Unix: a dedicated session /
//!     process group (`setsid` before exec) that is signalled as a unit.
//!   - `find_in_path` / `exe_name`: pure-Rust PATH lookup and the executable
//!     suffix convention.
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use std::ffi::OsStr;

/// Passed via `Command::creation_flags` for every child we spawn (node.exe
/// is a console-subsystem binary) — without it, Windows gives the child its
/// own visible console window even though app.exe itself is a GUI-subsystem
/// process (`windows_subsystem = "windows"` in main.rs only hides app.exe's
/// own console, not a child's). The sidecar is long-lived, so that window
/// would sit open — visibly, unclosably from the user's side — for the
/// entire session.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Hides the child's console window on Windows (`CREATE_NO_WINDOW`); does
/// nothing on other platforms. Returns `cmd` so it can be used mid-chain.
pub fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// `"node"` -> `"node.exe"` on Windows, unchanged elsewhere.
pub fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

// ---------------------------------------------------------------------------
// ProcessGuard
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use win32job::Job;

    /// Windows: owns a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
    /// that the child is assigned to. Dropping the guard closes the job
    /// handle, and Windows itself then terminates every process still in the
    /// job — including when `app.exe` is force-killed or crashes (the kernel
    /// closes all of its handles; no user-space code has to run). So the
    /// guard must stay alive for as long as the child should live.
    pub struct ProcessGuard {
        _job: Job,
    }

    impl ProcessGuard {
        /// Nothing to do before spawn on Windows (the job is assigned after
        /// the process exists).
        pub fn prepare(cmd: &mut Command) -> &mut Command {
            cmd
        }

        /// Creates the kill-on-close job and assigns `child` to it.
        pub fn attach(child: &Child) -> Result<ProcessGuard, String> {
            let job = Job::create().map_err(|e| format!("Job Object create failed: {e}"))?;
            job.query_extended_limit_info()
                .and_then(|mut info| {
                    info.limit_kill_on_job_close();
                    job.set_extended_limit_info(&info)?;
                    job.assign_process(child.as_raw_handle() as isize)
                })
                .map_err(|e| format!("Job Object assign failed: {e}"))?;
            Ok(ProcessGuard { _job: job })
        }

        /// Kills `child` and (by dropping `guard`) its whole job. Without a
        /// guard (attach failed earlier) only the direct child is killed.
        /// `Child::kill()` is TerminateProcess on Windows — not catchable —
        /// so there is no graceful phase here.
        pub fn stop_or_kill(guard: Option<ProcessGuard>, child: &mut Child) {
            let _ = child.kill();
            drop(guard);
        }
    }
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::time::{Duration, Instant};

    /// How long `stop_or_kill` waits for the group to exit after SIGTERM
    /// before escalating to SIGKILL.
    const STOP_GRACE: Duration = Duration::from_secs(3);

    /// Unix: the child is started as the leader of its own session (and
    /// therefore its own process group, pgid == pid) via `setsid()` in
    /// `prepare`. The guard remembers that pgid; stopping signals the whole
    /// group (`kill(-pgid, ...)`), which reaches grandchildren such as
    /// Ollama's runner processes.
    ///
    /// Crash protection:
    ///   - Linux: `prepare` also sets `PR_SET_PDEATHSIG = SIGTERM`, so the
    ///     kernel signals the direct child if this app dies without running
    ///     any cleanup. Caveat: Linux delivers it when the *thread* that
    ///     forked the child exits, not the whole process — all our spawns
    ///     happen on long-lived async-runtime worker threads, never on a
    ///     short-lived `spawn_blocking` thread.
    ///   - macOS: there is no equivalent. A normal quit is handled by the
    ///     `ExitRequested` handler (graceful stop); a force-kill/crash of the
    ///     app can leave the child running. NOT guaranteed on macOS.
    ///
    /// `Drop` is the "app state is being discarded" path: it sends SIGKILL to
    /// the group immediately (no grace period, no blocking). The graceful
    /// path is the explicit `stop_or_kill`.
    pub struct ProcessGuard {
        /// `None` once the group has been stopped (so `Drop` doesn't signal a
        /// possibly-reused pgid a second time).
        pgid: Option<libc::pid_t>,
    }

    /// True while at least one process of group `pgid` exists (a zombie that
    /// has not been reaped yet still counts).
    pub(super) fn group_alive(pgid: libc::pid_t) -> bool {
        // SAFETY: kill(2) with signal 0 only performs the existence/permission check.
        let rc = unsafe { libc::kill(-pgid, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    fn signal_group(pgid: libc::pid_t, sig: libc::c_int) {
        // SAFETY: plain kill(2); an already-empty group just yields ESRCH.
        let _ = unsafe { libc::kill(-pgid, sig) };
    }

    impl ProcessGuard {
        /// Must be called on the `Command` BEFORE `spawn()`. Runs
        /// `setsid()` (and on Linux `prctl(PR_SET_PDEATHSIG)`) in the forked
        /// child just before exec.
        pub fn prepare(cmd: &mut Command) -> &mut Command {
            // SAFETY: the closure runs between fork and exec, where only
            // async-signal-safe functions may be called. `setsid` and `prctl`
            // are both plain syscalls; the closure allocates nothing, takes
            // no locks and touches no captured state. Errors are ignored on
            // purpose: if `setsid` failed, `kill(-pid)` later simply finds no
            // such group (ESRCH) and cannot hit anything else.
            unsafe {
                cmd.pre_exec(|| {
                    let _ = libc::setsid();
                    #[cfg(target_os = "linux")]
                    {
                        let sig = libc::SIGTERM as libc::c_ulong;
                        let zero: libc::c_ulong = 0;
                        let _ = libc::prctl(libc::PR_SET_PDEATHSIG, sig, zero, zero, zero);
                    }
                    Ok(())
                })
            }
        }

        /// Records the child's pid as its group id. Only meaningful if
        /// `prepare` ran on the command before spawn.
        pub fn attach(child: &Child) -> Result<ProcessGuard, String> {
            let pid = child.id() as libc::pid_t;
            if pid <= 1 {
                return Err(format!("refusing to guard implausible pid {pid}"));
            }
            Ok(ProcessGuard { pgid: Some(pid) })
        }

        /// SIGTERM to the whole group, wait up to ~3s (reaping the leader via
        /// `child.try_wait()` so a finished leader isn't mistaken for a live
        /// process), then SIGKILL to the group. Without a guard only the
        /// direct child is killed.
        pub fn stop_or_kill(guard: Option<ProcessGuard>, child: &mut Child) {
            let Some(mut guard) = guard else {
                let _ = child.kill();
                let _ = child.wait();
                return;
            };
            let Some(pgid) = guard.pgid.take() else {
                let _ = child.kill();
                let _ = child.wait();
                return;
            };
            signal_group(pgid, libc::SIGTERM);
            let deadline = Instant::now() + STOP_GRACE;
            loop {
                let leader_gone = !matches!(child.try_wait(), Ok(None));
                if leader_gone && !group_alive(pgid) {
                    return;
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            signal_group(pgid, libc::SIGKILL);
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    impl Drop for ProcessGuard {
        fn drop(&mut self) {
            if let Some(pgid) = self.pgid.take() {
                signal_group(pgid, libc::SIGKILL);
            }
        }
    }
}

pub use imp::ProcessGuard;

// ---------------------------------------------------------------------------
// PATH lookup
// ---------------------------------------------------------------------------

/// True for an existing regular file with at least one exec bit set
/// (symlinks are followed).
#[cfg(unix)]
pub fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// Home directory from `$HOME` (an empty value counts as unset).
#[cfg(unix)]
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// Pure-Rust PATH scan: the first directory on `$PATH` that holds `name` as
/// an executable file. Unix: exec bit required. Windows: `name` (if it
/// already has an extension) or `name.exe`, skipping Windows Store
/// `WindowsApps` redirector stubs.
// Windows resolves binaries via `where` + registry + winget (launchers.rs);
// this scan is compiled there only so its unit tests run on the dev host.
#[cfg_attr(windows, allow(dead_code))]
pub fn find_in_path(name: &str) -> Option<PathBuf> {
    // Unix: a GUI-launched app inherits a stripped-down PATH, so search the
    // login shell's PATH + well-known dirs as well (see `effective_search_path`).
    #[cfg(unix)]
    let path_var = effective_search_path();
    #[cfg(not(unix))]
    let path_var = std::env::var_os("PATH")?;
    find_in_path_var(name, &path_var)
}

/// `find_in_path` over an explicit PATH-style value (testable without
/// touching the process environment).
#[cfg_attr(windows, allow(dead_code))]
pub fn find_in_path_var(name: &str, path_var: &OsStr) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    for dir in std::env::split_paths(path_var) {
        // An empty PATH entry means "current directory" to a shell — never
        // search the cwd for a program we're about to execute.
        if dir.as_os_str().is_empty() {
            continue;
        }
        #[cfg(unix)]
        {
            let candidate = dir.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
        #[cfg(windows)]
        {
            if dir.to_string_lossy().to_lowercase().contains("windowsapps") {
                continue;
            }
            let file_name = if Path::new(name).extension().is_some() { name.to_string() } else { format!("{name}.exe") };
            let candidate = dir.join(file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Login-shell PATH (Unix)
// ---------------------------------------------------------------------------

#[cfg(any(unix, test))]
const PATH_START_MARKER: &str = "__VC_PATH_START__";
#[cfg(any(unix, test))]
const PATH_END_MARKER: &str = "__VC_PATH_END__";

/// Text between the start and end markers of the login shell's output (rc
/// files may print banners around it). Rejects empty values and anything with
/// NUL or line breaks — a PATH is a single line.
#[cfg(any(unix, test))]
fn extract_marked_path(output: &str) -> Option<String> {
    let after = &output[output.find(PATH_START_MARKER)? + PATH_START_MARKER.len()..];
    let value = &after[..after.find(PATH_END_MARKER)?];
    if value.is_empty() || value.contains(['\0', '\n', '\r']) {
        return None;
    }
    Some(value.to_string())
}

/// Order-preserving, de-duplicated union of `lists`; empty entries and entries
/// failing `keep` (existence / absoluteness check) are dropped.
#[cfg(any(unix, test))]
fn merge_path_entries(lists: &[Vec<PathBuf>], keep: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in lists.iter().flatten() {
        if dir.as_os_str().is_empty() || out.contains(dir) || !keep(dir) {
            continue;
        }
        out.push(dir.clone());
    }
    out
}

#[cfg(unix)]
mod login_path {
    use super::*;
    use std::ffi::{OsStr, OsString};
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(3);
    /// Hard cap on what we read from the shell (a banner-happy rc file).
    const MAX_OUTPUT_BYTES: u64 = 64 * 1024;
    // Constant command strings: no user/app-controlled data ever enters them.
    const POSIX_SCRIPT: &str = r#"printf "__VC_PATH_START__%s__VC_PATH_END__" "$PATH""#;
    const FISH_SCRIPT: &str = r#"printf "__VC_PATH_START__%s__VC_PATH_END__" (string join : $PATH)"#;

    fn pick_shell() -> PathBuf {
        if let Some(sh) = std::env::var_os("SHELL").map(PathBuf::from) {
            if sh.is_absolute() && is_executable_file(&sh) {
                return sh;
            }
        }
        PathBuf::from(if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/bash" })
    }

    fn run_login_shell() -> Option<String> {
        let shell = pick_shell();
        let script = if shell.file_name().is_some_and(|n| n == "fish") { FISH_SCRIPT } else { POSIX_SCRIPT };
        let mut cmd = Command::new(&shell);
        cmd.arg("-ilc").arg(script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        ProcessGuard::prepare(&mut cmd);
        let mut child = cmd.spawn().ok()?;
        let guard = ProcessGuard::attach(&child).ok();
        let Some(stdout) = child.stdout.take() else {
            ProcessGuard::stop_or_kill(guard, &mut child);
            return None;
        };
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.take(MAX_OUTPUT_BYTES).read_to_end(&mut buf);
            let _ = tx.send(buf);
        });

        let deadline = Instant::now() + LOGIN_SHELL_TIMEOUT;
        let finished = loop {
            match child.try_wait() {
                Ok(Some(_)) => break true,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                _ => break false,
            }
        };
        if !finished {
            let _ = child.kill();
        }
        // Dropping the guard SIGKILLs the whole group: background jobs started
        // by an rc file must not outlive us (or keep the pipe open).
        drop(guard);
        let _ = child.wait();
        if !finished {
            return None;
        }
        let bytes = rx.recv_timeout(Duration::from_millis(500)).ok()?;
        extract_marked_path(&String::from_utf8_lossy(&bytes))
    }

    /// The user's login-shell `$PATH` (what a terminal would see), obtained
    /// once per process; `None` if the shell failed, timed out or printed junk.
    pub fn login_shell_path() -> Option<String> {
        static CACHE: OnceLock<Option<String>> = OnceLock::new();
        CACHE.get_or_init(run_login_shell).clone()
    }

    const WELL_KNOWN_DIRS: &[&str] =
        &["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

    fn build_effective() -> OsString {
        let split = |v: &OsStr| std::env::split_paths(v).collect::<Vec<_>>();
        let login = login_shell_path().map(|p| split(OsStr::new(&p))).unwrap_or_default();
        let process = std::env::var_os("PATH").map(|v| split(&v)).unwrap_or_default();
        let mut known: Vec<PathBuf> = WELL_KNOWN_DIRS.iter().map(PathBuf::from).collect();
        if let Some(home) = home_dir() {
            known.extend([".local/bin", ".volta/bin", ".cargo/bin"].iter().map(|d| home.join(d)));
        }
        let merged = merge_path_entries(&[login, process, known], |p| p.is_absolute() && p.is_dir());
        // Entries come from split_paths, so none can contain the separator.
        std::env::join_paths(&merged).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
    }

    /// Login-shell PATH entries first, then the process PATH, then well-known
    /// install dirs; de-duplicated, existing directories only. Cached.
    pub fn effective_search_path() -> OsString {
        static CACHE: OnceLock<OsString> = OnceLock::new();
        CACHE.get_or_init(build_effective).clone()
    }

    /// One log-safe line (counts only, never the PATH contents).
    pub fn search_path_summary() -> String {
        let entries = std::env::split_paths(&effective_search_path()).count();
        let got = if login_shell_path().is_some() { "obtained" } else { "NOT obtained" };
        format!("PATH: login shell PATH {got}; effective PATH has {entries} entries")
    }
}

#[cfg(unix)]
pub use login_path::{effective_search_path, search_path_summary};

/// Parses `"v22.11.0"` / `"22.11.0"` into `(major, minor, patch)`.
#[cfg(unix)]
fn parse_version_tuple(name: &str) -> Option<(u64, u64, u64)> {
    let mut parts = name.strip_prefix('v').unwrap_or(name).split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

/// Among the sub-directories of `parent` named like `v<major>.<minor>.<patch>`
/// (the layout of nvm's `versions/node` and fnm's `node-versions`), the one
/// with the highest version.
#[cfg(unix)]
pub fn highest_version_dir(parent: &Path, major: u32) -> Option<PathBuf> {
    std::fs::read_dir(parent)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let version = parse_version_tuple(&e.file_name().to_string_lossy())?;
            (version.0 == u64::from(major) && e.path().is_dir()).then(|| (version, e.path()))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vc-platform-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn extract_marked_path_handles_banners_and_rejects_junk() {
        assert_eq!(extract_marked_path("hi\n__VC_PATH_START__/a:/b__VC_PATH_END__\nbye").as_deref(), Some("/a:/b"));
        assert_eq!(extract_marked_path("__VC_PATH_START____VC_PATH_END__"), None);
        assert_eq!(extract_marked_path("__VC_PATH_START__/a\n/b__VC_PATH_END__"), None);
        assert_eq!(extract_marked_path("__VC_PATH_START__/a\0b__VC_PATH_END__"), None);
        assert_eq!(extract_marked_path("__VC_PATH_START__/a"), None);
        assert_eq!(extract_marked_path("no markers"), None);
    }

    #[test]
    fn merge_path_entries_dedups_in_order_and_filters() {
        let p = PathBuf::from;
        let lists = vec![vec![p("/a"), p("/b"), p("")], vec![p("/b"), p("/gone"), p("/c")], vec![p("/a"), p("/d")]];
        let out = merge_path_entries(&lists, |d| d != Path::new("/gone"));
        assert_eq!(out, vec![p("/a"), p("/b"), p("/c"), p("/d")]);
    }

    #[test]
    fn exe_name_follows_platform_convention() {
        if cfg!(windows) {
            assert_eq!(exe_name("node"), "node.exe");
        } else {
            assert_eq!(exe_name("node"), "node");
        }
    }

    #[test]
    fn find_in_path_var_finds_a_launchable_file_and_skips_empty_entries() {
        let dir = tmp_dir("find");
        let file = dir.join(exe_name("vc-tool"));
        std::fs::write(&file, b"x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let other = tmp_dir("find-other");
        let path_var = std::env::join_paths([PathBuf::new(), other.clone(), dir.clone()]).unwrap();
        assert_eq!(find_in_path_var("vc-tool", &path_var), Some(file));
        assert_eq!(find_in_path_var("vc-missing-tool", &path_var), None);
        assert_eq!(find_in_path_var("", &path_var), None);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[cfg(unix)]
    #[test]
    fn find_in_path_var_ignores_files_without_exec_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir("noexec");
        let file = dir.join("vc-plain");
        std::fs::write(&file, b"x").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        let path_var = std::env::join_paths([dir.clone()]).unwrap();
        assert_eq!(find_in_path_var("vc-plain", &path_var), None);
        assert!(!is_executable_file(&file));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable_file(&file));
        assert!(!is_executable_file(&dir), "a directory is never an executable file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn highest_version_dir_picks_the_newest_matching_major() {
        let base = tmp_dir("versions");
        for v in ["v22.2.0", "v22.11.1", "v22.9.0", "v20.18.0", "v23.0.0", "not-a-version"] {
            std::fs::create_dir_all(base.join(v)).unwrap();
        }
        assert_eq!(highest_version_dir(&base, 22), Some(base.join("v22.11.1")));
        assert_eq!(highest_version_dir(&base, 18), None);
        assert_eq!(highest_version_dir(&base.join("missing"), 22), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    mod unix_guard {
        use super::super::imp::group_alive;
        use super::super::*;
        use std::process::Stdio;
        use std::time::{Duration, Instant};

        fn wait_until_group_gone(pgid: i32) -> bool {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(3) {
                if !group_alive(pgid) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            false
        }

        fn spawn_in_own_group(script: &str) -> Child {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", script]).stdout(Stdio::null()).stderr(Stdio::null());
            ProcessGuard::prepare(&mut cmd);
            cmd.spawn().expect("sh should spawn")
        }

        #[test]
        fn stop_terminates_the_whole_process_group() {
            // `sh` plus two `sleep` processes: the leader AND a grandchild.
            let mut child = spawn_in_own_group("sleep 30 & sleep 30");
            let pgid = child.id() as i32;
            std::thread::sleep(Duration::from_millis(300));
            assert!(group_alive(pgid), "group should be alive before stop");
            let guard = ProcessGuard::attach(&child).unwrap();
            ProcessGuard::stop_or_kill(Some(guard), &mut child);
            assert!(wait_until_group_gone(pgid), "every process of the group must be gone after stop");
        }

        #[test]
        fn dropping_the_guard_kills_the_group() {
            let mut child = spawn_in_own_group("sleep 30 & sleep 30");
            let pgid = child.id() as i32;
            std::thread::sleep(Duration::from_millis(300));
            let guard = ProcessGuard::attach(&child).unwrap();
            drop(guard);
            let _ = child.wait();
            assert!(wait_until_group_gone(pgid));
        }

        #[test]
        fn a_child_that_ignores_sigterm_is_killed_after_the_grace_period() {
            let mut child = spawn_in_own_group("trap '' TERM; sleep 30");
            let pgid = child.id() as i32;
            std::thread::sleep(Duration::from_millis(300));
            let guard = ProcessGuard::attach(&child).unwrap();
            let start = Instant::now();
            ProcessGuard::stop_or_kill(Some(guard), &mut child);
            assert!(start.elapsed() < Duration::from_secs(10));
            assert!(wait_until_group_gone(pgid));
        }

        #[test]
        fn stop_without_a_guard_still_kills_the_direct_child() {
            let mut child = spawn_in_own_group("sleep 30");
            ProcessGuard::stop_or_kill(None, &mut child);
            assert!(matches!(child.try_wait(), Ok(Some(_))));
        }
    }
}
