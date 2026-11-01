@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Claude 汉化 - 还原
set "VER=1.1.2"
set "NODE_EXE="
set "CODE="
set "RES_HINT="

rem Locate node: PATH first, then the usual install locations.
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

if "%~1"=="admin" goto :admin

cls
call :banner
call :env

if defined CLAUDE_ZH_CN_YES goto :confirm_done
echo.
echo   将要做的
echo     · 删除本工具放入的中文语言文件
echo     · 如果找到备份，就把安装前的原文件放回去
echo     · 把 Claude 的界面语言设置改回 en-US
echo.
echo   还原后界面会回到英文，随时可以再装回来。
echo.
choice /c YN /n /m "   确定还原吗？[Y/n] " 2>nul
if errorlevel 2 goto :bye

:confirm_done
echo.
echo   正在请求管理员权限…
echo   弹出的 UAC 窗口请点「是」。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item '%TEMP%\claude-zh-cn-done.txt' -Force -ErrorAction SilentlyContinue; & '%~dp0scripts\elevate-run.ps1' -Script '%~dp0scripts\elevate.ps1' -ScriptArgs '-Mode','restore','-NoPause'"
call :wait_done
if not exist "%TEMP%\claude-zh-cn-done.txt" goto :still_open
set /p CODE=<"%TEMP%\claude-zh-cn-done.txt"
if "!CODE!"=="0" goto :done
goto :failed

:wait_done
for /l %%I in (1,1,300) do (
    if exist "%TEMP%\claude-zh-cn-done.txt" exit /b 0
    ping -n 2 127.0.0.1 >nul
)
exit /b 0

rem Reached only when this .bat itself was started elevated by hand.
:admin
cls
call :banner
call :env
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\elevate.ps1" -Mode restore -NoPause
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" goto :failed
goto :done

:done
cls
call :banner
echo.
echo   ✔ 还原完成
echo.
echo   界面要变回英文，同样需要完全退出 Claude 再打开。
echo.
if defined CLAUDE_ZH_CN_YES goto :done_manual
choice /c YN /n /m "   现在帮你自动重启 Claude 吗？[Y/n] " 2>nul
if errorlevel 2 goto :done_manual
echo.
"!NODE_EXE!" "%~dp0scripts\restart-claude.mjs" --verbose
if errorlevel 1 goto :done_manual
echo.
echo   ✔ Claude 已重新打开。
goto :done_end
:done_manual
echo.
echo   手动重启方法
echo     右下角托盘图标（时钟旁边）→ 右键 → 退出 → 再打开
:done_end
echo.
echo   想再装回中文：双击「一键安装中文.bat」
echo.
pause
exit /b 0

:failed
if not defined CODE set "CODE=1"
cls
call :banner
echo.
echo   ✘ 还原失败        退出码 !CODE!
echo.
call :tail_log
echo.
echo   常见原因
echo     1. 权限不足 —— 右键本文件，选「以管理员身份运行」
echo     2. 没找到 Claude —— 先手动启动一次 Claude 再试
echo     3. 杀毒软件或「受控文件夹访问」拦住了 takeown、icacls
echo     4. 以上都不是 —— 把上面的内容贴到 Issues
echo        https://github.com/Blake1010-bit/Claude-zh-cn-for-Windows/issues
echo.
echo   完整日志：%TEMP%\claude-zh-cn-restore.log
echo.
if defined CLAUDE_ZH_CN_YES goto :failed_end
choice /c YN /n /m "   用记事本打开日志吗？[Y/n] " 2>nul
if errorlevel 2 goto :failed_end
if exist "%TEMP%\claude-zh-cn-restore.log" start "" notepad "%TEMP%\claude-zh-cn-restore.log"
:failed_end
echo.
pause
exit /b !CODE!

:still_open
cls
call :banner
echo.
echo   · 管理员窗口还在运行
echo.
echo   请切到那个窗口看进度和最终结果。
echo.
pause
exit /b 0

:bye
echo.
echo   已取消，什么都没改动。
echo.
pause
exit /b 0

:banner
echo.
echo ────────────────────────────────────────────────────────
echo   Claude Desktop 简体中文汉化 - 还原        v%VER%
echo   把界面退回英文，并在可能时恢复安装前的原文件
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

:tail_log
if not exist "%TEMP%\claude-zh-cn-restore.log" goto :tail_none
echo   日志最后 30 行
echo.
for /f "delims=" %%L in ('powershell -NoProfile -Command "Get-Content -LiteralPath '%TEMP%\claude-zh-cn-restore.log' -Tail 30 -ErrorAction SilentlyContinue"') do echo   %%L
goto :eof
:tail_none
echo   · 没有日志文件，还原程序应该没跑起来
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
