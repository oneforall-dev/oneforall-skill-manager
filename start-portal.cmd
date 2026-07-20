@echo off
title Antigravity Skill Portal Launcher
color 0B
cls

echo ========================================================
echo         ANTIGRAVITY SKILL PORTAL LAUNCHER
echo ========================================================
echo.
echo Checking system dependencies...

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js (version 18 or higher) to run this portal.
    echo Press any key to exit...
    pause >nul
    exit /b 1
)

:: Check Git
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARNING] Git is not installed or not in PATH.
    echo Git installations will fail. Please make sure Git is installed.
    echo.
)

echo [OK] Node.js found.
echo.
echo Starting local portal server on port 3000...
echo.
echo ========================================================
echo The portal webpage should open automatically in your browser.
echo Press Ctrl+C in this terminal window to stop the server.
echo ========================================================
echo.

node "%~dp0installer.js"

pause
