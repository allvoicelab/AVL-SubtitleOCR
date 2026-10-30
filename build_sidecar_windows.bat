@echo off
setlocal

rem Everything below is relative to the repository root (requirements.txt,
rem avl-open\, SubtitleSidecar.spec): jump there so the script also works when
rem it is called from a process whose working directory is somewhere else
rem (frontend\build_app_windows.bat used to fail here with "Could not open
rem requirements file").
cd /d "%~dp0"

rem Builds dist\SubtitleSidecar\SubtitleSidecar.exe, the OCR backend that the
rem Electron front end spawns (see SIDECAR_API.md).
rem All messages are ASCII on purpose: a non-UTF-8 console code page would
rem otherwise garble them.

rem --no-pause        : used when this script is called from frontend\build_app_windows.bat,
rem                     so the automation is not blocked on a keypress.
rem --allow-no-preview: build a package without PyAV / Pillow on purpose. mkv/avi preview
rem                     and still-frame decoding will be OFF for the user (silent downgrade).
set "NO_PAUSE="
set "ALLOW_NO_PREVIEW="
for %%A in (%*) do (
    if /i "%%~A"=="--no-pause" set "NO_PAUSE=1"
    if /i "%%~A"=="--allow-no-preview" set "ALLOW_NO_PREVIEW=1"
)

set "PYTHON_CMD="
where python >nul 2>nul
if not errorlevel 1 set "PYTHON_CMD=python"
if not defined PYTHON_CMD (
    where python3 >nul 2>nul
    if not errorlevel 1 set "PYTHON_CMD=python3"
)
if not defined PYTHON_CMD (
    echo [ERROR] Could not find Python in PATH.
    echo Install Python 3.10 or newer and enable "Add Python to PATH".
    exit /b 1
)

echo Using Python command: %PYTHON_CMD%
echo [1/4] Creating virtual environment...
if not exist .venv\Scripts\python.exe %PYTHON_CMD% -m venv .venv
if errorlevel 1 goto :error

echo [2/4] Installing runtime and packaging dependencies...
rem requirements.txt 里的版本全部写死（==），并且包含 av（mkv/avi 预览重封装）
rem 与 pillow（定格帧）——以前这两个由本脚本单独安装、装不上只告警继续，于是
rem 不同机器打出来的包预览能力可能不一样。现在只有一份清单，缺依赖即失败。
.venv\Scripts\python.exe -m pip install --upgrade pip
if errorlevel 1 goto :error
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto :error
.venv\Scripts\python.exe -m pip install -e avl-open
if errorlevel 1 goto :error

rem 缺 PyAV / Pillow 时 OCR 主链路照常，但打出来的 exe 没有 mkv/avi 预览与
rem 定格帧解码（system.hello.previewTranscodeAvailable=false），属于隐性降级，
rem 所以默认按错误处理；确实要打这种包就加 --allow-no-preview。
.venv\Scripts\python.exe -c "import av, PIL.Image" 2>nul
if errorlevel 1 (
    if defined ALLOW_NO_PREVIEW (
        echo [WARN] PyAV / Pillow is missing - mkv/avi preview will be OFF in this build.
    ) else (
        echo [ERROR] PyAV / Pillow is missing: the package would ship without mkv/avi
        echo         preview and without still-frame decoding.
        echo         Fix: .venv\Scripts\python.exe -m pip install -r requirements.txt
        echo         Or pass --allow-no-preview to build such a package on purpose.
        if not defined NO_PAUSE pause
        exit /b 1
    )
)

echo [3/4] Building SubtitleSidecar.exe...
tasklist /FI "IMAGENAME eq SubtitleSidecar.exe" 2>nul | find /I "SubtitleSidecar.exe" >nul
if not errorlevel 1 (
    echo [ERROR] SubtitleSidecar.exe is still running.
    echo Close all running copies before rebuilding so Windows can replace DLL files.
    if not defined NO_PAUSE pause
    exit /b 1
)
.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean SubtitleSidecar.spec
if errorlevel 1 goto :error

echo [4/4] Verifying that the OCR runtime is inside the bundle...
dir /b "dist\SubtitleSidecar\_internal\avl_open_ocr\model_files\*.onnx" >nul 2>nul
if errorlevel 1 (
    echo [ERROR] The bundle does not contain the OCR model files.
    echo         Such an exe falls back to a local avl-open folder and then
    echo         fails on any machine that does not have this source tree.
    echo         Check how SubtitleSidecar.spec collects model_files.
    if not defined NO_PAUSE pause
    exit /b 1
)

rem 第三方许可文本必须随包：本地 licenses\ 不存在时由 SubtitleSidecar.spec 从已安装的 wheel 自动生成。
dir /b "dist\SubtitleSidecar\_internal\licenses\README.md" >nul 2>nul
if errorlevel 1 (
    echo [ERROR] The bundle does not contain the third-party license texts.
    echo         Check licenses\ or tools\collect_licenses.py.
    if not defined NO_PAUSE pause
    exit /b 1
)

echo Smoke test: the sidecar must answer system.ping on stdout...
set "PING=%TEMP%\sidecar_ping.json"
set "PONG=%TEMP%\sidecar_pong.json"
> "%PING%" echo {"id":1,"method":"system.ping"}
>> "%PING%" echo {"id":2,"method":"system.capabilities"}
type "%PING%" | "dist\SubtitleSidecar\SubtitleSidecar.exe" > "%PONG%" 2>nul
findstr /C:"system.hello" /C:"\"pong\":true" "%PONG%" >nul
if errorlevel 1 (
    echo [ERROR] The sidecar did not answer the protocol handshake.
    echo         See SubtitleSidecar.spec and the output above.
    if not defined NO_PAUSE pause
    exit /b 1
)

rem A bundle without the ONNX models still starts; every recognition then fails
rem on the customer's machine. hello.modelsBundled is the honest signal, and
rem the capability table proves the fixed v6_small recognizer really registered.
findstr /C:"\"modelsBundled\":true" "%PONG%" >nul
if errorlevel 1 (
    echo [ERROR] modelsBundled=false: the OCR models are missing from the bundle.
    echo         Check how SubtitleSidecar.spec collects avl_open_ocr/model_files.
    if not defined NO_PAUSE pause
    exit /b 1
)
findstr /C:"\"recognizer\":\"v6_small\"" "%PONG%" >nul
if errorlevel 1 (
    echo [ERROR] system.capabilities does not offer the v6_small recognizer.
    echo         See avl_open_ocr/backends.py and sidecar/models.py.
    if not defined NO_PAUSE pause
    exit /b 1
)

echo.
echo Build complete: dist\SubtitleSidecar\SubtitleSidecar.exe
echo Copy the whole dist\SubtitleSidecar folder next to the Electron app's
echo resources folder (extraResources) - it is self-contained.
if not defined NO_PAUSE pause
exit /b 0

:error
echo.
echo [ERROR] Build failed. See the message above.
if not defined NO_PAUSE pause
exit /b 1
