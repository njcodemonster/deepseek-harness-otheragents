@echo off
title DeepSeek Harness
cd /d "%~dp0"
echo ===================================================
echo           Starting DeepSeek Harness...
echo ===================================================
echo.
pnpm dsh web
if %errorlevel% neq 0 (
    echo.
    echo [Error] Failed to start DeepSeek Harness.
    pause
)
