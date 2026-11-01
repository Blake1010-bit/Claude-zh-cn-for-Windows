# 提权助手：先试计划任务（不弹 UAC），不行再退回标准 UAC 弹窗。
#
# 为什么要两个方案
# ----------------
# 方案 A：计划任务 + RunLevel Highest
#   完全不弹 UAC，用户双击之后什么都不用点，体验最好。
#   但注册任务本身在有些机器上需要额外权限，失败就算了。
#
# 方案 B：Start-Process -Verb RunAs
#   最标准的路子，一定会弹 UAC 确认框。
#   唯一的坑：确认框画在"安全桌面"上，如果发起方不是交互式桌面会话，
#   用户可能看不到它，表现出来就是"双击没反应"。
#
# 两个都不行时，明确告诉用户右键 -> 以管理员身份运行，而不是干等。

param(
    [Parameter(Mandatory = $true)][string]$Script,
    [string[]]$ScriptArgs = @(),
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

# ---- 先看现在是不是已经有管理员权限 ----
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

# elevate.ps1 把每个目录的原始 ACL 备份到这里，还原成功才删。
$aclBakDir = Join-Path $env:TEMP 'claude-zh-cn-acl'

<#
 兜底还原权限。

 这是"用户装到一半把提权窗口关了"这个坑的正解，而且只有在**不提权**的
 父进程里才做得到：takeown 已经把目录属主改成了当前用户，属主改自己拥有的
 目录的 ACL 是允许的，不需要管理员权限。

 父进程一定比提权进程活得久 —— 提权窗口被关掉，父进程照样把这句跑完。
#>
function Restore-LeftoverAcls {
    if (-not (Test-Path -LiteralPath $aclBakDir)) { return }
    $files = @(Get-ChildItem -LiteralPath $aclBakDir -Filter '*.xml' -ErrorAction SilentlyContinue)
    if ($files.Count -eq 0) { return }

    Write-Host ''
    Write-Host "Checking leftover permission backups ($($files.Count))..." -ForegroundColor Yellow

    foreach ($f in $files) {
        $side = [IO.Path]::ChangeExtension($f.FullName, '.path')
        $target = $null
        try { if (Test-Path -LiteralPath $side) { $target = (Get-Content -LiteralPath $side -Raw).Trim() } } catch { }

        if ($target -and (Test-Path -LiteralPath $target)) {
            try {
                Set-Acl -LiteralPath $target -AclObject (Import-Clixml -LiteralPath $f.FullName) -ErrorAction Stop
                Write-Host "      restored  $target" -ForegroundColor Green
            } catch {
                Write-Host "      failed    $target" -ForegroundColor Yellow
                continue   # 留着备份，下次再试
            }
        }
        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $side -Force -ErrorAction SilentlyContinue
    }
}

function Clear-AclBackups {
    if (Test-Path -LiteralPath $aclBakDir) {
        Remove-Item -LiteralPath $aclBakDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Elevated {
    # ---- 方案 A：计划任务 ----
    $taskName = 'ClaudeZhCnElevatedRun'
    $ok = $false
    try {
        $parts = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$Script`"")
        foreach ($a in $ScriptArgs) { $parts += "`"$a`"" }

        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($parts -join ' ')
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
            -LogonType Interactive -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal `
            -Settings $settings -ErrorAction Stop | Out-Null
        $ok = $true
    } catch {
        $ok = $false
    }

    if ($ok) {
        Write-Host '  (无需 UAC，正在通过计划任务提权...)' -ForegroundColor DarkGray
        try {
            Start-ScheduledTask -TaskName $taskName

            # 等重要的一点：判断"跑完了没有"必须看 State，不能看 LastTaskResult。
            #
            # 刚注册完还没跑过时，LastTaskResult 是 0x41303（267011，"尚未运行"）。
            # 而 0x41303 不是"正在运行"的 0x41301，早期版本据此立刻认定任务已结束、
            # 直接把 267011 当成进程退出码返回 —— 安装其实还在跑，外面却已经报失败。
            # 这个 bug 有随机性：机器快的时候任务已经开跑（0x41301）就看不出来，
            # 机器慢或首次运行时必现。换成看 State 就没有这个问题。
            $deadline = (Get-Date).AddMinutes(30)
            # 提权进程写完退出码就说明事情干完了。等它的窗口自己关掉是不可靠的：
            # elevate.ps1 结尾有个「按回车关闭本窗口」，用户不按就一直在 Running，
            # 外面这个父窗口会白等（实测卡了 6 分钟以上，看起来像卡死）。
            $doneMarker = Join-Path $env:TEMP 'claude-zh-cn-done.txt'
            while ((Get-Date) -lt $deadline) {
                if (Test-Path -LiteralPath $doneMarker) { break }
                $t = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
                if ($t.State -ne 'Running') { break }
                Start-Sleep -Milliseconds 700
            }
            Start-Sleep -Milliseconds 400   # 让 LastTaskResult 落定

            $info = Get-ScheduledTaskInfo -TaskName $taskName
            $result = [int]$info.LastTaskResult
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

            # 计划任务不传递退出码，只给一个 HRESULT：
            #   0        = 成功
            #   0x41303  = 还没跑过（正常流程下不该出现，说明任务没起来）
            #   其它非零 = 失败
            if ($result -eq 0) { return 0 }
            Write-Host "  (计划任务返回 $result，改用 UAC 方式再试一次)" -ForegroundColor DarkGray
            # 落到方案 B
        } catch {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
            # 落到方案 B
        }
    }

    # ---- 方案 B：标准 UAC ----
    Write-Host '  (即将弹出 UAC 确认框，请点「是」)' -ForegroundColor Yellow
    try {
        $p = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script) + $ScriptArgs) `
            -Verb RunAs -PassThru -ErrorAction Stop
        $p.WaitForExit()
        return $p.ExitCode
    } catch {
        Write-Host ''
        Write-Host '  [错误] 无法自动提权（UAC 被拒绝或确认框没显示出来）。' -ForegroundColor Red
        Write-Host '  请手动操作：右键这个 .bat -> 以管理员身份运行' -ForegroundColor Yellow
        return 1
    }
}

if ($DryRun) {
    # 空跑：只报告会走哪条分支，不真的提权。
    # 用来验证"用户双击之后会发生什么"，不必真的弹 UAC。
    Write-Host "身份         : $($id.Name)"
    Write-Host "已是管理员   : $isAdmin"
    Write-Host "目标脚本     : $Script"
    Write-Host "参数         : $($ScriptArgs -join ' ')"
    Write-Host "ACL 备份目录 : $aclBakDir"
    if ($isAdmin) {
        Write-Host '分支         : 已提权，直接执行'
    } else {
        Write-Host '分支         : 先试计划任务（不弹 UAC），失败回退 UAC 弹窗'
    }
    exit 0
}

if ($isAdmin) {
    # 已经是管理员，直接跑，不必再提权
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script @ScriptArgs
    exit $LASTEXITCODE
}

# 干净开局：清掉上一轮的 ACL 备份，免得把陈旧的状态当成这一轮的
Clear-AclBackups

$code = Invoke-Elevated

# 无论提权进程是正常结束还是被用户关掉，都在这里再确认一次权限已还原。
# 提权进程自己也会还原；已经还原干净时这里是空操作。
Restore-LeftoverAcls

exit $code
