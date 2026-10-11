#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(uname -s)" != Linux ]; then
  echo 'This package requires Linux.' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo 'Unsupported processor architecture.' >&2; exit 1 ;;
esac
if [ "$(cat "$ROOT/architecture")" != "$ARCH" ]; then
  echo "Download the Linux $ARCH package for this computer." >&2
  exit 1
fi
if [ "$(id -u)" = 0 ]; then
  echo 'Install as your desktop user, without sudo.' >&2
  exit 1
fi
exec "$ROOT/payload/runtime/node" "$ROOT/setup/install.mjs" "$ROOT" "${1:-${XDG_DATA_HOME:-$HOME/.local/share}/chatgpt-api-provider}"
