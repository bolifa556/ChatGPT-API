#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(uname -s)" != Darwin ]; then
  echo 'This package requires macOS.' >&2
  exit 1
fi
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64)
    if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
      ARCH=arm64
    else
      echo 'This desktop provider package requires an Apple Silicon Mac.' >&2
      exit 1
    fi
    ;;
  *) echo 'Unsupported processor architecture.' >&2; exit 1 ;;
esac
if [ "$(cat "$ROOT/architecture")" != "$ARCH" ]; then
  echo "Download the macOS $ARCH package for this computer." >&2
  exit 1
fi
if [ "$(id -u)" = 0 ]; then
  echo 'Install as your desktop user, without sudo.' >&2
  exit 1
fi
DESTINATION="$HOME/Library/Application Support/chatgpt-apionly"
if [ "$#" -gt 0 ] && [ "$1" != "--skip-api" ]; then DESTINATION="$1"; shift; fi
exec "$ROOT/payload/runtime/node" "$ROOT/setup/install.mjs" "$ROOT" "$DESTINATION" "$@"
