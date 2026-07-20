@echo off
title Oneforall Skill Manager Launcher
color 0C
cls

echo ========================================================
echo         ONEFORALL SKILL MANAGER - LAUNCHER
echo ========================================================
echo.
echo Checking system dependencies...
echo.

:: Check Node.js installation
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js v18 or higher from https://nodejs.org
    echo Press any key to exit...
    pause >nul
    exit /b 1
)

:: Check Git installation
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARNING] Git was not found in system PATH.
    echo Cloning skills from Git repositories may fail.
    echo Install Git from https://git-scm.com for full functionality.
    echo.
) else (
    echo [OK] Git found.
)

echo [OK] Node.js found.
echo.
echo Starting Oneforall Skill Manager server on port 3000...
echo.
echo ========================================================
echo The web dashboard will open automatically in your browser.
echo Press Ctrl+C in this terminal window to stop the server.
echo ========================================================
echo.

node "%~dp0installer.js"

pause
