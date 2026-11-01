@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Claude 汉化 - 安装
set "VER=1.1.2"
set "NODE_EXE="
set "CODE="
set "RES_HINT="
set "NEED="

rem Locate node: PATH first, then the usual install locations.
rem The discovered path is handed to elevate.ps1 through CLAUDE_ZH_CN_NODE,
rem because the elevated process is a NEW process and may not inherit PATH
rem (nvm-windows / Volta / fnm are the usual culprits).
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

rem CLAUDE_ZH_CN_YES=1 skips every confirmation prompt (used by tests).
cls
call :banner
call :env

"!NODE_EXE!" "%~dp0scripts\need-admin.mjs" 2>nul
set "NEED=!ERRORLEVEL!"

echo.
echo   当前状态
if "!NEED!"=="2" goto :state_admin
if "!NEED!"=="0" goto :state_fresh
echo     · 可以安装，当前有写入权限
goto :state_done
:state_admin
echo     · 需要管理员权限才能写入 Claude 目录，稍后会请求提权
goto :state_done
:state_fresh
echo     · 已经是最新的中文界面
echo.
echo   想强制重装一遍也可以，原有译文会被覆盖。
if defined CLAUDE_ZH_CN_YES goto :state_done
choice /c RQ /n /m "   [R] 重新安装    [Q] 退出   " 2>nul
if errorlevel 2 goto :bye

:state_done
if defined CLAUDE_ZH_CN_YES goto :start_install
echo.
echo   接下来会做这些事
echo     · 把 zh-CN 注册进 Claude 的语言白名单
echo     · 写入前端界面和桌面外壳的中文语言文件
echo     · 动手前先备份原文件，随时可以用「一键还原」退回
echo.
choice /c YN /n /m "   开始安装吗？[Y/n] " 2>nul
if errorlevel 2 goto :bye

:start_install
if "!NEED!"=="2" goto :run_elevate
goto :run_direct

rem Elevate through a helper: a plain "Start-Process -Verb RunAs" can show the
rem UAC prompt on the secure desktop where the user never sees it. The helper
rem tries a scheduled task with RunLevel Highest first, then falls back to UAC.
:run_elevate
echo.
echo   正在请求管理员权限…
echo   弹出的 UAC 窗口请点「是」。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item '%TEMP%\claude-zh-cn-done.txt' -Force -ErrorAction SilentlyContinue; & '%~dp0scripts\elevate-run.ps1' -Script '%~dp0scripts\elevate.ps1' -ScriptArgs '-NoPause'"
call :wait_done
if not exist "%TEMP%\claude-zh-cn-done.txt" goto :still_open
set /p CODE=<"%TEMP%\claude-zh-cn-done.txt"
if "!CODE!"=="0" goto :done
goto :failed

:run_direct
echo.
echo   正在安装…
echo.
"!NODE_EXE!" "%~dp0scripts\install.mjs" %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="4" goto :checkonly
if not "%CODE%"=="0" goto :failed
goto :done

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
echo   正在安装…
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\elevate.ps1" -NoPause
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" goto :failed
goto :done

:done
cls
call :banner
echo.
echo   ✔ 安装完成
echo.
echo   中文要生效，必须完全退出 Claude 再打开。
echo   只关窗口不够 —— Claude 会留在托盘里继续运行。
echo.
if defined CLAUDE_ZH_CN_YES goto :done_manual
choice /c YN /n /m "   现在帮你自动重启 Claude 吗？[Y/n] " 2>nul
if errorlevel 2 goto :done_manual
echo.
"!NODE_EXE!" "%~dp0scripts\restart-claude.mjs" --verbose
if errorlevel 1 goto :done_manual
echo.
echo   ✔ Claude 已重新打开，界面应该已经是中文了。
goto :done_end
:done_manual
echo.
echo   手动重启方法
echo     右下角托盘图标（时钟旁边）→ 右键 → 退出 → 再打开
:done_end
echo.
echo   不满意想退回英文：双击「一键还原.bat」
echo.
pause
exit /b 0

:checkonly
cls
call :banner
echo.
echo   · 空跑结束，什么都没改
echo.
echo   去掉 check 参数再运行一次就是真的安装。
echo.
pause
exit /b 0

:failed
if not defined CODE set "CODE=1"
cls
call :banner
echo.
echo   ✘ 安装失败        退出码 !CODE!
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
echo   完整日志：%TEMP%\claude-zh-cn-install.log
echo.
if defined CLAUDE_ZH_CN_YES goto :failed_end
choice /c YN /n /m "   用记事本打开日志吗？[Y/n] " 2>nul
if errorlevel 2 goto :failed_end
if exist "%TEMP%\claude-zh-cn-install.log" start "" notepad "%TEMP%\claude-zh-cn-install.log"
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
echo   安装过程中的中文提示都在那边。
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
echo   Claude Desktop 简体中文汉化        v%VER%
echo   仅支持第三方登录状态 · 官方登录模式未开发
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

rem Print the tail of elevate.ps1's transcript: the generic cause list alone
rem never says what actually broke, the log does.
:tail_log
if not exist "%TEMP%\claude-zh-cn-install.log" goto :tail_none
echo   日志最后 30 行
echo.
for /f "delims=" %%L in ('powershell -NoProfile -Command "Get-Content -LiteralPath '%TEMP%\claude-zh-cn-install.log' -Tail 30 -ErrorAction SilentlyContinue"') do echo   %%L
goto :eof
:tail_none
echo   · 没有日志文件，安装程序应该没跑起来
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
