@echo off
REM Servidor local con soporte para /api sin login de Vercel

cd /d "%~dp0"

npm run dev

REM Abre http://localhost:3000
