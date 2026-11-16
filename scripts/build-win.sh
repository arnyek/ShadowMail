#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds the portable Windows package with the Windows Node (C:\Program Files\nodejs) through
# WSL interop, then copies the zip into this repo's dist/.
#
#   scripts/build-win.sh [git-ref]        (default: HEAD; uncommitted changes are NOT included)
#
# Windows build folder: $PM_WIN_BUILD_DIR, default <the Windows user's profile>\portable-mail-build
#   src\    git archive of the ref (recreated on every run)
#   cache\  npm, Electron and electron-builder download caches
set -euo pipefail

REF="${1:-HEAD}"
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
CMD=/mnt/c/Windows/System32/cmd.exe

[ -x "$CMD" ] || { echo "build-win: $CMD not found (is WSL interop enabled?)" >&2; exit 1; }
if [ -n "${PM_WIN_BUILD_DIR:-}" ]; then
  WIN_ROOT_WSL="$PM_WIN_BUILD_DIR"
else
  # the Windows user's profile folder (cmd.exe started from a Windows folder: it refuses a UNC working directory)
  WIN_PROFILE="$(cd /mnt/c && "$CMD" /d /c "echo %USERPROFILE%" | tr -d '\r')"
  WIN_ROOT_WSL="$(wslpath -u "$WIN_PROFILE")/portable-mail-build"
fi
COMMIT="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
VERSION="$(git -C "$REPO" show "$COMMIT:package.json" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).version)')"
ZIP="ShadowMail-$VERSION-win-x64.zip"

echo "build-win: $COMMIT ($REF), version $VERSION -> $WIN_ROOT_WSL"
mkdir -p "$WIN_ROOT_WSL"
rm -rf "$WIN_ROOT_WSL/src"
mkdir -p "$WIN_ROOT_WSL/src"
git -C "$REPO" archive --format=tar "$COMMIT" | tar -x -C "$WIN_ROOT_WSL/src"

WIN_ROOT="$(wslpath -w "$WIN_ROOT_WSL")"
# cmd.exe refuses a UNC (\\wsl$) working directory, so start it from the Windows folder.
(cd "$WIN_ROOT_WSL" && "$CMD" /d /c "src\\scripts\\win\\build.cmd" "$WIN_ROOT")

mkdir -p "$REPO/dist"
cp "$WIN_ROOT_WSL/src/dist/$ZIP" "$REPO/dist/$ZIP"
echo "build-win: $REPO/dist/$ZIP"
sha256sum "$REPO/dist/$ZIP"
