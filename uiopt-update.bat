@echo off
setlocal EnableExtensions
title uiopt hot-update

REM ============================================================
REM  uiopt hot-update: fetch latest code from GitHub and replace
REM  the local plugin copy.
REM  Usage: double-click to run, or put it inside the plugin dir.
REM ============================================================

REM Locate the plugin dir: this script's own dir first, else D:\dsh-plugins\uiopt
set "TARGET=%~dp0"
if not exist "%TARGET%lib\index.js" set "TARGET=D:\dsh-plugins\uiopt\"
if not exist "%TARGET%lib\index.js" (
    echo [ERROR] uiopt plugin dir not found.
    echo         Put this script inside D:\dsh-plugins\uiopt and run again.
    pause
    exit /b 1
)

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

echo [3/4] Backing up old code and replacing ...
set "BACKUP=%TARGET%.update-backup-bat-%RANDOM%"
mkdir "%BACKUP%" 2>nul
xcopy /e /i /q /y "%TARGET%lib" "%BACKUP%\lib" >nul
copy /y "%TARGET%package.json" "%BACKUP%\package.json" >nul
rmdir /s /q "%TARGET%lib" 2>nul
xcopy /e /i /q /y "%TMPDIR%\uiopt-master\lib" "%TARGET%lib" >nul
copy /y "%TMPDIR%\uiopt-master\package.json" "%TARGET%package.json" >nul
if exist "%TMPDIR%\uiopt-master\cordis.patch.yml" copy /y "%TMPDIR%\uiopt-master\cordis.patch.yml" "%TARGET%cordis.patch.yml" >nul

echo [4/4] Cleaning up ...
rmdir /s /q "%TMPDIR%" 2>nul

echo.
echo ============================================
echo  Update done! Old code backed up to:
echo  %BACKUP%
echo  Restart dsh for host code and refresh the
echo  page for client code to take effect.
echo ============================================
pause
