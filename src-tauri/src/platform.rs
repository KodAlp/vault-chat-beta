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
