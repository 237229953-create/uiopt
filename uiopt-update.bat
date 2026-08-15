@echo off
setlocal EnableExtensions
title uiopt hot-update

REM ============================================================
REM  uiopt hot-update: fetch latest code from GitHub and replace
REM  the local plugin copy.
REM  Usage:
REM    double-click, or
REM    uiopt-update.bat <full-path-to-plugin-dir>
REM ============================================================

set "TARGET=%~1"

REM 1) explicit argument must point at a plugin dir
if defined TARGET if not exist "%TARGET%\lib\index.js" (
    echo [WARN] "%TARGET%" has no lib\index.js - ignoring it.
    set "TARGET="
)

REM 2) this script's own dir
if not defined TARGET if exist "%~dp0lib\index.js" set "TARGET=%~dp0"

REM 3) common default dir on this machine
if not defined TARGET if exist "D:\dsh-plugins\uiopt\lib\index.js" set "TARGET=D:\dsh-plugins\uiopt"

REM 4) profile install location
if not defined TARGET if exist "%USERPROFILE%\.dsh\profiles\web\node_modules\uiopt\lib\index.js" set "TARGET=%USERPROFILE%\.dsh\profiles\web\node_modules\uiopt"

REM 5) ask the user
if not defined TARGET (
    echo.
    echo uiopt plugin dir not found automatically.
    echo Enter the full path of your uiopt plugin folder, for example:
    echo   D:\dsh-plugins\uiopt
    echo   %USERPROFILE%\.dsh\profiles\web\node_modules\uiopt
    echo   ... or a NEW empty folder to install uiopt there
    echo.
    set /p "TARGET=Full path: "
)
if not defined TARGET (
    echo [ERROR] No path given - aborted.
    pause
    exit /b 1
)

REM ============ download + extract ============
set "TMPDIR=%TEMP%\uiopt-update-%RANDOM%"
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%" 2>nul
mkdir "%TMPDIR%" 2>nul
cd /d "%TMPDIR%"

echo [1/4] Downloading latest code from GitHub ...
curl -L --fail --silent --show-error -o master.tar.gz "https://codeload.github.com/237229953-create/uiopt/tar.gz/refs/heads/master"
if errorlevel 1 (
    echo [ERROR] Download failed. Check your network and retry.
    rmdir /s /q "%TMPDIR%" 2>nul
    pause
    exit /b 1
)

echo [2/4] Extracting ...
tar -xzf master.tar.gz
if errorlevel 1 (
    echo [ERROR] Extract failed.
    rmdir /s /q "%TMPDIR%" 2>nul
    pause
    exit /b 1
)
if not exist "%TMPDIR%\uiopt-master\lib\index.js" (
    echo [ERROR] Package missing lib\index.js - aborted.
    rmdir /s /q "%TMPDIR%" 2>nul
    pause
    exit /b 1
)
if not exist "%TMPDIR%\uiopt-master\lib\client.js" (
    echo [ERROR] Package missing lib\client.js - aborted.
    rmdir /s /q "%TMPDIR%" 2>nul
    pause
    exit /b 1
)

REM ============ backup + replace (or fresh install) ============
echo [3/4] Applying update to %TARGET%
if exist "%TARGET%\lib" goto REPLACE
goto INSTALL

:REPLACE
set "BACKUP=%TARGET%\.update-backup-bat-%RANDOM%"
mkdir "%BACKUP%" 2>nul
xcopy /e /i /q /y "%TARGET%\lib" "%BACKUP%\lib" >nul
copy /y "%TARGET%\package.json" "%BACKUP%\package.json" >nul
rmdir /s /q "%TARGET%\lib" 2>nul
xcopy /e /i /q /y "%TMPDIR%\uiopt-master\lib" "%TARGET%\lib" >nul
copy /y "%TMPDIR%\uiopt-master\package.json" "%TARGET%\package.json" >nul
if exist "%TMPDIR%\uiopt-master\cordis.patch.yml" copy /y "%TMPDIR%\uiopt-master\cordis.patch.yml" "%TARGET%\cordis.patch.yml" >nul
echo      Old code backed up to %BACKUP%
goto DONE

:INSTALL
if not exist "%TARGET%" mkdir "%TARGET%"
xcopy /e /i /q /y "%TMPDIR%\uiopt-master\lib" "%TARGET%\lib" >nul
copy /y "%TMPDIR%\uiopt-master\package.json" "%TARGET%\package.json" >nul
if exist "%TMPDIR%\uiopt-master\cordis.patch.yml" copy /y "%TMPDIR%\uiopt-master\cordis.patch.yml" "%TARGET%\cordis.patch.yml" >nul
echo      Fresh install into %TARGET%
echo      If not registered yet, run:  dsh plugin --profile web add "%TARGET%"

:DONE
echo [4/4] Cleaning up ...
rmdir /s /q "%TMPDIR%" 2>nul

echo.
echo ============================================
echo  Update done!
echo  Restart dsh for host code and refresh the
echo  page for client code to take effect.
echo ============================================
pause
