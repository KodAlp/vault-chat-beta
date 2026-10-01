//! L2 — where the key that encrypts `secrets.json` (provider API keys) lives,
//! per OS, and what the sidecar is told about it.
//!
//! * Windows: a DPAPI-sealed random 32-byte key in `<app_data_dir>/secrets.key`.
//! * macOS: the login Keychain (`keyring`, `apple-native`).
//! * Linux: the Secret Service over D-Bus (`keyring`, `sync-secret-service`) —
//!   GNOME Keyring / KWallet. Deliberately not the kernel keyutils backend,
//!   which does not survive a reboot.
//!
//! The decision logic ([`resolve_secrets_protection`]) is OS-independent and
//! sits behind the [`KeyStore`] trait so it is unit-testable everywhere. Its one
//! hard rule: a key is generated ONLY when the store positively reports that
//! none exists. If a key exists but cannot be read (corrupt blob, keychain
//! locked / access denied, ambiguous backend error) we must NOT mint a new one
//! — that would silently make the existing `secrets.json` undecryptable (and the
//! next write would destroy it). Those cases fail closed as `Locked`.
//!
//! The result reaches the Node sidecar as env `SECRETS_PROTECTION`
//! (`encrypted` | `unavailable` | `locked`) plus, for `encrypted` only,
//! `SECRETS_KEY_HEX` — see src/lib/server/providers/secrets.ts.

use std::fmt;
use std::path::{Path, PathBuf};

/// Why a [`KeyStore`] operation failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStoreError {
    /// No secure storage exists on this system at all (e.g. no Secret Service
    /// daemon on a minimal Linux desktop). Plaintext storage is then allowed.
    // Only the Linux keyring classifier (and tests) construct this variant.
    #[allow(dead_code)]
    Unavailable,
    /// A key exists or may exist but cannot be read/written right now: corrupt
    /// blob, keychain locked or access denied, or any ambiguous failure.
    Locked,
}

/// Minimal backend the decision logic needs.
pub trait KeyStore {
    /// `Ok(None)` ONLY when the store positively reports that no key exists.
    fn load(&self) -> Result<Option<[u8; 32]>, KeyStoreError>;
    fn store(&self, key: &[u8; 32]) -> Result<(), KeyStoreError>;
}

/// Outcome handed to the sidecar.
#[derive(PartialEq, Eq)]
pub enum SecretsProtection {
    Encrypted([u8; 32]),
    Unavailable,
    Locked,
}

// Hand-written so a stray `{:?}` in a log line can never print the key.
impl fmt::Debug for SecretsProtection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecretsProtection::Encrypted(_) => f.write_str("Encrypted(<redacted>)"),
            SecretsProtection::Unavailable => f.write_str("Unavailable"),
            SecretsProtection::Locked => f.write_str("Locked"),
        }
    }
}

impl SecretsProtection {
    /// Value of the `SECRETS_PROTECTION` env var.
    pub fn env_value(&self) -> &'static str {
        match self {
            SecretsProtection::Encrypted(_) => "encrypted",
            SecretsProtection::Unavailable => "unavailable",
            SecretsProtection::Locked => "locked",
        }
    }

    /// Value of `SECRETS_KEY_HEX`, set only when a key is available.
    pub fn key_hex(&self) -> Option<String> {
        match self {
            SecretsProtection::Encrypted(key) => Some(crate::hex_encode(key)),
            _ => None,
        }
    }
}

/// OS-independent decision logic (see the module doc for the rules).
pub fn resolve_secrets_protection(
    store: &dyn KeyStore,
    generate: &dyn Fn() -> Result<[u8; 32], String>,
) -> SecretsProtection {
    match store.load() {
        Ok(Some(key)) => SecretsProtection::Encrypted(key),
        Err(KeyStoreError::Unavailable) => SecretsProtection::Unavailable,
        Err(KeyStoreError::Locked) => SecretsProtection::Locked,
        Ok(None) => {
            // Fail closed if we cannot even generate: plaintext would be a
            // silent downgrade for a system that does have secure storage.
            let Ok(key) = generate() else {
                return SecretsProtection::Locked;
            };
            match store.store(&key) {
                Ok(()) => SecretsProtection::Encrypted(key),
                Err(KeyStoreError::Unavailable) => SecretsProtection::Unavailable,
                Err(KeyStoreError::Locked) => SecretsProtection::Locked,
            }
        }
    }
}

pub fn random_key() -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).map_err(|e| format!("anahtar üretilemedi: {e}"))?;
    Ok(key)
}

/// Production entry point: resolves the protection state with this OS's
/// backend. Blocking (D-Bus / Keychain / file IO) — call from a blocking
/// context.
pub fn load_secrets_protection(app_data_dir: &Path) -> SecretsProtection {
    let _ = app_data_dir; // only the Windows backend is file based
    #[cfg(windows)]
    {
        resolve_secrets_protection(&dpapi::DpapiFileStore::new(app_data_dir), &random_key)
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        resolve_secrets_protection(&os_keyring::KeyringStore, &random_key)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        SecretsProtection::Unavailable
    }
}

/// 64 hex chars -> 32 bytes. `None` for anything else (a corrupt entry must be
/// reported as `Locked`, never overwritten).
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn decode_key_hex(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 || !s.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Linux: does this (Display text of a) keyring `PlatformFailure` mean there is
/// no Secret Service / D-Bus session at all, as opposed to a daemon that is
/// present but failing? keyring wraps dbus-secret-service errors opaquely
/// (`Box<dyn Error>`), and the dbus crate's error name is not reachable from
/// here, so this matches on the message text. Only unambiguous "nobody is
/// listening" markers count; anything else is treated as `Locked`.
#[cfg(any(target_os = "linux", test))]
fn linux_platform_failure_means_no_service(text: &str) -> bool {
    const MARKERS: &[&str] = &[
        // dbus-secret-service's own Error::Unavailable
        "No DBus session or Secret Service provider found",
        // no daemon registered/activatable for org.freedesktop.secrets
        "org.freedesktop.DBus.Error.ServiceUnknown",
        "was not provided by any .service files",
        "org.freedesktop.DBus.Error.NameHasNoOwner",
        // no session bus at all (headless / ssh without a bus)
        "DBUS_SESSION_BUS_ADDRESS",
        "Failed to connect to socket",
    ];
    MARKERS.iter().any(|m| text.contains(m))
}

/// Steps of the user-initiated recovery from a permanently "locked" secrets
/// store (see [`reset_secrets_storage_with`]). Injectable so the ordering and
/// rollback rules are unit-testable without touching the OS.
pub trait ResetOps {
    /// Rename (never delete) `secrets.json` to `secrets.json.locked-<ts>`.
    /// `Ok(None)` when there is no such file.
    fn set_aside_secrets_file(&self, timestamp: &str) -> Result<Option<PathBuf>, String>;
    /// Undo [`ResetOps::set_aside_secrets_file`] (rename the backup back).
    fn restore_secrets_file(&self, backup: &Path) -> Result<(), String>;
    /// Remove the key: Windows renames `secrets.key` to `secrets.key.locked-<ts>`,
    /// macOS/Linux delete the keyring entry. An absent key is success.
    fn remove_key(&self, timestamp: &str) -> Result<(), String>;
}

/// Order: (1) set `secrets.json` aside, (2) remove the key, and if (2) fails,
/// (3) put `secrets.json` back and return the error. The dangerous state is a
/// FRESH key next to the OLD encrypted file (nothing could decrypt it, and
/// every write would be refused). Removing the key first could leave exactly
/// that if the rename then failed; this order never can — whichever step
/// fails, either nothing changed (after rollback) or the old file is already
/// out of the way. A new key is only ever generated on the next launch, after
/// both steps succeeded.
pub fn reset_secrets_storage_with(ops: &dyn ResetOps, timestamp: &str) -> Result<Option<PathBuf>, String> {
    let backup = ops.set_aside_secrets_file(timestamp)?;
    if let Err(key_err) = ops.remove_key(timestamp) {
        if let Some(b) = &backup {
            if let Err(restore_err) = ops.restore_secrets_file(b) {
                return Err(format!(
                    "{key_err}; ayrıca secrets.json geri alınamadı ({restore_err}), yedek: {}",
                    b.display()
                ));
            }
        }
        return Err(key_err);
    }
    Ok(backup)
}

/// `secrets.json` + `20231114T221320Z` -> `secrets.json.locked-20231114T221320Z`.
pub fn locked_backup_name(file_name: &str, timestamp: &str) -> String {
    format!("{file_name}.locked-{timestamp}")
}

/// `YYYYMMDDTHHMMSSZ` for a Unix time (UTC; civil-from-days, no date crate).
pub fn utc_timestamp(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}T{h:02}{mi:02}{s:02}Z")
}

pub fn utc_timestamp_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    utc_timestamp(secs)
}

/// Production [`ResetOps`] over `<app_data_dir>`.
pub struct OsResetOps {
    dir: PathBuf,
}

impl OsResetOps {
    pub fn new(app_data_dir: &Path) -> Self {
        Self { dir: app_data_dir.to_path_buf() }
    }
}

impl ResetOps for OsResetOps {
    fn set_aside_secrets_file(&self, timestamp: &str) -> Result<Option<PathBuf>, String> {
        let src = self.dir.join("secrets.json");
        if !src.exists() {
            return Ok(None);
        }
        let dst = self.dir.join(locked_backup_name("secrets.json", timestamp));
        std::fs::rename(&src, &dst).map_err(|e| format!("secrets.json yedeklenemedi: {e}"))?;
        Ok(Some(dst))
    }

    fn restore_secrets_file(&self, backup: &Path) -> Result<(), String> {
        std::fs::rename(backup, self.dir.join("secrets.json")).map_err(|e| e.to_string())
    }

    fn remove_key(&self, timestamp: &str) -> Result<(), String> {
        #[cfg(windows)]
        {
            let src = self.dir.join("secrets.key");
            if !src.exists() {
                return Ok(());
            }
            let dst = self.dir.join(locked_backup_name("secrets.key", timestamp));
            std::fs::rename(&src, &dst).map_err(|e| format!("secrets.key yedeklenemedi: {e}"))
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let _ = timestamp; // the keyring entry is deleted, not renamed
            os_keyring::delete_key()
        }
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        {
            let _ = timestamp;
            Ok(())
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod os_keyring {
    use super::{decode_key_hex, KeyStore, KeyStoreError};

    const SERVICE: &str = "app.vaultchat.desktop";
    const USER: &str = "secrets-key";

    pub struct KeyringStore;

    fn entry() -> Result<keyring::Entry, KeyStoreError> {
        // Entry::new only validates attribute lengths; failure is not "no
        // secure storage", so fail closed.
        keyring::Entry::new(SERVICE, USER).map_err(|_| KeyStoreError::Locked)
    }

    /// Linux only: a `PlatformFailure` whose text says nobody is listening on
    /// D-Bus for the Secret Service.
    #[cfg(target_os = "linux")]
    fn is_no_service(err: &keyring::Error) -> bool {
        match err {
            keyring::Error::PlatformFailure(inner) => {
                super::linux_platform_failure_means_no_service(&inner.to_string())
            }
            _ => false,
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn is_no_service(_err: &keyring::Error) -> bool {
        false
    }

    /// NoStorageAccess (locked / denied / prompt dismissed), macOS Keychain
    /// failures, BadEncoding, Ambiguous and anything new all fail closed.
    fn classify(err: &keyring::Error) -> KeyStoreError {
        if is_no_service(err) {
            KeyStoreError::Unavailable
        } else {
            KeyStoreError::Locked
        }
    }

    /// Deletes the stored key. An absent entry — or, on Linux, no Secret
    /// Service at all (so nothing can be stored there) — counts as success.
    pub fn delete_key() -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, USER).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) if classify(&e) == KeyStoreError::Unavailable => Ok(()),
            Err(e) => Err(format!("anahtar zincirindeki kayıt silinemedi: {e}")),
        }
    }

    impl KeyStore for KeyringStore {
        fn load(&self) -> Result<Option<[u8; 32]>, KeyStoreError> {
            match entry()?.get_password() {
                Ok(hex) => decode_key_hex(&hex).map(Some).ok_or(KeyStoreError::Locked),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(classify(&e)),
            }
        }

        fn store(&self, key: &[u8; 32]) -> Result<(), KeyStoreError> {
            entry()?.set_password(&crate::hex_encode(key)).map_err(|e| classify(&e))
        }
    }
}

#[cfg(windows)]
mod dpapi {
    use super::{KeyStore, KeyStoreError};
    use std::path::{Path, PathBuf};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    /// `<app_data_dir>/secrets.key`: the key sealed with CryptProtectData (no
    /// extra entropy, so tied to the current Windows user profile — the same
    /// scope as browser-saved passwords).
    pub struct DpapiFileStore {
        path: PathBuf,
    }

    impl DpapiFileStore {
        pub fn new(app_data_dir: &Path) -> Self {
            Self { path: app_data_dir.join("secrets.key") }
        }
    }

    fn unprotect(blob: &mut [u8]) -> Option<Vec<u8>> {
        let in_blob = CRYPT_INTEGER_BLOB { cbData: blob.len() as u32, pbData: blob.as_mut_ptr() };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        let ok = unsafe {
            CryptUnprotectData(&in_blob, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out_blob)
        };
        if ok.is_err() {
            return None;
        }
        let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
        unsafe {
            let _ = LocalFree(Some(HLOCAL(out_blob.pbData as *mut core::ffi::c_void)));
        }
        Some(out)
    }

    fn protect(plain: &mut [u8]) -> Option<Vec<u8>> {
        let in_blob = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_mut_ptr() };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        let ok = unsafe {
            CryptProtectData(&in_blob, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out_blob)
        };
        if ok.is_err() {
            return None;
        }
        let sealed = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
        unsafe {
            let _ = LocalFree(Some(HLOCAL(out_blob.pbData as *mut core::ffi::c_void)));
        }
        Some(sealed)
    }

    impl KeyStore for DpapiFileStore {
        fn load(&self) -> Result<Option<[u8; 32]>, KeyStoreError> {
            let mut blob = match std::fs::read(&self.path) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(KeyStoreError::Locked),
            };
            // Corrupt blob / other user profile / wrong length: a key
            // existed, so never regenerate.
            let plain = unprotect(&mut blob).ok_or(KeyStoreError::Locked)?;
            <[u8; 32]>::try_from(plain.as_slice()).map(Some).map_err(|_| KeyStoreError::Locked)
        }

        fn store(&self, key: &[u8; 32]) -> Result<(), KeyStoreError> {
            let mut plain = *key;
            let sealed = protect(&mut plain).ok_or(KeyStoreError::Locked)?;
            std::fs::write(&self.path, sealed).map_err(|_| KeyStoreError::Locked)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct MockStore {
        load: Result<Option<[u8; 32]>, KeyStoreError>,
        store: Result<(), KeyStoreError>,
        stored: RefCell<Vec<[u8; 32]>>,
    }

    impl MockStore {
        fn new(load: Result<Option<[u8; 32]>, KeyStoreError>) -> Self {
            Self { load, store: Ok(()), stored: RefCell::new(Vec::new()) }
        }
    }

    impl KeyStore for MockStore {
        fn load(&self) -> Result<Option<[u8; 32]>, KeyStoreError> {
            self.load
        }
        fn store(&self, key: &[u8; 32]) -> Result<(), KeyStoreError> {
            self.stored.borrow_mut().push(*key);
            self.store
        }
    }

    const GENERATED: [u8; 32] = [7u8; 32];
    const EXISTING: [u8; 32] = [9u8; 32];

    fn gen_ok() -> Result<[u8; 32], String> {
        Ok(GENERATED)
    }

    #[test]
    fn no_entry_generates_stores_and_uses_the_new_key() {
        let s = MockStore::new(Ok(None));
        assert_eq!(resolve_secrets_protection(&s, &gen_ok), SecretsProtection::Encrypted(GENERATED));
        assert_eq!(*s.stored.borrow(), vec![GENERATED]);
    }

    #[test]
    fn existing_key_is_reused_and_nothing_is_stored() {
        let s = MockStore::new(Ok(Some(EXISTING)));
        assert_eq!(resolve_secrets_protection(&s, &gen_ok), SecretsProtection::Encrypted(EXISTING));
        assert!(s.stored.borrow().is_empty());
    }

    #[test]
    fn locked_read_fails_closed_and_never_stores_a_new_key() {
        let s = MockStore::new(Err(KeyStoreError::Locked));
        assert_eq!(resolve_secrets_protection(&s, &gen_ok), SecretsProtection::Locked);
        assert!(s.stored.borrow().is_empty());
    }

    #[test]
    fn unavailable_read_reports_unavailable_and_never_stores() {
        let s = MockStore::new(Err(KeyStoreError::Unavailable));
        assert_eq!(resolve_secrets_protection(&s, &gen_ok), SecretsProtection::Unavailable);
        assert!(s.stored.borrow().is_empty());
    }

    #[test]
    fn failed_store_after_no_entry_is_not_reported_as_encrypted() {
        let mut s = MockStore::new(Ok(None));
        s.store = Err(KeyStoreError::Locked);
        assert_eq!(resolve_secrets_protection(&s, &gen_ok), SecretsProtection::Locked);
        let mut s = MockStore::new(Ok(None));
        s.store = Err(KeyStoreError::Unavailable);
        assert_eq!(resolve_secrets_protection(&s, &gen_ok), SecretsProtection::Unavailable);
    }

    #[test]
    fn generation_failure_fails_closed() {
        let s = MockStore::new(Ok(None));
        let bad = || Err::<[u8; 32], String>("no entropy".to_string());
        assert_eq!(resolve_secrets_protection(&s, &bad), SecretsProtection::Locked);
        assert!(s.stored.borrow().is_empty());
    }

    struct MockReset {
        log: RefCell<Vec<String>>,
        has_file: bool,
        fail_set_aside: bool,
        fail_key: bool,
        fail_restore: bool,
    }

    impl MockReset {
        fn new() -> Self {
            Self { log: RefCell::new(Vec::new()), has_file: true, fail_set_aside: false, fail_key: false, fail_restore: false }
        }
    }

    impl ResetOps for MockReset {
        fn set_aside_secrets_file(&self, ts: &str) -> Result<Option<PathBuf>, String> {
            self.log.borrow_mut().push("set_aside".into());
            if self.fail_set_aside {
                return Err("rename failed".into());
            }
            Ok(self.has_file.then(|| PathBuf::from(locked_backup_name("secrets.json", ts))))
        }
        fn restore_secrets_file(&self, _backup: &Path) -> Result<(), String> {
            self.log.borrow_mut().push("restore".into());
            if self.fail_restore {
                Err("restore failed".into())
            } else {
                Ok(())
            }
        }
        fn remove_key(&self, _ts: &str) -> Result<(), String> {
            self.log.borrow_mut().push("remove_key".into());
            if self.fail_key {
                Err("key busy".into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn reset_sets_the_file_aside_before_removing_the_key() {
        let m = MockReset::new();
        let backup = reset_secrets_storage_with(&m, "20231114T221320Z").unwrap();
        assert_eq!(backup, Some(PathBuf::from("secrets.json.locked-20231114T221320Z")));
        assert_eq!(*m.log.borrow(), vec!["set_aside", "remove_key"]);
    }

    #[test]
    fn reset_without_a_secrets_file_still_removes_the_key() {
        let mut m = MockReset::new();
        m.has_file = false;
        assert_eq!(reset_secrets_storage_with(&m, "t").unwrap(), None);
        assert_eq!(*m.log.borrow(), vec!["set_aside", "remove_key"]);
    }

    #[test]
    fn reset_stops_before_the_key_if_the_file_cannot_be_set_aside() {
        let mut m = MockReset::new();
        m.fail_set_aside = true;
        assert!(reset_secrets_storage_with(&m, "t").is_err());
        assert_eq!(*m.log.borrow(), vec!["set_aside"]);
    }

    #[test]
    fn reset_rolls_the_file_back_if_the_key_cannot_be_removed() {
        let mut m = MockReset::new();
        m.fail_key = true;
        assert_eq!(reset_secrets_storage_with(&m, "t").unwrap_err(), "key busy");
        assert_eq!(*m.log.borrow(), vec!["set_aside", "remove_key", "restore"]);
    }

    #[test]
    fn reset_reports_a_failed_rollback_with_the_backup_path() {
        let mut m = MockReset::new();
        m.fail_key = true;
        m.fail_restore = true;
        let err = reset_secrets_storage_with(&m, "t").unwrap_err();
        assert!(err.contains("key busy") && err.contains("restore failed") && err.contains("secrets.json.locked-t"), "{err}");
    }

    #[test]
    fn backup_naming_and_utc_timestamps() {
        assert_eq!(locked_backup_name("secrets.key", "20231114T221320Z"), "secrets.key.locked-20231114T221320Z");
        assert_eq!(utc_timestamp(0), "19700101T000000Z");
        assert_eq!(utc_timestamp(1_700_000_000), "20231114T221320Z");
        assert_eq!(utc_timestamp(951_782_400), "20000229T000000Z"); // leap day
        let now = utc_timestamp_now();
        assert_eq!(now.len(), 16);
        assert!(now.ends_with('Z') && now.as_bytes()[8] == b'T');
    }

    #[test]
    fn env_values_and_key_hex() {
        let enc = SecretsProtection::Encrypted([0xab; 32]);
        assert_eq!(enc.env_value(), "encrypted");
        assert_eq!(enc.key_hex().as_deref(), Some("ab".repeat(32).as_str()));
        assert_eq!(SecretsProtection::Unavailable.env_value(), "unavailable");
        assert_eq!(SecretsProtection::Locked.env_value(), "locked");
        assert_eq!(SecretsProtection::Unavailable.key_hex(), None);
        assert_eq!(SecretsProtection::Locked.key_hex(), None);
    }

    #[test]
    fn debug_never_prints_the_key() {
        let shown = format!("{:?}", SecretsProtection::Encrypted([0xab; 32]));
        assert!(!shown.contains("ab") && !shown.contains("171"), "{shown}");
    }

    #[test]
    fn decode_key_hex_accepts_only_64_hex_chars() {
        assert_eq!(decode_key_hex(&"09".repeat(32)), Some([9u8; 32]));
        assert_eq!(decode_key_hex(&format!("{}\n", "0a".repeat(32))), Some([10u8; 32]));
        assert_eq!(decode_key_hex(&"09".repeat(31)), None);
        assert_eq!(decode_key_hex(&"zz".repeat(32)), None);
        assert_eq!(decode_key_hex(""), None);
        assert_eq!(decode_key_hex(&"é".repeat(32)), None);
    }

    #[test]
    fn linux_error_text_classification() {
        // Daemon / bus absent -> no secure storage.
        for text in [
            "Platform secure storage failure: No DBus session or Secret Service provider found",
            "Platform secure storage failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files",
            "DBus error: org.freedesktop.DBus.Error.ServiceUnknown",
            "DBus error: Failed to connect to socket /run/user/1000/bus: No such file or directory",
        ] {
            assert!(linux_platform_failure_means_no_service(text), "{text}");
        }
        // Daemon present but something else went wrong -> ambiguous -> Locked.
        for text in [
            "DBus error: Did not receive a reply. Possible causes include: the remote application did not send a reply",
            "Crypto error: bad key",
            "Secret Service: object locked",
            "",
        ] {
            assert!(!linux_platform_failure_means_no_service(text), "{text}");
        }
    }
}

#[cfg(all(test, windows))]
mod dpapi_tests {
    use super::dpapi::DpapiFileStore;
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vault-chat-dpapi-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn encrypted_key(p: SecretsProtection) -> [u8; 32] {
        match p {
            SecretsProtection::Encrypted(k) => k,
            other => panic!("expected Encrypted, got {other:?}"),
        }
    }

    #[test]
    fn generates_and_persists_a_32_byte_key() {
        let dir = tmp_dir("persist");
        let key1 = encrypted_key(load_secrets_protection(&dir));
        assert!(dir.join("secrets.key").exists());

        // A second call (the next app launch) must unwrap the SAME key, not
        // mint a new one — otherwise every launch would invalidate the
        // previous launch's encrypted secrets.json.
        let key2 = encrypted_key(load_secrets_protection(&dir));
        assert_eq!(key1, key2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_blob_is_locked_and_left_untouched() {
        let dir = tmp_dir("corrupt");
        std::fs::write(dir.join("secrets.key"), b"not a real DPAPI blob").unwrap();
        assert_eq!(resolve_secrets_protection(&DpapiFileStore::new(&dir), &random_key), SecretsProtection::Locked);
        assert_eq!(std::fs::read(dir.join("secrets.key")).unwrap(), b"not a real DPAPI blob");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Prints the hex-encoded key for a fresh temp dir so the Node side's
    /// EncryptedSecretStore can be exercised against a REAL DPAPI-round-tripped
    /// key from this same machine/user — run with `cargo test -- --nocapture
    /// print_key_for_node_interop_check`.
    #[test]
    fn print_key_for_node_interop_check() {
        let dir = tmp_dir("interop");
        let hex = load_secrets_protection(&dir).key_hex().expect("key generation should succeed");
        println!("SECRETS_KEY_HEX={hex}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
