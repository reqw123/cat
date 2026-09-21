@echo off
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" "builder-gui\main.js"
