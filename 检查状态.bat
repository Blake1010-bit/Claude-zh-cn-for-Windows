@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Claude 汉化 - 检查状态
set "VER=1.1.2"
set "NODE_EXE="
set "CODE="
set "RES_HINT="

rem Read-only. Never asks for administrator rights: this is exactly what a user
rem runs when unsure whether anything needs fixing.
for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%P"
if defined NODE_EXE goto :have_node
if exist "D:\Node.js\node.exe" set "NODE_EXE=D:\Node.js\node.exe"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if exist "%LOCALAPPDATA%\nvs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\nvs\node.exe"
if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"
if exist "%USERPROFILE%\scoop\apps\nodejs\current\node.exe" set "NODE_EXE=%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Volta\bin\node.exe"
if exist "%USERPROFILE%\.volta\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.volta\bin\node.exe"
if exist "%ProgramFiles%\Microsoft\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\Microsoft\nodejs\node.exe"

:have_node
if not defined NODE_EXE goto :no_node
set "CLAUDE_ZH_CN_NODE=%NODE_EXE%"

if exist "%TEMP%\claude-zh-cn-resources.txt" set /p RES_HINT=<"%TEMP%\claude-zh-cn-resources.txt"
if defined RES_HINT set "CLAUDE_RESOURCES_HINT=!RES_HINT!"

cls
call :banner
call :env
echo.
echo   诊断
echo ────────────────────────────────────────────────────────
"!NODE_EXE!" "%~dp0scripts\detect.mjs" %*
set "CODE=%ERRORLEVEL%"
echo ────────────────────────────────────────────────────────
if not "%CODE%"=="0" goto :failed

echo.
echo   语言文件复验
echo ────────────────────────────────────────────────────────
"!NODE_EXE!" "%~dp0scripts\verify.mjs"
set "CODE=%ERRORLEVEL%"
echo ────────────────────────────────────────────────────────
if not "%CODE%"=="0" goto :verify_failed
goto :done

:done
echo.
echo   ✔ 检查完成，没有改动任何文件
echo.
echo   还是英文？先确认是不是刚被 Claude 自动更新覆盖过，
echo   重新双击「一键安装中文.bat」即可。
echo.
pause
exit /b 0

:verify_failed
echo.
echo   ✘ 语言文件复验没通过
echo.
echo   建议直接重装一次：
echo     双击「一键安装中文.bat」
echo   仍然不行的话，先用「一键还原.bat」退回英文，再装一遍。
echo.
pause
exit /b 1

:failed
echo.
echo   ✘ 诊断失败        退出码 %CODE%
echo.
echo   常见原因
echo     1. 没找到 Claude Desktop —— 先启动一次 Claude 再检查
echo     2. Claude 正在更新 —— 等它更新完再检查
echo     3. 以上都不是 —— 把上面的内容贴到 Issues
echo        https://github.com/Blake1010-bit/Claude-zh-cn-for-Windows/issues
echo.
pause
exit /b %CODE%

:banner
echo.
echo ────────────────────────────────────────────────────────
echo   Claude Desktop 简体中文汉化 - 检查状态        v%VER%
echo   只读检查，不会改动任何文件
echo ────────────────────────────────────────────────────────
goto :eof

:env
echo.
echo   运行环境
echo     Node.js      !NODE_EXE!
if defined RES_HINT goto :env_res_hint
echo     Claude 资源  自动探测
goto :eof
:env_res_hint
echo     Claude 资源  !RES_HINT!
goto :eof

:no_node
cls
call :banner
echo.
echo   ✘ 没有找到 Node.js
echo.
echo   这个工具需要 Node.js 才能运行。
echo   到 https://nodejs.org/ 下载 LTS 版本，一路「下一步」装完即可。
echo   装好之后重新双击本文件。
echo.
pause
exit /b 1
