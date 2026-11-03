#!/bin/bash
# Shared by project-local commands. Sourcing this does not edit shell profiles.
ISIMBOT_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ISIMBOT_RUNTIME="$ISIMBOT_PROJECT_ROOT/.runtime"
export PATH="$ISIMBOT_RUNTIME/node/bin:$ISIMBOT_RUNTIME/bin:$ISIMBOT_RUNTIME/idb-companion:/usr/bin:/bin:/usr/sbin:/sbin"
export ISIMBOT_CONFIG_DIR="$ISIMBOT_RUNTIME/state"
export ISIMBOT_LAUNCHER="$ISIMBOT_PROJECT_ROOT/scripts/isimbot-local"
export ISIMBOT_SERVER_NAME=isimbot-local
unset NODE_PATH NODE_OPTIONS PYTHONHOME PYTHONPATH

require_local_runtime() {
  if [[ -d "$ISIMBOT_RUNTIME/install.lock" ]]; then
    echo 'Local setup is running. Wait for it to finish.' >&2
    exit 1
  fi
  if [[ ! -f "$ISIMBOT_RUNTIME/ready" || ! -x "$ISIMBOT_RUNTIME/node/bin/node" ]]; then
    echo 'Local runtime is not ready. Run ./scripts/local-setup.sh first.' >&2
    exit 1
  fi
}
