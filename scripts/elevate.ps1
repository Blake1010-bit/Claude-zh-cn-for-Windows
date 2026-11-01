# 以管理员身份安装：取得写权限 -> 跑安装 -> 还原权限。
#
# 为什么提权还不够
# ----------------
# Claude 的 resources 目录归 TrustedInstaller 所有，ACL 是：
#     BUILTIN\Users          ReadAndExecute
#     BUILTIN\Administrators ReadAndExecute      <-- 管理员也只有读！
# 所以即使以管理员身份运行，直接写文件依然会被拒绝。
# 必须 takeown 取得所有权 + icacls 显式授权。
#
# 授权范围为什么这样选（实测数据）
# --------------------------------
#     resources\ion-dist\i18n        21 个文件   -> 递归，约 0.1 秒
#     resources（根）                 28 个文件   -> 递归，很快
#     resources\ion-dist\assets\v1  3047 个文件   -> 不递归，只对该目录本身
# 早先的版本对整棵树（3277 个文件）递归，表现为窗口停在「取得写权限」不动。
#
# 另外，只对"已存在的文件"授权不够：zh-CN.json 在重装后不存在，
# 需要**父目录的 CreateFiles 权限**才能新建。所以对目录授权（带继承）。
#
# 本脚本由 .bat 通过 Start-Process -Verb RunAs 拉起。

param(
    [string]$ResourcesDir = '',
    [ValidateSet('install', 'restore', 'repair')]
    [string]$Mode = 'install',
    [switch]$KeepAcl,
    [switch]$NoPause
)

$ErrorActionPreference = 'Continue'

function Say($m, $color = 'Gray') { Write-Host $m -ForegroundColor $color }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------------------------------------------------------------------------
# 权限备份 / 还原
#
# 备份文件必须一直留在磁盘上，直到确认还原成功 —— 不能"用完就删"。
# 实测踩过一次：用户在安装过程中关掉了窗口，进程被结束，
# 于是 [3/3] 还原那一步整段没跑，Claude 目录的 ACL 一直停在被改过的状态。
# 现在改成：备份文件留着，Done() 里再兜一次；下一次运行也会先清理上次的残留。
# ---------------------------------------------------------------------------
$script:aclBackups = @()
# 累计"真正还原过几份 ACL"，会在 [3/3] 和 Done() 里被重复调用累加，
# 所以用累计值而不是每次重置 —— 否则最后打印出来会是 0，误导用户。
$script:aclRestoredCount = 0
$aclBakDir = Join-Path $env:TEMP 'claude-zh-cn-acl'

function Backup-Acl($path) {
    try {
        if (-not (Test-Path -LiteralPath $aclBakDir)) { New-Item -ItemType Directory -Path $aclBakDir -Force | Out-Null }
    } catch { return }
    $bak = Join-Path $aclBakDir ('acl_' + [IO.Path]::GetRandomFileName() + '.xml')
    try {
        (Get-Acl -LiteralPath $path) | Export-Clixml -LiteralPath $bak -ErrorAction Stop
        # 旁边记一份"这份备份属于哪个目录"，下次开机清理残留时要用
        [IO.File]::WriteAllText([IO.Path]::ChangeExtension($bak, '.path'), $path)
        $script:aclBackups += @{ Path = $path; Backup = $bak }
    } catch { }
}

<#
 还原所有已备份的 ACL。

 幂等，而且**可以安全地重复调用** —— 这一点是必需的，因为正常流程里
 它会被调用两次：一次是 [3/3] 还原权限，一次是 Done() 里的兜底
 （用户中途关窗口时只有后者会执行）。

 备份文件在还原成功后就被删掉了，所以第二次调用时这些文件已经不存在。
 早期版本没有判断这一点，直接 Import-Clixml 一个不存在的文件，
  PowerShell 会把终止性错误打到控制台上 —— 用户看到的是安装"成功"之后
 突然冒出四行 `未能找到文件 ...acl_xxx.xml`，非常吓人。
 现在把"备份已不在"当成"已经还原过"，直接跳过。
#>
function Restore-Acls {
    if ($script:aclBackups.Count -eq 0) { return $true }
    $allOk = $true
    $did = 0
    foreach ($b in $script:aclBackups) {
        if (-not (Test-Path -LiteralPath $b.Backup)) { continue }   # 已经还原过
        try {
            $saved = Import-Clixml -LiteralPath $b.Backup -ErrorAction Stop
            Set-Acl -LiteralPath $b.Path -AclObject $saved -ErrorAction Stop
            Remove-Item -LiteralPath $b.Backup -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath ([IO.Path]::ChangeExtension($b.Backup, '.path')) -Force -ErrorAction SilentlyContinue
            $did++
        } catch {
            $allOk = $false
        }
    }
    $script:aclRestoredCount += $did
    return $allOk
}

<#
 清理上一次运行留下的备份（如果还有）：先把 ACL 还原回去，再删除备份。
 本脚本在开始改动之前会调用它，保证不会在"半改过"的状态上继续叠加。
#>
function Clear-StaleBackups {
    if (-not (Test-Path -LiteralPath $aclBakDir)) { return }
    $files = @(Get-ChildItem -LiteralPath $aclBakDir -Filter '*.xml' -ErrorAction SilentlyContinue)
    if ($files.Count -eq 0) { return }
    Say "  发现上次残留的权限备份 $($files.Count) 份，先还原..." 'Yellow'
    foreach ($f in $files) {
        $target = $null
        try {
            # 备份文件旁边留一个同名 .path 记录它属于哪个目录
            $side = [IO.Path]::ChangeExtension($f.FullName, '.path')
            if (Test-Path -LiteralPath $side) { $target = (Get-Content -LiteralPath $side -Raw).Trim() }
        } catch { }
        if ($target -and (Test-Path -LiteralPath $target)) {
            try {
                Set-Acl -LiteralPath $target -AclObject (Import-Clixml -LiteralPath $f.FullName) -ErrorAction Stop
                Say "      已还原 $target" 'Gray'
            } catch {
                Say "      还原失败 $target" 'Yellow'
            }
        }
        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ([IO.Path]::ChangeExtension($f.FullName, '.path')) -Force -ErrorAction SilentlyContinue
    }
}

# 把全过程同时写进一份日志。
# 提权后的窗口是另一个进程，用户一关输出就没了；有日志才能查"卡在哪一步"。
$logPath = Join-Path $env:TEMP "claude-zh-cn-$Mode.log"
try {
    Start-Transcript -LiteralPath $logPath -Force -ErrorAction Stop | Out-Null
    $script:hasLog = $true
} catch {
    $script:hasLog = $false
}

function Done($code) {
    # 先兜一次权限还原。
    # 正常流程在 [3/3] 已经还原过（那时这个调用是空操作）；
    # 但用户如果在安装中途关掉窗口，[3/3] 根本不会执行，
    # 这里就是最后一道保险 —— 只要进程还能走到退出，权限就不会留成改过的样子。
    if (-not $KeepAcl) { Restore-Acls | Out-Null }

    if ($script:hasLog) {
        Say ''
        Say "完整日志: $logPath" 'DarkGray'
        try { Stop-Transcript -ErrorAction SilentlyContinue | Out-Null } catch { }
    }

    # 退出码写进一个标记文件。
    #
    # 为什么需要它：提权后的进程是独立进程，外面那个 .bat 拿不到它的退出码。
    # 这个文件也顺便充当"已经结束了"的信号 —— 父进程靠等它来判断该不该收尾。
    try {
        [IO.File]::WriteAllText((Join-Path $env:TEMP 'claude-zh-cn-done.txt'), "$code")
    } catch { }

    # NoPause 只给自动化测试用（让窗口自己关掉）。
    # 其它情况都要停住，让用户看清结果和日志路径。
    if (-not $NoPause) {
        Say ''
        Read-Host '按回车关闭本窗口' | Out-Null
    }
    exit $code
}

Say ''
Say '============================================================' 'Cyan'
if ($Mode -eq 'restore') {
    Say '  Claude 中文汉化 - 管理员还原' 'Cyan'
} else {
    Say '  Claude 中文汉化 - 管理员安装' 'Cyan'
}
Say '============================================================' 'Cyan'
Say ''

# ---- 找 node ----
# Get-Command 先看 PATH；找不到再按常见安装位置逐个试。
#
# 为什么要这么多候选：非提权那一侧（.bat）已经确认过 node 存在，
# 但提权后的进程是新起的，继承到的 PATH 未必和用户会话一致
# （尤其是 nvm-windows / Volta / fnm 这类"按用户装的"版本管理器）。
# 第一项直接借用 .bat 探到的结果，是最可靠的一条。
# 注意 Select-Object -First 1：提权进程的 PATH 往往比用户会话长，
# `Get-Command node` 可能返回**多个**匹配，此时 .Source 是一个数组，
# 后面 `& $node ...` 会抛
#     “程序node.exe无法运行: 索引超出了数组界限”
# 而且这是终止性错误 —— 安装其实没跑，脚本却已经进了失败分支。
# 早先误以为是数组展开（@nodeArgs）的问题，其实是这里。
$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) {
    $cands = @(
        $env:CLAUDE_ZH_CN_NODE,
        'D:\Node.js\node.exe',
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:APPDATA\npm\node.exe",
        "$env:USERPROFILE\scoop\apps\nodejs\current\node.exe",
        "$env:LOCALAPPDATA\Volta\bin\node.exe",
        "$env:USERPROFILE\.volta\bin\node.exe",
        "$env:ProgramFiles\Microsoft\nodejs\node.exe"
    )
    foreach ($c in $cands) {
        if ($c -and (Test-Path -LiteralPath $c)) { $node = $c; break }
    }
    # nvm-windows 把各版本放在 %APPDATA%\nvm\vX.Y.Z\node.exe，从新到旧逐个试
    if (-not $node -and (Test-Path "$env:APPDATA\nvm")) {
        $nvmNode = Get-ChildItem "$env:APPDATA\nvm" -Directory -Filter 'v*' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'node.exe' } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
        if ($nvmNode) { $node = $nvmNode }
    }
}
if (-not $node) {
    Say '[错误] 找不到 Node.js' 'Red'
    Say '请先安装：https://nodejs.org/'
    Done 1
}

# ---- 确认管理员身份 ----
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Say "使用 Node.js: $node"
Say "当前账户: $($identity.Name)   管理员权限: $isAdmin"
if (-not $isAdmin) {
    Say ''
    Say '[错误] 本进程没有管理员权限。' 'Red'
    Say '请右键「一键安装中文.bat」-> 以管理员身份运行' 'Yellow'
    Done 1
}

# ---- 找 resources ----
if (-not $ResourcesDir -or -not (Test-Path -LiteralPath $ResourcesDir)) {
    $pkg = Get-AppxPackage -Name '*Claude*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pkg) {
        $cand = Join-Path $pkg.InstallLocation 'app\resources'
        if (Test-Path -LiteralPath (Join-Path $cand 'en-US.json')) { $ResourcesDir = $cand }
    }
}
if (-not $ResourcesDir -or -not (Test-Path -LiteralPath $ResourcesDir)) {
    Say '[错误] 找不到 Claude 的 resources 目录' 'Red'
    Say '请确认已安装 Claude Desktop 桌面版。'
    Done 1
}
Say "资源目录: $ResourcesDir"
Say ''

# 把真实位置告诉 node 那边的路径探测。
# 探测表里写死的版本号会随 Claude 更新过期，而这里是从 Get-AppxPackage
# 直接问出来的，永远是对的。临时文件给 .bat 用，环境变量给本进程用。
try {
    [IO.File]::WriteAllText((Join-Path $env:TEMP 'claude-zh-cn-resources.txt'), $ResourcesDir)
    $env:CLAUDE_RESOURCES_HINT = $ResourcesDir
} catch { }

$user = "$env:USERDOMAIN\$env:USERNAME"
$i18n = Join-Path $ResourcesDir 'ion-dist\i18n'
$v1 = Join-Path $ResourcesDir 'ion-dist\assets\v1'

# ---------------------------------------------------------------------------
# 修复模式：把被我们改过的权限重置回「继承自上级」的状态
#
# 为什么需要：安装流程会在 Claude 目录上显式加一条 "(OI)(CI)M" 授权，
# 正常结束时会用备份的 ACL 覆盖回去。但如果那一步被打断（用户关窗口、
# 进程被杀），这条授权就会留在原地 —— 目录变成"当前用户可写"，
# 下次 need-admin 探测会误判成"不用提权"，然后写到一半 EPERM。
#
# icacls /reset 正是这个场景的正解：它把显式 ACE 全部去掉，只保留继承来的。
# ---------------------------------------------------------------------------
if ($Mode -eq 'repair') {
    Say '[修复] 重置 Claude 目录的权限为继承状态'
    $targets = @(
        @{ Path = $i18n;          Label = '前端语言文件目录' },
        @{ Path = $ResourcesDir;  Label = '外壳语言文件目录' },
        @{ Path = $v1;            Label = '前端资源目录' }
    )
    foreach ($t in $targets) {
        if (-not (Test-Path -LiteralPath $t.Path)) { continue }
        try {
            & icacls.exe "$($t.Path)" /reset /C /Q 2>&1 | Out-Null
            # 验证：当前用户在这条路径上还有没有显式授权
            $acl = Get-Acl -LiteralPath $t.Path
            $mine = @($acl.Access | Where-Object { $_.IdentityReference -eq $user -and -not $_.IsInherited })
            if ($mine.Count -eq 0) {
                Say "      OK   $($t.Label)"
            } else {
                Say "      !    $($t.Label) 仍保留 $($mine.Count) 条显式授权" 'Yellow'
            }
        } catch {
            Say "      !    $($t.Label) 重置失败：$($_.Exception.Message)" 'Yellow'
        }
    }
    Say ''
    Done 0
}

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
# 注意：$script:aclBackups / Backup-Acl / Restore-Acls / Clear-StaleBackups
# 都在文件开头定义（Done() 里要用到，必须在那之前）。

function Grant-Dir($path, $recurse, $label) {
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    Backup-Acl $path

    if ($recurse) {
        & takeown.exe /F "$path" /R /D Y 2>&1 | Out-Null
        & icacls.exe "$path" /grant "${user}:(OI)(CI)M" /T /C /Q 2>&1 | Out-Null
    } else {
        & takeown.exe /F "$path" /D Y 2>&1 | Out-Null
        & icacls.exe "$path" /grant "${user}:(OI)(CI)M" /C /Q 2>&1 | Out-Null
    }

    # 验证能不能在它下面新建文件（这是重装后能否成功的关键）
    $probe = Join-Path $path '_wprobe.tmp'
    try {
        [IO.File]::WriteAllText($probe, 'x')
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        Say "      OK   $label"
        return $true
    } catch {
        Say "      FAIL $label" 'Yellow'
        return $false
    }
}

# ---------------------------------------------------------------------------
# 1. 授权
# ---------------------------------------------------------------------------
Say '[1/3] 取得写权限'

Clear-StaleBackups

$ok1 = Grant-Dir $i18n $true '前端语言文件目录 (ion-dist\i18n)'
$ok2 = Grant-Dir $ResourcesDir $true '外壳语言文件目录 (resources)'
$ok3 = Grant-Dir $v1 $false '前端资源目录 (assets\v1)'

# 白名单文件单独授权（它已存在，需要能覆盖）
$wlFiles = @()
if (Test-Path -LiteralPath $v1) {
    $cands = & findstr.exe /M /C:"de-DE" "$v1\*.js" 2>$null
    foreach ($c in @($cands)) {
        if (-not $c) { continue }
        try {
            $lines = Get-Content -LiteralPath $c -TotalCount 3000 -ErrorAction Stop
            $joined = $lines -join ' '
            if ($joined.Contains('["en-US","de-DE"') -and $joined.Contains('"ja-JP"')) { $wlFiles += $c }
        } catch { }
    }
}
foreach ($w in $wlFiles) {
    Backup-Acl $w
    & takeown.exe /F "$w" 2>&1 | Out-Null
    & icacls.exe "$w" /grant "${user}:M" /C /Q 2>&1 | Out-Null
    try {
        $b = [IO.File]::ReadAllBytes($w)
        [IO.File]::WriteAllBytes($w, $b)
        Say "      OK   语言白名单 $([IO.Path]::GetFileName($w))"
    } catch {
        Say "      FAIL 语言白名单 $([IO.Path]::GetFileName($w))" 'Yellow'
    }
}

if (-not ($ok1 -or $ok2)) {
    Say ''
    Say '[错误] 关键目录都没有取得写权限，无法继续。' 'Red'
    Done 1
}

Say ''
Say ('-' * 60)

# ---------------------------------------------------------------------------
# 调 node 的统一入口
#
# 为什么不用 `& $node 脚本.mjs`：
# 实测在提权后的进程里，这种原生调用会抛
#     “程序node.exe无法运行: 索引超出了数组界限”
# 而且它是终止性错误、$LASTEXITCODE 还留着上一条命令的 0 ——
# 结果安装根本没跑，脚本却打印「安装完成！」（两次踩到）。
# Start-Process -Wait -PassThru 直接拿真实退出码，绕开这个坑。
#
# 注意 -ArgumentList 是按空格拼接的，带空格的路径必须自己加引号。
# ---------------------------------------------------------------------------
function Invoke-Node {
    param([string[]]$ArgList)
    try {
        $p = Start-Process -FilePath $node -ArgumentList $ArgList -NoNewWindow -Wait -PassThru -ErrorAction Stop
        return [int]$p.ExitCode
    } catch {
        Say ''
        Say "  [错误] 启动 node 失败：$($_.Exception.Message)" 'Red'
        Say "  路径：$node" 'Yellow'
        return 1
    }
}
function Q($s) { if ($s -match '\s') { return '"' + $s + '"' } else { return $s } }

# ---------------------------------------------------------------------------
# 2. 跑安装
# ---------------------------------------------------------------------------
Say '[2/3] 执行安装'
Say ''

if ($Mode -eq 'restore') {
    # 还原模式：只把语言文件删掉/还原成英文，不需要再跑安装校验。
    $code = Invoke-Node @((Q (Join-Path $scriptDir 'restore.mjs')))
} else {
    # 先复验一次权限：确认刚到手的写权限在 node 眼里也有效。
    # 这一步失败就不必往下走，省得用户等到写文件时才发现 EPERM。
    $needCode = Invoke-Node @((Q (Join-Path $scriptDir 'need-admin.mjs')))
    if ($needCode -eq 2) {
        Say ''
        Say '[错误] 权限获取后仍然写不进去。' 'Red'
        Say '可能是杀毒软件或「受控文件夹访问」拦住了，请临时关闭后重试。' 'Yellow'
        Done 1
    }

    $installScript = Join-Path $scriptDir 'install.mjs'
    $code = 1
    $script:installStart = (Get-Date).AddSeconds(-2)
    if (-not (Test-Path -LiteralPath $installScript)) {
        Say "  [错误] 找不到 $installScript" 'Red'
    } else {
        if ($ResourcesDir) {
            $code = Invoke-Node @((Q $installScript), '--resources', (Q $ResourcesDir))
        } else {
            $code = Invoke-Node @((Q $installScript))
        }
        # 收尾自检：退出码是 0 也要确认语言文件真的落地了。
        # 早先只看退出码，node 调用失败时脚本仍报「安装完成」（实际踩过）。
        if ($code -eq 0) {
            $zhFront = Join-Path $i18n 'zh-CN.json'
            $zhShell = Join-Path $ResourcesDir 'zh-CN.json'
            $okFiles = $true
            foreach ($f in @($zhFront, $zhShell)) {
                if (-not (Test-Path -LiteralPath $f)) {
                    Say "  [错误] 安装后找不到 $(Split-Path -Leaf $f)：$f" 'Red'
                    $okFiles = $false
                } elseif ((Get-Item -LiteralPath $f).LastWriteTime -lt $script:installStart) {
                    Say "  [错误] $(Split-Path -Leaf $f) 没有更新，安装可能没真正执行" 'Red'
                    $okFiles = $false
                }
            }
            if (-not $okFiles) { $code = 1 }
        }
    }
}

Say ''
Say ('-' * 60)

# ---------------------------------------------------------------------------
# 3. 还原权限
# ---------------------------------------------------------------------------
Say '[3/3] 还原权限'
if (-not $KeepAcl) {
    if (Restore-Acls) {
        Say '      OK   已还原为原样'
    } else {
        Say '      !    部分目录还原失败，稍后退出时会再试一次' 'Yellow'
    }
}

Say ''
if ($code -eq 0) {
    Say '============================================================' 'Green'
    Say '  安装完成！' 'Green'
    Say ''
    Say '  请完全退出 Claude 再重新打开：' 'Green'
    Say '    右下角托盘图标（时钟旁边）右键 - 退出 - 再启动' 'Green'
    Say '============================================================' 'Green'
} else {
    Say '============================================================' 'Red'
    Say "  安装失败（退出码 $code）" 'Red'
    Say '============================================================' 'Red'
    Say ''
    Say '  请把上面的内容截图反馈：'
    Say '  https://github.com/Blake1010-bit/Claude-zh-cn-for-Windows/issues'
    Say ''
    Say "  完整日志（可直接贴到 Issue 里）：$logPath" 'DarkGray'
}
Say ''
Say '  （安装过程中请不要关闭本窗口：写权限的还原是在最后一步做的，' 'DarkGray'
Say '    中途关掉窗口会让 Claude 目录一直保持可写状态。）' 'DarkGray'
Say ''
Done $code
