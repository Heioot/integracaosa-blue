@echo off
chcp 65001 >nul
cd /d "%~dp0."

set PORT=8080
set PY=python
where python >nul 2>&1
if errorlevel 1 set PY=py

echo ========================================
echo   Touya - Calculadora TikTok
echo ========================================
echo.
echo RECOMENDADO: use ESTE arquivo para tudo — calculadora, movimentacao,
echo   transferencia de arquivos na rede. Um servidor Python na porta 8080.
echo.
echo [ Voce neste PC ]
echo    http://localhost:%PORT%/
echo.
echo [ Mande para o pessoal na MESMA Wi-Fi ]
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object {$_.InterfaceAlias -notlike '*Loopback*'} ^| Select-Object -First 1 -ExpandProperty IPAddress"') do set "LANIP=%%i"
if defined LANIP (
    echo    http://%LANIP%:%PORT%/
) else (
    echo    Abra o ipconfig e use: http://SEU_IPv4:%PORT%/
)
echo.
echo Deixe esta janela aberta. Feche para parar o servidor.
echo.
echo Dica opcional ^(Live Server / front-end^): LEIA-ME-BAT.txt
echo ========================================
echo.

start "" "http://localhost:%PORT%/"

"%PY%" "%~dp0servidor.py"
if errorlevel 1 (
    echo.
    echo Erro ao iniciar servidor.py. Instale Python 3 e tente de novo.
    pause
)
