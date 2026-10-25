#!/usr/bin/env bash
# Runs inside the vault-chat-linux container. Each step reports separately
# so one failure doesn't hide the others.
set -u
status=0

step() {
  echo
  echo "=== $1 ==="
  shift
  if "$@"; then echo "--- OK"; else echo "--- FAILED"; status=1; fi
}

step "node/rust versions" bash -c 'node -v && npm -v && rustc -V && cargo -V'
# package.json "imports" provides the #lib alias the tests import through.
step "svelte-kit sync"    npx svelte-kit sync
step "npm test"           npm test
step "vite build"         npm run build
# build.rs needs dist-server/ populated (bundle.resources glob).
step "stage server"       npm run stage:server
step "cargo build"        cargo build --manifest-path src-tauri/Cargo.toml

echo
if [ "$status" -eq 0 ]; then echo "ALL OK"; else echo "SOME STEPS FAILED"; fi
exit "$status"
