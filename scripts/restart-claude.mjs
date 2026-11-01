#!/usr/bin/env node
/**
 * 重启 Claude Desktop，让语言文件改动立刻生效。
 *
 * 为什么需要它
 * ------------
 * 装完汉化后必须「完全退出 Claude 再打开」——只关窗口不够，Claude 会留在
 * 托盘里继续跑，于是新语言文件不生效，用户以为装失败了。
 * 让用户自己去托盘找图标很反人类，所以装完/还原完直接问一句，帮着重启。
 *
 * 退出码：
 *   0 重启成功
 *   1 没找到 Claude 安装包
 *   2 启动失败
 *
 * 用法：
 *   node scripts/restart-claude.mjs          安静模式（只返回码）
 *   node scripts/restart-claude.mjs --verbose 打印过程
 */
import { execFileSync } from 'node:child_process'

const VERBOSE = process.argv.includes('--verbose')
const say = (s) => {
  if (VERBOSE) console.log(s)
}

/** 问系统要包族名 + AppId，拼出 UWP 启动标识。 */
function appUserModelId() {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "$p = Get-AppxPackage -Name '*Claude*' | Select-Object -First 1; if ($p) { $p.PackageFamilyName }",
      ],
      { encoding: 'utf8', timeout: 20000 },
    ).trim()
    if (out) return `${out}!Claude`
  } catch {
    // 忽略，退回已知值
  }
  return null
}

/** 结束所有 Claude 进程（托盘常驻的那个也算）。 */
function stopClaude() {
  let killed = 0
  try {
    execFileSync('taskkill.exe', ['/IM', 'Claude.exe', '/F'], { stdio: 'ignore', timeout: 20000 })
    killed++
  } catch {
    // 没在运行时会返回非零，正常
  }
  // MSIX 应用的进程可能叫别的名字（Claude.exe 是主进程），再兜一次
  try {
    execFileSync('taskkill.exe', ['/IM', 'claude.exe', '/F'], { stdio: 'ignore', timeout: 20000 })
    killed++
  } catch {}
  say(killed ? '  ✔ 已退出 Claude' : '  · Claude 本来就没在运行')
  return killed
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

stopClaude()
sleep(1500)

const aumid = appUserModelId()
const targets = []
if (aumid) targets.push(aumid)
// 兜底：包族名来自 MSIX 签名，跨版本稳定
const fallback = 'Claude_pzs8sxrjxfjjc!Claude'
if (!targets.includes(fallback)) targets.push(fallback)

/** 等 Claude 进程出现（explorer 的退出码不可信，只能看进程）。 */
function waitForClaude(seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq Claude.exe', '/NH'], {
        encoding: 'utf8',
        timeout: 10000,
      })
      if (/Claude\.exe/i.test(out)) return true
    } catch {}
    sleep(500)
  }
  return false
}

let started = false
for (const t of targets) {
  try {
    // explorer.exe 启动 shell:AppsFolder 时即使成功也会返回非零，
    // 所以这里不看退出码，直接等进程出现。
    execFileSync('explorer.exe', [`shell:AppsFolder\\${t}`], { stdio: 'ignore', timeout: 20000 })
  } catch {}
  if (waitForClaude(15)) {
    say(`  ✔ 已启动 Claude（${t}）`)
    started = true
    break
  }
  say(`  ! 这种方式没起来：${t}`)
}

process.exit(started ? 0 : 2)
