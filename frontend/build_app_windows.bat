@echo off
setlocal
rem ============================================================================
rem  One-click build for the AVL-SubtitleOCR desktop app (Windows).
rem
rem  Steps:
rem    1. build the OCR backend (dist\SubtitleSidecar\SubtitleSidecar.exe)
rem    2. npm install (only the first time)
rem    3. npm run dist, which writes into release\:
rem         AVL-SubtitleOCR-Setup-<version>.exe     (installer)
rem         AVL-SubtitleOCR-Portable-<version>.exe  (portable)
rem         where <version> comes from the version field in package.json
rem
rem  The backend is copied into the installer's resources\sidecar folder, so the
rem  result runs on a clean Windows machine with no Python, node or model files.
rem
rem  Requirements on the BUILD machine: Python 3.10+, Node.js 18+, internet
rem  access for the first dependency install.
rem ============================================================================

rem --no-pause: for callers that do not want the window to wait for a keypress.
set "NO_PAUSE="
if /i "%~1"=="--no-pause" set "NO_PAUSE=1"

cd /d "%~dp0"

echo [1/3] OCR backend
if exist "..\dist\SubtitleSidecar\SubtitleSidecar.exe" (
    echo       Found ..\dist\SubtitleSidecar\SubtitleSidecar.exe - skipping.
    echo       Delete that folder if you changed the Python code and want a rebuild.
) else (
    echo       Not built yet, running build_sidecar_windows.bat ...
    rem The backend script builds from the repository root (requirements.txt,
    rem avl-open\, SubtitleSidecar.spec live there), so run it there and come
    rem back: "call" would otherwise keep this script in frontend\.
    pushd "%~dp0.."
    call build_sidecar_windows.bat --no-pause
    if errorlevel 1 (
        popd
        goto :error
    )
    popd
)
if not exist "..\dist\SubtitleSidecar\SubtitleSidecar.exe" (
    echo [ERROR] The backend build did not produce dist\SubtitleSidecar\SubtitleSidecar.exe
    goto :error
)

echo [2/3] npm dependencies
where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found in PATH. Install Node.js 18 or newer first.
    goto :error
)
if exist "node_modules\electron-builder" (
    echo       node_modules already present - skipping npm install.
) else (
    call npm.cmd install
    if errorlevel 1 goto :error
)

echo [3/3] Packaging the Electron app ^(the first run downloads Electron^)
call npm.cmd run dist
if errorlevel 1 goto :error

echo.
echo Build finished. Output folder: %~dp0release
dir /b "%~dp0release\*.exe" 2>nul
echo.
echo Give testers the portable exe (AVL-SubtitleOCR-Portable-*.exe) if they cannot install
echo software, otherwise the Setup .exe. Both are self-contained.
if not defined NO_PAUSE pause
exit /b 0

:error
echo.
echo [ERROR] Build failed. See the message above.
if not defined NO_PAUSE pause
exit /b 1
