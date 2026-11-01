# 截取指定进程的主窗口（PrintWindow + PW_RENDERFULLCONTENT）。
#
# 为什么不用 CopyFromScreen：Claude 窗口一旦被别的窗口盖住，
# 截出来就是盖住它的那个窗口。PrintWindow 让目标窗口自己画到内存位图上，
# 不受遮挡影响；PW_RENDERFULLCONTENT(2) 是 Electron/Chromium 这类 GPU
# 合成窗口必需的标志，否则截出来是纯白。
#
# 注意：Add-Type 必须显式 -ReferencedAssemblies 'System.Drawing'，
# 否则 PowerShell 5.1 内嵌编译器会编译失败，随后每次 [WinCap] 都报
# TypeNotFound，刷满整屏错误。
param(
    [string]$ProcessName = 'claude',
    [string]$OutFile = "$env:TEMP\claude-shot.png",
    [int]$WaitSeconds = 25,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class WinCap {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static List<IntPtr> WindowsOf(uint pid) {
        var list = new List<IntPtr>();
        EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p == pid && IsWindowVisible(h) && GetWindowTextLength(h) > 0) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static string Title(IntPtr h) {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }

    public static bool Capture(IntPtr h, string path) {
        RECT r; GetWindowRect(h, out r);
        int w = r.Right - r.Left, ht = r.Bottom - r.Top;
        if (w <= 0 || ht <= 0) return false;
        using (var bmp = new System.Drawing.Bitmap(w, ht))
        using (var g = System.Drawing.Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            bool ok = PrintWindow(h, hdc, 2);
            g.ReleaseHdc(hdc);
            if (!ok) return false;
            bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
        return true;
    }
}
'@

try {
    Add-Type -TypeDefinition $cs -ReferencedAssemblies 'System.Drawing'
} catch {
    Write-Host "Add-Type 失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

function Get-ClaudeWindows {
    $procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
    $out = @()
    foreach ($p in $procs) {
        foreach ($h in [WinCap]::WindowsOf([uint32]$p.Id)) {
            $out += [pscustomobject]@{ Handle = $h; Title = [WinCap]::Title($h); Pid = $p.Id }
        }
    }
    return $out
}

$wins = @(Get-ClaudeWindows)
if ($wins.Count -eq 0 -and -not $NoLaunch) {
    Write-Host '没有找到 Claude 窗口，尝试启动...' -ForegroundColor Yellow
    Start-Process 'shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude'
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 1500
        $wins = @(Get-ClaudeWindows)
        if ($wins.Count -gt 0) { break }
    }
}

if ($wins.Count -eq 0) {
    Write-Host '仍然没有可见窗口' -ForegroundColor Red
    exit 1
}

$target = $wins[0]
Write-Host "窗口: $($target.Title) (PID $($target.Pid))"
[void][WinCap]::ShowWindow($target.Handle, 9)
[void][WinCap]::SetForegroundWindow($target.Handle)
Start-Sleep -Milliseconds 1500

if ([WinCap]::Capture($target.Handle, $OutFile)) {
    Write-Host "已保存: $OutFile"
    exit 0
}
Write-Host '截图失败' -ForegroundColor Red
exit 1
