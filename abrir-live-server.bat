@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PORT_API=8080
set PORT_LIVE=5500
set PY=python
where python >nul 2>&1
if errorlevel 1 set PY=py

echo ========================================
echo   Touya — Live Server + API (BlueFocus)
echo ========================================
echo.
echo A extensao «Live Server» sozinha NAO encaminha /api para o Python.
echo Este script abre:
echo   - API + arquivos em http://localhost:%PORT_API%/
echo   - Live Server em http://localhost:%PORT_LIVE%/ com proxy /api -^> %PORT_API%
echo.
echo Na rede (mesma Wi-Fi), use o seu IPv4:
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object {$_.InterfaceAlias -notlike '*Loopback*'} ^| Select-Object -First 1 -ExpandProperty IPAddress"') do set "LANIP=%%i"
if defined LANIP (
    echo   http://%LANIP%:%PORT_LIVE%/
) else (
    echo   http://SEU_IP:%PORT_LIVE%/
)
echo.
echo Deixe as duas janelas abertas. Feche o Live Server para parar a porta %PORT_LIVE%.
echo ========================================
echo.

start "Touya API (%PORT_API%)" /D "%~dp0" cmd /k "%PY% servidor.py"
timeout /t 2 /nobreak >nul

where node >nul 2>&1
if errorlevel 1 (
    echo ERRO: Node.js nao encontrado. Instale Node LTS ^(https://nodejs.org^) para usar o Live Server com proxy.
    echo Voce ainda pode usar so: abrir-calculadora.bat ^(http://localhost:%PORT_API%^)
    pause
    exit /b 1
)

echo Iniciando Live Server na porta %PORT_LIVE% ^(proxy /api -^> %PORT_API%^)...
npx --yes live-server@1.2.2 --port=%PORT_LIVE% --host=0.0.0.0 --proxy=/api:http://127.0.0.1:%PORT_API% --open=/index.html

pause
