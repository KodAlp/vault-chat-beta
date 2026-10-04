# Linux checks for vault-chat (run from a linux-destegi checkout — main has no Linux support).
# Build:   docker build -f docker/linux-test.Dockerfile -t vault-chat-linux .
# Test:    docker run --rm vault-chat-linux
# Package: docker run --rm -v "${PWD}/docker-out:/out" vault-chat-linux bash docker/linux-package.sh
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Tauri v2 Linux dependencies (same set as .github/workflows/desktop.yml), the
# toolchain for native npm modules (better-sqlite3), and a headless X server +
# screenshot tool for the launch smoke test.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file ca-certificates pkg-config git python3 \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
      librsvg2-dev libssl-dev libxdo-dev patchelf libsecret-1-dev libdbus-1-dev \
      xdg-utils xvfb xauth dbus-x11 imagemagick \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (package.json engines: >=22 <23).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Rust (stable, minimal profile).
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

WORKDIR /app

# Dependencies first so source edits don't re-run npm ci.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["bash", "docker/linux-test.sh"]
