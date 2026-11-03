#!/bin/bash
# macOS system tools only: no preinstalled Node, Python, pip, npm or Homebrew.
set -euo pipefail
source "$(dirname "$0")/local-env.sh"
if [[ $# -ne 0 ]]; then echo 'Usage: ./scripts/local-setup.sh' >&2; exit 1; fi
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'Local runtime currently supports Apple Silicon macOS only (same as the formula).' >&2
  exit 1
fi
macos_major="$(sw_vers -productVersion | cut -d. -f1)"
if (( macos_major < 15 )); then echo 'macOS 15 or newer is required.' >&2; exit 1; fi
xcode_version="$(xcodebuild -version | awk '/^Xcode / {print $2}')"
if [[ -z "$xcode_version" ]] || (( ${xcode_version%%.*} < 26 )); then
  echo 'Select a full Xcode 26+ installation before setup.' >&2; exit 1
fi
mkdir -p "$ISIMBOT_RUNTIME/cache/downloads"
if ! mkdir "$ISIMBOT_RUNTIME/install.lock" 2>/dev/null; then
  echo 'Another local setup may be running. If an earlier setup was killed, remove .runtime/install.lock after checking it is no longer running.' >&2
  exit 1
fi
stage=""
cleanup() {
  [[ -z "$stage" ]] || rm -rf "$stage"
  rmdir "$ISIMBOT_RUNTIME/install.lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
stage="$(mktemp -d "$ISIMBOT_RUNTIME/.install.XXXXXX")"
rm -f "$ISIMBOT_RUNTIME/ready"
# Build tools and caches also stay within the checkout.
export TMPDIR="$stage/"
export PIP_CONFIG_FILE=/dev/null
export npm_config_cache="$ISIMBOT_RUNTIME/cache/npm"
export npm_config_userconfig="$ISIMBOT_RUNTIME/npm-user.conf"
export npm_config_globalconfig="$ISIMBOT_RUNTIME/npm-global.conf"
: > "$npm_config_userconfig"
: > "$npm_config_globalconfig"

# Single source for pinned runtime/dependency URLs and checksums. No Ruby needed.
# Resource provenance/license: homebrew/THIRD_PARTY_LICENSES/homebrew-fb.txt.
awk -F '"' '
  /^  resource "/ {name=$2}
  /^    url "/ {url=$2}
  /^    sha256 "/ {print name "|" url "|" $2}
' "$ISIMBOT_PROJECT_ROOT/homebrew/isimbot-mcp.rb.in" > "$stage/resources"

fetch() {
  local name="$1" row url sha filename actual
  row="$(awk -F '|' -v name="$name" '$1 == name {print}' "$stage/resources")"
  IFS='|' read -r name url sha <<< "$row"
  if [[ -z "$url" || ${#sha} -ne 64 || "$url" != https://* ]]; then
    echo "Missing or invalid pinned resource: $1" >&2; exit 1
  fi
  filename="${url##*/}"
  archive="$ISIMBOT_RUNTIME/cache/downloads/$filename"
  if [[ -f "$archive" ]]; then
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
    if [[ "$actual" != "$sha" ]]; then rm -f "$archive"; fi
  fi
  if [[ ! -f "$archive" ]]; then
    echo "Downloading $name..."
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 600 \
      --proto '=https' --proto-redir '=https' --output "$stage/$filename" "$url"
    actual="$(shasum -a 256 "$stage/$filename" | awk '{print $1}')"
    if [[ "$actual" != "$sha" ]]; then echo "SHA256 mismatch for $name; refusing installation." >&2; exit 1; fi
    mv "$stage/$filename" "$archive"
  fi
  resource_sha="$sha"
}

install_runtime() {
  local resource="$1" destination="$2" binary="$3" unpack root
  fetch "$resource"
  if [[ -x "$ISIMBOT_RUNTIME/$destination/$binary" && -f "$ISIMBOT_RUNTIME/$destination/.resource-sha" ]] && \
     [[ "$(cat "$ISIMBOT_RUNTIME/$destination/.resource-sha")" == "$resource_sha" ]]; then return; fi
  unpack="$stage/$destination"
  mkdir -p "$unpack"
  tar -xzf "$archive" -C "$unpack"
  root="$unpack"
  if [[ ! -f "$root/$binary" ]]; then
    # Node and standalone Python have one top-level directory; companion may not.
    local children=("$unpack"/*)
    if [[ ${#children[@]} -ne 1 || ! -d "${children[0]}" ]]; then echo "Unexpected $resource archive layout." >&2; exit 1; fi
    root="${children[0]}"
  fi
  if [[ ! -x "$root/$binary" ]]; then echo "Missing $binary in $resource." >&2; exit 1; fi
  printf '%s\n' "$resource_sha" > "$root/.resource-sha"
  rm -rf "$ISIMBOT_RUNTIME/$destination"
  mv "$root" "$ISIMBOT_RUNTIME/$destination"
}

install_runtime node-runtime node bin/node
install_runtime python-runtime python bin/python3
install_runtime idb-companion idb-companion idb_companion
if [[ ! -f "$ISIMBOT_RUNTIME/idb-companion/Resources/libShimulator-iOS.dylib" ]]; then
  echo 'Companion resource library is missing.' >&2; exit 1
fi

python="$ISIMBOT_RUNTIME/python/bin/python3"
while IFS='|' read -r name url sha; do
  case "$name" in node-runtime|python-runtime|idb-companion) continue ;; esac
  fetch "$name"
  "$python" -I -m pip --isolated install --no-deps --no-compile --no-input \
    --disable-pip-version-check --cache-dir "$ISIMBOT_RUNTIME/cache/pip" \
    --index-url https://pypi.org/simple "$archive"
done < "$stage/resources"
"$python" -I -m pip --isolated check

# A new installation must not attach to a companion left by a removed runtime.
if [[ ! -f "$ISIMBOT_RUNTIME/installation-id" ]]; then
  uuidgen > "$ISIMBOT_RUNTIME/installation-id"
fi
cp "$ISIMBOT_PROJECT_ROOT/scripts/local-idb.py" "$ISIMBOT_RUNTIME/local-idb.py"
mkdir -p "$ISIMBOT_RUNTIME/bin"
cat > "$ISIMBOT_RUNTIME/bin/idb" <<'SH'
#!/bin/bash
set -euo pipefail
runtime="$(cd "$(dirname "$0")/.." && pwd -P)"
exec "$runtime/python/bin/python3" -I "$runtime/local-idb.py" "$@"
SH
chmod +x "$ISIMBOT_RUNTIME/bin/idb"
cd "$ISIMBOT_PROJECT_ROOT"
node="$ISIMBOT_RUNTIME/node/bin/node"
npm="$ISIMBOT_RUNTIME/node/lib/node_modules/npm/bin/npm-cli.js"
"$node" "$npm" ci --include=dev --ignore-scripts --no-audit --no-fund
"$node" "$npm" run build
"$ISIMBOT_RUNTIME/bin/idb" --help > /dev/null
"$ISIMBOT_RUNTIME/idb-companion/idb_companion" --version
"$node" --input-type=module -e 'import sharp from "sharp"; const b=await sharp({create:{width:10,height:20,channels:3,background:"white"}}).png().toBuffer(); const m=await sharp(b).metadata(); if(m.width!==10||m.height!==20)process.exit(1);'
printf 'Ready\n' > "$ISIMBOT_RUNTIME/ready"
printf '\nLocal environment ready. No global runtimes were installed.\nNext: ./scripts/isimbot-local setup\nTest: ./scripts/local-npm test\nRebuild: ./scripts/local-npm run build\n'
