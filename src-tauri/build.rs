use std::process::Command;

fn main() {
  // The Node major this build's better-sqlite3 native addon was compiled
  // against — read from the BUILD machine's `node --version` (the same
  // machine npm/electron-rebuild-style native builds run on), not something
  // guessed once and left to drift. lib.rs's spawn_sidecar() compares this
  // against the SIDECAR's own `node --version` at every launch (see
  // VAULTCHAT_NODE_MAJOR/parse_node_major_version there) — a mismatched
  // major means a different Node ABI (NODE_MODULE_VERSION), which fails to
  // load the compiled .node file rather than just "maybe working slightly
  // wrong".
  println!("cargo:rerun-if-changed=../package.json");
  let major = detect_node_major().unwrap_or_else(|| {
    parse_engines_lower_bound_from_package_json().unwrap_or(22)
  });
  println!("cargo:rustc-env=VAULTCHAT_NODE_MAJOR={major}");

  tauri_build::build()
}

/// Runs `node --version` on the build machine and parses its major version.
/// Deliberately NOT shared as a crate dependency with lib.rs's own
/// `parse_node_major_version` (same logic, different file) — build.rs
/// compiles and runs before the crate it's building is itself a linkable
/// artifact, so there's no earlier point to put one shared copy other than
/// a whole separate helper crate, which isn't justified for one small parser.
fn detect_node_major() -> Option<u32> {
  let output = Command::new("node").arg("--version").output().ok()?;
  if !output.status.success() {
    return None;
  }
  parse_node_major(&String::from_utf8_lossy(&output.stdout))
}

fn parse_node_major(version_text: &str) -> Option<u32> {
  let trimmed = version_text.trim();
  let no_v = trimmed.strip_prefix('v').unwrap_or(trimmed);
  let major_str = no_v.split('.').next()?;
  if major_str.is_empty() {
    return None;
  }
  major_str.parse().ok()
}

/// Fallback for a build machine where `node` isn't runnable at all (a clean
/// CI image before its own Node setup step, say): parse package.json's
/// `engines.node` field (e.g. `">=22 <23"`) for its lower bound, rather than
/// hardcoding `22` a second time in a place that could silently drift from
/// package.json's own declared requirement.
fn parse_engines_lower_bound_from_package_json() -> Option<u32> {
  let raw = std::fs::read_to_string("../package.json").ok()?;
  // package.json is a file this repo controls and is well-formed JSON, so a
  // plain substring search for the `"node"` key's value is enough here —
  // not worth adding serde_json to [build-dependencies] for one scalar
  // field read only as a last-resort fallback.
  let key_pos = raw.find("\"node\"")?;
  let after_key = &raw[key_pos + "\"node\"".len()..];
  let value_start = after_key.find('"')? + 1; // skip past ':' to the value's opening quote
  let after_quote = &after_key[value_start..];
  let value_end = after_quote.find('"')?;
  let value = &after_quote[..value_end]; // e.g. ">=22 <23"
  let after_gte = value.split(">=").nth(1)?;
  let digits: String = after_gte.chars().take_while(|c| c.is_ascii_digit()).collect();
  if digits.is_empty() {
    None
  } else {
    digits.parse().ok()
  }
}
