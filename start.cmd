@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
    py -3 -c "import sys; sys.exit(sys.version_info < (3,10))" >nul 2>nul
    if not errorlevel 1 (
        py -3 -B dashboard.py %*
        goto :finish
    )
)
python -c "import sys; sys.exit(sys.version_info < (3,10))" >nul 2>nul
if not errorlevel 1 (
    python -B dashboard.py %*
    goto :finish
)
if exist "%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime.v26-1119-907-0_26.1119.907.0_x64__3k8sg7r9htsxt\dependencies\python\python.exe" (
    "%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime.v26-1119-907-0_26.1119.907.0_x64__3k8sg7r9htsxt\dependencies\python\python.exe" -B dashboard.py %*
    goto :finish
)
for /d %%R in ("%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime*") do (
    if exist "%%R\dependencies\python\python.exe" (
        "%%R\dependencies\python\python.exe" -B dashboard.py %*
        goto :finish
    )
)
echo Python 3.10 oder neuer wurde nicht gefunden.
echo Bitte Python von python.org installieren und dieses Fenster danach erneut starten.
pause
exit /b 1
:finish
if errorlevel 1 (
    echo.
    echo Das Dashboard konnte nicht gestartet werden. Hinweise stehen in ANLEITUNG.txt.
    pause
)
