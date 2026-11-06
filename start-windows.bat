@echo off
chcp 65001 >nul
title Математикалық монополия — сервер
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js табылмады. https://nodejs.org сайтынан LTS нұсқасын орнатыңыз.
  pause
  exit /b 1
)
node server.js
pause
