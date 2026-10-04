#!/usr/bin/env bash
# Builds the .deb/.AppImage inside the container, installs the .deb and
# launches it under a virtual X display to check it starts without crashing.
# Mount a host folder at /out to get the packages, logs and screenshot back.
set -u
OUT=/out
mkdir -p "$OUT"
status=0

step() {
  echo
  echo "=== $1 ==="
  shift
  if "$@"; then echo "--- OK"; else echo "--- FAILED"; status=1; fi
}

# linuxdeploy is itself an AppImage; containers have no FUSE.
export APPIMAGE_EXTRACT_AND_RUN=1
BUNDLE=src-tauri/target/release/bundle

step "svelte-kit sync" npx svelte-kit sync
step "tauri build"     npx tauri build
step "copy .deb"       bash -c "cp $BUNDLE/deb/*.deb '$OUT'/"
step "copy .AppImage"  bash -c "cp $BUNDLE/appimage/*.AppImage '$OUT'/"
step "install .deb"    bash -c "apt-get update -qq && apt-get install -y -qq ./$BUNDLE/deb/*.deb"

smoke() {
  local log="$OUT/launch.log"
  # Software rendering: there is no GPU in the container.
  export WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1
  Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
  local xvfb=$!
  export DISPLAY=:99
  sleep 2
  # Launch whatever the installed .desktop entry runs (binary name comes from Cargo).
  local exe
  exe=$(grep -m1 '^Exec=' /usr/share/applications/vault-chat.desktop | cut -d= -f2 | cut -d' ' -f1)
  echo "launching: $exe"
  dbus-run-session -- "$exe" >"$log" 2>&1 &
  local app=$!
  sleep 40
  import -window root "$OUT/screenshot.png" 2>/dev/null || echo "(screenshot failed)"
  local alive=0
  if kill -0 "$app" 2>/dev/null; then alive=1; fi
  kill "$app" 2>/dev/null; kill "$xvfb" 2>/dev/null
  wait "$app" 2>/dev/null
  echo "--- launch.log (last 30 lines)"
  tail -30 "$log"
  if [ "$alive" -ne 1 ]; then echo "app exited before 40s"; return 1; fi
  echo "app still running after 40s"
  grep -q "Listening on" "$log" && echo "sidecar server came up" || echo "(no 'Listening on' line in stdout)"
}
step "launch smoke test" smoke

echo
if [ "$status" -eq 0 ]; then echo "ALL OK"; else echo "SOME STEPS FAILED"; fi
exit "$status"
