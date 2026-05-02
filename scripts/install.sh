#!/usr/bin/env sh
set -eu

REPO="${OAH_UPDATE_REPO:-fairyshine/OpenAgentHarness}"
API_BASE_URL="${OAH_RELEASE_API_BASE_URL:-https://api.github.com/repos/$REPO}"
RELEASE_BASE_URL="${OAH_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download}"
INSTALL_ROOT="${OAH_INSTALL_ROOT:-${OAH_HOME:-$HOME/.openagentharness}}"
VERSION="${OAH_UPDATE_VERSION:-latest-prerelease}"
CHANNEL="${OAH_UPDATE_CHANNEL:-latest-prerelease}"
GITHUB_USER_AGENT="${OAH_GITHUB_USER_AGENT:-OpenAgentHarness installer}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    return 1
  fi
}

github_get() {
  curl -fsSL -H "User-Agent: $GITHUB_USER_AGENT" "$@"
}

detect_asset() {
  os_name="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch_name="$(uname -m | tr '[:upper:]' '[:lower:]')"
  bin_name="oah"

  case "$os_name" in
    darwin)
      case "$arch_name" in
        x86_64 | amd64) asset="macos-x86_64" ;;
        arm64 | aarch64) asset="macos-aarch64" ;;
        *) return 1 ;;
      esac
      ;;
    linux)
      case "$arch_name" in
        x86_64 | amd64) asset="linux-x86_64" ;;
        arm64 | aarch64) asset="linux-aarch64" ;;
        *) return 1 ;;
      esac
      ;;
    mingw* | msys* | cygwin*)
      bin_name="oah.cmd"
      case "$arch_name" in
        x86_64 | amd64) asset="windows-x86_64" ;;
        arm64 | aarch64) asset="windows-aarch64" ;;
        *) return 1 ;;
      esac
      ;;
    *)
      return 1
      ;;
  esac

  printf '%s %s\n' "$asset" "$bin_name"
}

latest_prerelease_tag() {
  json="$(github_get "$API_BASE_URL/releases")"
  printf '%s\n' "$json" \
    | tr ',' '\n' \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}

latest_stable_tag() {
  json="$(github_get "$API_BASE_URL/releases/latest")"
  printf '%s\n' "$json" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    return 1
  fi
}

verify_checksum() {
  archive_path="$1"
  checksum_path="$2"
  expected="$(awk '{print $1; exit}' "$checksum_path")"
  actual="$(sha256_of "$archive_path")"
  if [ "$actual" != "$expected" ]; then
    echo "Checksum mismatch for $(basename "$archive_path")." >&2
    return 1
  fi
}

write_root_shim() {
  mkdir -p "$INSTALL_ROOT/bin"
  cat > "$INSTALL_ROOT/bin/oah" <<'EOF'
#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export OAH_INSTALL_ROOT="${OAH_INSTALL_ROOT:-$ROOT}"
exec "$ROOT/current/bin/oah" "$@"
EOF
  chmod +x "$INSTALL_ROOT/bin/oah"
}

install_release() {
  need_cmd curl
  need_cmd tar
  need_cmd uname
  need_cmd mktemp
  need_cmd sed
  need_cmd awk
  need_cmd tr
  need_cmd head

  detected="$(detect_asset)" || {
    echo "Unsupported platform: $(uname -s) $(uname -m)" >&2
    return 1
  }
  set -- $detected
  asset="$1"
  bin_name="$2"

  case "$VERSION" in
    latest)
      if [ "$CHANNEL" = "latest" ]; then
        tag="$(latest_stable_tag)"
      else
        tag="$(latest_prerelease_tag)"
      fi
      ;;
    latest-prerelease)
      tag="$(latest_prerelease_tag)"
      ;;
    latest-stable)
      tag="$(latest_stable_tag)"
      ;;
    v*) tag="$VERSION" ;;
    *) tag="v$VERSION" ;;
  esac

  if [ -z "$tag" ]; then
    echo "Could not resolve an OpenAgentHarness release tag." >&2
    return 1
  fi

  version="${tag#v}"
  archive="oah-v${version}-${asset}.tar.gz"
  url="${RELEASE_BASE_URL%/}/${tag}/${archive}"
  checksum_url="${url}.sha256"
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT INT HUP TERM

  echo "Installing OpenAgentHarness ${tag} from GitHub Release..."
  echo "Downloading ${archive}..."
  github_get "$url" -o "$tmp_dir/$archive"
  github_get "$checksum_url" -o "$tmp_dir/$archive.sha256"
  verify_checksum "$tmp_dir/$archive" "$tmp_dir/$archive.sha256"

  mkdir -p "$tmp_dir/package"
  tar -xzf "$tmp_dir/$archive" -C "$tmp_dir/package"

  if [ ! -f "$tmp_dir/package/bin/$bin_name" ]; then
    echo "Release archive does not contain bin/$bin_name." >&2
    return 1
  fi

  mkdir -p "$INSTALL_ROOT/versions"
  target="$INSTALL_ROOT/versions/$version"
  tmp_target="$INSTALL_ROOT/versions/.$version.$$"
  rm -rf "$tmp_target"
  cp -R "$tmp_dir/package" "$tmp_target"
  rm -rf "$target"
  mv "$tmp_target" "$target"

  tmp_current="$INSTALL_ROOT/current.$$"
  rm -f "$tmp_current"
  ln -s "versions/$version" "$tmp_current"
  mv -f "$tmp_current" "$INSTALL_ROOT/current"
  write_root_shim
}

install_release

echo
echo "OpenAgentHarness installed:"
"$INSTALL_ROOT/bin/oah" version

echo
echo "Next steps:"
echo "  export PATH=\"$INSTALL_ROOT/bin:\$PATH\""
echo "  oah daemon init"
echo "  oah daemon start"
echo "  cd /path/to/repo && oah tui"
echo
echo "Update later:"
echo "  oah update"
