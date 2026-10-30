@echo off
rem ============================================================================
rem  One-click build of the desktop app: OCR backend + Electron installer.
rem  Kept at the repo root so it is easy to find; the real work happens in
rem  frontend\build_app_windows.bat.
rem
rem  Build machine needs: Python 3.10+, Node.js 18+, internet for the first run.
rem ============================================================================
call "%~dp0frontend\build_app_windows.bat" %*
