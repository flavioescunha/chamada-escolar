@echo off
cd /d "%~dp0"

echo ==========================================
echo Atualizando repositorio Git...
echo Pasta atual:
cd
echo ==========================================
echo.

git status
echo.

set /p MSG=Digite a mensagem do commit: 
if "%MSG%"=="" set MSG=Atualizacao

git add .
git commit -m "%MSG%"

echo.
echo Enviando para o GitHub...
git push origin main

echo.
echo ==========================================
echo Finalizado.
echo ==========================================
pause