@echo off
cd /d "%~dp0"
if not exist node_modules call npm install --omit=dev
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Command Center.lnk');" ^
  "$s.TargetPath='wscript.exe'; $s.Arguments='\"%~dp0start-hidden.vbs\"'; $s.WorkingDirectory='%~dp0'; $s.Save()"
wscript.exe "%~dp0start-hidden.vbs"
echo.
echo Command Center will now start silently every time you log in.
echo It is running now at http://localhost:4321
start "" http://localhost:4321
pause
