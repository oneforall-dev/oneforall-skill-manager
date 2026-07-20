@echo off
title Oneforall Skill Manager - Instalador e Iniciador
color 0A
cls

echo =======================================================================
echo          ONEFORALL SKILL MANAGER - INSTALADOR E INICIADOR AUTOMATICO
echo =======================================================================
echo.
echo [1/3] Verificando requisitos del sistema...
echo.

:: 1. Verificar Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js no esta instalado o no se encuentra en el PATH.
    echo Por favor descarga e instala Node.js (v18+) desde: https://nodejs.org
    echo.
    echo Presiona cualquier tecla para salir...
    pause >nul
    exit /b 1
) else (
    echo [OK] Node.js detectado correctamente.
)

:: 2. Verificar Git
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ADVERTENCIA] Git no se encuentra en el PATH.
    echo Para clonar skills directamente de repositorios, instala Git desde: https://git-scm.com
    echo.
) else (
    echo [OK] Git detectado correctamente.
)

echo.
echo [2/3] Verificando dependencias del proyecto...
if exist "%~dp0package.json" (
    echo Instalando dependencias necesarias via npm...
    call npm install --silent >nul 2>&1
    echo [OK] Dependencias al dia.
)

echo.
echo [3/3] Iniciando servidor Oneforall Skill Manager...
echo.
echo =======================================================================
echo  El panel web se abrira automaticamente en tu navegador predeterminado.
echo  Servidor activo en: http://localhost:3000
echo  Para detener el servidor, presiona Ctrl+C en esta ventana.
echo =======================================================================
echo.

:: Ejecutar el servidor backend
node "%~dp0installer.js"

pause
