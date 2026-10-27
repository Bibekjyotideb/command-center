@echo off
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Command Center.lnk" 2>nul
echo Removed from startup. (If it's running now, it stops at next restart, or end "node" in Task Manager.)
pause
