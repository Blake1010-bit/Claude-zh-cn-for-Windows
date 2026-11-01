#!/usr/bin/env node
/**
 * 一键还原：把语言文件恢复成安装前的样子。
 *
 * 用法：
 *   node scripts/restore.mjs --list     列出所有备份
 *   node scripts/restore.mjs            还原最近一次备份
 *   node scripts/restore.mjs 20260101120000   还原指定备份
 *   node scripts/restore.mjs --all      还原全部（按每个文件各自的最近备份）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { FRONTEND_I18N, findResources, diagnoseNotFound, PROJECT_ROOT } from '../lib/paths.mjs'
import { patchWhitelist } from './patch-whitelist.mjs'

const argv = process.argv.slice(2)
const found = findResources(argv)

if (found === null) {
  console.error(diagnoseNotFound())
  process.exit(1)
}

const RES = found.dir
const ROOT = join(RES, '.zh-cn-toolkit-backup')

/**
 * 本工具会新建的语言文件。清单来自 Claude 自己发布的语言，
 * 凡是不在这个清单里的 zh-*.json 就只可能是本工具放进去的。
 */
const TOOL_MADE = [
  join(RES, FRONTEND_I18N, 'zh-CN.json'),
  join(RES, 'zh-CN.json'),
]

/**
 * 删掉本工具放进去、但已经没有备份可还原的语言文件。
 *
 * 为什么必须有这一步（真实的坑）
 * ------------------------------
 * 原来只在「备份目录不存在」时直接退出。但 Claude **更新**时会把整个版本
 * 目录换掉：语言文件的备份随之消失，而用户之后重装一次，
 * 备份目录里就只剩白名单那一份了（两种备份的存活情况不一致）。
 *
 * 这时旧逻辑会「既没有备份可还原、也不删语言文件」——
 * 结果就是点了还原却什么都没变，看起来像"还原没反应"。
 */
function removeToolMadeFiles() {
  let n = 0
  for (const f of TOOL_MADE) {
    if (!existsSync(f)) continue
    try {
      unlinkSync(f)
      console.log(`  – 删除本工具放入的语言文件（无备份可还原）：${f.replace(RES, '…')}`)
      n++
    } catch (e) {
      console.error(`  ✘ 删除失败 ${f}：${e.message}`)
    }
  }
  return n
}

if (!existsSync(ROOT)) {
  console.log('没有找到本工具产生的备份。')
  console.log(`备份目录应为：${ROOT}`)
  console.log('')
  console.log('将按「清理模式」处理：删掉本工具放入的中文语言文件。')
  console.log('')
  const n = removeToolMadeFiles()
  if (n === 0) {
    console.log('  – 没有发现本工具放入的语言文件，Claude 本来就是原样。')
  }
  console.log('')
  console.log('完成。请完全退出 Claude 再重新打开（托盘图标右键 → 退出）。')
  process.exit(0)
}

/**
 * 备份目录里的「时间戳目录」才是语言文件的备份。
 * whitelist/ 是同级的一个特殊子目录，不算备份批次。
 */
const stamps = readdirSync(ROOT)
  .filter((n) => /^\d{14}$/.test(n))
  .sort()

if (argv.includes('--list')) {
  console.log(`备份列表（${ROOT}）：`)
  if (stamps.length === 0) console.log('  （没有语言文件备份）')
  for (const s of stamps) {
    const files = readdirSync(join(ROOT, s))
    console.log(`  ${s}   ${files.join(', ')}`)
  }
  process.exit(0)
}

/**
 * 一条语言文件的备份都没有 → 走「清理模式」。
 *
 * 这在实际使用中是常态：Claude 更新会清掉版本目录，
 * 之后重装一次，备份目录里往往只剩 whitelist/ 那一份。
 * 旧逻辑在这时会直接退出，导致「点了还原却什么都没变」。
 */
if (stamps.length === 0) {
  console.log('备份目录里没有语言文件备份。')
  console.log('')
  console.log('将按「清理模式」处理：删掉本工具放入的中文语言文件，')
  console.log('并还原语言白名单。')
  console.log('')
  const n = removeToolMadeFiles()

  const wlDir0 = join(ROOT, 'whitelist')
  if (existsSync(wlDir0)) {
    console.log('')
    console.log('还原语言白名单...')
    patchWhitelist(RES, { revert: true, quiet: false })
  }

  // 界面语言也退回英文，否则 Claude 仍会尝试选中一个不存在的语言
  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, [join(PROJECT_ROOT, 'scripts', 'set-locale.mjs'), 'en-US'], {
      stdio: 'inherit',
      timeout: 30000,
    })
  } catch {
    console.log('  – 界面语言未能自动退回，可手动运行：node scripts/set-locale.mjs en-US')
  }

  console.log('')
  console.log(`完成（清理了 ${n} 个语言文件）。`)
  console.log('请完全退出 Claude 再重新打开（托盘图标右键 → 退出）。')
  process.exit(0)
}

/** 备份文件名 → 它应该还原到哪个位置。 */
const destinations = {
  '前端界面-zh-CN.json': join(RES, FRONTEND_I18N, 'zh-CN.json'),
  '桌面外壳-zh-CN.json': join(RES, 'zh-CN.json'),
}

/**
 * 从命令行里挑出「指定备份编号」。
 *
 * 不能直接用 argv[2]：调用链是 一键还原.bat -> 自己(带 admin 参数) -> elevate.ps1
 * -> node restore.mjs，中间会有 --resources 之类的参数插进来，位置并不固定。
 * 所以只认「看起来像时间戳」的那一个，其余一律忽略。
 */
function fromArgvStamp(argv) {
  // 时间戳格式与 install.mjs 里生成备份目录的一致：YYYYMMDDHHMMSS
  const m = argv.find((a) => /^\d{14}$/.test(a))
  return m
}

const wanted = argv.includes('--all') ? stamps : [fromArgvStamp(argv) ?? stamps[stamps.length - 1]]

/**
 * 备份里是不是「本工具自己装的中文包」。
 *
 * 为什么必须判断：install.mjs 每次安装前都会把当前文件备份一份。用户装过
 * 两次之后，最近的那份备份其实**就是上一版中文包**，直接还原它等于什么
 * 都没做 —— 用户点「还原」却还是中文界面（实测踩到：还原后文件大小
 * 变回了上一版中文包，界面一点没变）。
 * 所以「还原」的语义统一成**回到英文**：备份是中文包就删掉目标文件。
 */
const looksChinese = (buf) => /[\u4e00-\u9fff]/.test(buf.toString('utf8').slice(0, 40000))

let restored = 0
let cleaned = 0
for (const stamp of wanted) {
  const dir = join(ROOT, stamp)
  if (!existsSync(dir)) {
    console.error(`找不到备份：${stamp}`)
    console.error(`可用：${stamps.join(', ')}`)
    process.exit(1)
  }
  console.log(`检查备份：${stamp}`)
  for (const name of readdirSync(dir)) {
    // whitelist 是子目录，由下面单独处理
    if (name === 'whitelist') continue
    const target = destinations[name]
    if (target === undefined) {
      console.log(`  – 跳过未知文件 ${name}`)
      continue
    }
    const buf = readFileSync(join(dir, name))
    if (looksChinese(buf)) {
      if (existsSync(target)) {
        unlinkSync(target)
        console.log(`  – ${name}：备份本身也是中文包，已删除界面文件（回到英文）`)
        cleaned++
      }
      continue
    }
    // 不用 copyFileSync：从备份写到 WindowsApps 目标时，
    // copyFile 会抛 UNKNOWN(-4094)；读入内存再写出可靠。
    writeFileSync(target, buf)
    console.log(`  ✔ ${name} → ${statSync(target).size} 字节（原文件）`)
    restored++
  }
}

// 语言白名单单独存放在 whitelist/ 子目录里，也要还原，
// 否则应用代码里仍留着 zh-CN，语言列表会出现一个指向不存在翻译的选项。
const wlDir = join(ROOT, 'whitelist')
if (existsSync(wlDir)) {
  console.log('')
  console.log('还原语言白名单...')
  const wl = patchWhitelist(RES, { revert: true, quiet: false })
  if (wl.log.length === 0) console.log('  – 没有可还原的白名单备份')
}

// 界面语言退回英文：还原的语义就是「回到英文界面」，
// 留着 locale=zh-CN 但中文文件已删，Claude 会找不到语言而回退得很别扭。
try {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, [join(PROJECT_ROOT, 'scripts', 'set-locale.mjs'), 'en-US'], {
    stdio: 'inherit',
    timeout: 30000,
  })
} catch {
  console.log('  – 界面语言未能自动退回，可手动运行：node scripts/set-locale.mjs en-US')
}

console.log()
if (restored === 0 && cleaned === 0) {
  console.log('没有需要改动的文件 —— 界面本来就不在中文状态。')
} else {
  console.log(`完成：删除中文语言文件 ${cleaned} 个，还原原文件 ${restored} 个。`)
}
console.log('请完全退出 Claude 再重新打开（托盘图标右键 → 退出）。')
