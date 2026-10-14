@echo off
REM Legacy launcher — install-win.ps1 dùng pulsedm_host.exe trực tiếp.
setlocal
set "DIR=%~dp0"

if exist "%DIR%pulsedm_host.exe" (
  "%DIR%pulsedm_host.exe" %*
  exit /b %ERRORLEVEL%
)

if exist "%DIR%bin\pulsedm_host.exe" (
  "%DIR%bin\pulsedm_host.exe" %*
  exit /b %ERRORLEVEL%
)

where py >nul 2>&1
if %ERRORLEVEL%==0 (
  py -3 "%DIR%pulsedm_host.py" %*
  exit /b %ERRORLEVEL%
)

where python >nul 2>&1
if %ERRORLEVEL%==0 (
  python "%DIR%pulsedm_host.py" %*
  exit /b %ERRORLEVEL%
)

echo PulseDM host: pulsedm_host.exe not found. Run install-win.ps1 1>&2
exit /b 1
