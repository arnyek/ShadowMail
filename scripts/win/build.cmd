@echo off
rem SPDX-License-Identifier: GPL-3.0-or-later
rem Windows side of scripts/build-win.sh. Usage: build.cmd <build-root>
rem Runs in <build-root>\src (a git archive of the repo). All caches stay under <build-root>\cache,
rem so the build itself does not write into %APPDATA% or %LOCALAPPDATA%.
setlocal
if "%~1"=="" (
  echo usage: build.cmd ^<build-root^>
  exit /b 2
)
set "ROOT=%~1"
set "PATH=C:\Program Files\nodejs;%PATH%"
set "npm_config_cache=%ROOT%\cache\npm"
set "npm_config_update_notifier=false"
set "npm_config_fund=false"
set "npm_config_audit=false"
set "ELECTRON_CACHE=%ROOT%\cache\electron"
set "electron_config_cache=%ROOT%\cache\electron"
set "ELECTRON_BUILDER_CACHE=%ROOT%\cache\electron-builder"
set "CSC_IDENTITY_AUTO_DISCOVERY=false"
rem Temp files of the build (tests, Electron download staging, Node compile cache) stay here too.
if exist "%ROOT%\tmp" rd /s /q "%ROOT%\tmp"
mkdir "%ROOT%\tmp" || exit /b 3
set "TEMP=%ROOT%\tmp"
set "TMP=%ROOT%\tmp"
set "NODE_COMPILE_CACHE=%ROOT%\cache\node-compile-cache"

cd /d "%ROOT%\src" || exit /b 3
echo [build.cmd] node:
node -v || exit /b 4
call npm ci || exit /b 5
call npm test || exit /b 6
rem electron-builder ignores ELECTRON_CACHE for the Electron zip and would use
rem %LOCALAPPDATA%\electron\Cache (measured), so the cache folder is passed explicitly.
call npm run build:renderer || exit /b 7
call npx --no-install electron-builder --win zip --x64 "-c.electronDownload.cache=%ROOT%\cache\electron" || exit /b 8
echo [build.cmd] done
exit /b 0
