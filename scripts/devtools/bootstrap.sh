#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CACHE="$ROOT/.devtools/cache"
TOOLS="$ROOT/.devtools/toolchains"
NODE_VERSION=22.19.0
RUST_VERSION=1.98.0
UV_VERSION=0.12.0
mkdir -p "$CACHE" "$TOOLS"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing bootstrap dependency: $1" >&2; exit 1; }; }
need curl
need tar

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) node_os=linux; rust_os=unknown-linux-gnu ;;
  Darwin) node_os=darwin; rust_os=apple-darwin ;;
  *) echo "unsupported bootstrap OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) node_arch=x64; rust_arch=x86_64 ;;
  aarch64|arm64) node_arch=arm64; rust_arch=aarch64 ;;
  *) echo "unsupported bootstrap architecture: $arch" >&2; exit 1 ;;
esac

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

download() {
  url=$1
  target=$2
  if [ ! -f "$target" ]; then
    echo "download: $url" >&2
    curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$url" -o "$target"
  fi
}

download_node() {
  archive="node-v${NODE_VERSION}-${node_os}-${node_arch}.tar.gz"
  archive_path="$CACHE/$archive"
  sums="$CACHE/node-${NODE_VERSION}-SHASUMS256.txt"
  download "https://nodejs.org/dist/v${NODE_VERSION}/$archive" "$archive_path"
  download "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" "$sums"
  expected=$(awk -v file="$archive" '$2 == file { print $1 }' "$sums")
  [ -n "$expected" ] || { echo "Node checksum entry not found: $archive" >&2; exit 1; }
  actual=$(sha256_file "$archive_path")
  [ "$actual" = "$expected" ] || { echo "Node SHA-256 mismatch" >&2; exit 1; }
  printf '%s\n' "$archive_path"
}

install_node() {
  archive_path=$(download_node)
  prefix="$TOOLS/node/$NODE_VERSION"
  if [ ! -x "$prefix/bin/node" ]; then
    rm -rf "$prefix"
    mkdir -p "$prefix"
    tar -xzf "$archive_path" --strip-components=1 -C "$prefix"
  fi
  PATH="$prefix/bin:$PATH"
  export PATH
}

node_is_pinned() {
  command -v node >/dev/null 2>&1 && [ "$(node --version 2>/dev/null)" = "v$NODE_VERSION" ]
}

profile_needs_rust() {
  case "$1" in test|native|full) return 0 ;; *) return 1 ;; esac
}

profile_needs_python() {
  case "$1" in python|full) return 0 ;; *) return 1 ;; esac
}

download_rustup() {
  triple="${rust_arch}-${rust_os}"
  bin="$CACHE/rustup-init-$triple"
  sum="$CACHE/rustup-init-$triple.sha256"
  download "https://static.rust-lang.org/rustup/dist/$triple/rustup-init" "$bin"
  download "https://static.rust-lang.org/rustup/dist/$triple/rustup-init.sha256" "$sum"
  expected=$(awk '{print $1; exit}' "$sum")
  actual=$(sha256_file "$bin")
  [ "$actual" = "$expected" ] || { echo "rustup-init SHA-256 mismatch" >&2; exit 1; }
  chmod +x "$bin"
  printf '%s\n' "$bin"
}

install_rust() {
  if [ -d "$HOME/.cargo/bin" ]; then
    PATH="$HOME/.cargo/bin:$PATH"
    export PATH
  fi
  if command -v rustup >/dev/null 2>&1; then
    rustup toolchain install "$RUST_VERSION" --profile minimal --component rustfmt --component clippy
  else
    rustup_bin=$(download_rustup)
    "$rustup_bin" -y --profile minimal --default-toolchain "$RUST_VERSION" --component rustfmt --component clippy
    PATH="$HOME/.cargo/bin:$PATH"
    export PATH
  fi
  rustup override set "$RUST_VERSION"
}

install_uv() {
  if command -v uv >/dev/null 2>&1 && uv --version | grep -q "$UV_VERSION"; then return; fi
  py=python3
  command -v "$py" >/dev/null 2>&1 || py=python
  command -v "$py" >/dev/null 2>&1 || { echo "Python >=3.10 is required for the python/full profile" >&2; exit 1; }
  "$py" -m pip install --user "uv==$UV_VERSION"
}

command=${1:-setup}
profile=${2:-minimal}

case "$command" in
  download)
    download_node >/dev/null
    if profile_needs_rust "$profile"; then download_rustup >/dev/null; fi
    echo "Verified bootstrap downloads are cached in $CACHE"
    echo "Project dependency archives are populated later by pnpm/cargo/uv using their committed lock files."
    exit 0
    ;;
esac

if ! node_is_pinned; then install_node; fi
if [ -d "$HOME/.cargo/bin" ]; then
  PATH="$HOME/.cargo/bin:$PATH"
  export PATH
fi

if [ "$command" = "setup" ]; then
  if profile_needs_rust "$profile"; then install_rust; fi
  if profile_needs_python "$profile"; then install_uv; fi
fi

exec node "$ROOT/scripts/devtools/dev.mjs" "$@"
