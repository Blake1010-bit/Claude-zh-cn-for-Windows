#!/usr/bin/env node
/**
 * 一键安装简体中文界面。
 *
 * 适用范围（重要）
 * ----------------
 * **只适用于第三方登录状态。** 也就是用第三方 API 模式
 * （例如 CC Switch 路由到第三方模型）的 Claude Desktop。
 *
 * **官方账号登录模式本项目从未开发**，开发只进行到第三方登录为止。
 * 原因是那种模式下界面渲染的是远程 https://claude.ai 网页，本地语言文件
 * 对它无效；要支持就得改 app.asar 并改写 Claude.exe 里内嵌的完整性哈希，
 * 会让签名变成 HashMismatch、可能影响 Cowork。本项目选择不做这些事，
 * 因此也不碰 app.asar / Claude.exe。详见 README 对应章节。
 *
 * 设计要点（都是踩过坑之后定下来的）：
 *  1. 自动定位 Claude 安装目录，不需要用户手填路径。
 *  2. 只把「当前 Claude 版本里有、但中文包还没有」的条目补进去，
 *     不覆盖应用自带的既有译文，也不写入当前版本已不存在的旧键。
 *  3. 覆盖前先备份，备份目录名不使用结尾的点号（Windows 会吃掉这种名字）。
 *  4. 每一条新译文都先做结构化校验，坏的不写入。
 *  5. 幂等：已经装过再跑一次不会重复破坏现场。
 *  6. 全过程有进度条和步骤编号，让用户看得见在做什么、走到哪一步。
 *
 * 用法：
 *   node scripts/install.mjs            正常安装
 *   node scripts/install.mjs --dry-run  只检查不写入
 *   node scripts/install.mjs --resources "<路径>"  手动指定资源目录
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROJECT_ROOT,
  FRONTEND_I18N,
  findResources,
  diagnoseNotFound,
  readJson,
  sizeOf,
} from '../lib/paths.mjs'
import { compareMessage } from '../lib/icu-check.mjs'
import { readPack, packFile } from '../lib/packio.mjs'
import { patchWhitelist } from './patch-whitelist.mjs'

const argv = process.argv.slice(2)
const DRY = argv.includes('check') || argv.includes('--check') || argv.includes('--dry-run')
const QUIET = argv.includes('--quiet')

const say = (s = '') => {
  if (!QUIET) console.log(s)
}

// ---------------------------------------------------------------------------
// 进度显示
// ---------------------------------------------------------------------------
const BAR_WIDTH = 26
let lastLen = 0
let lastPct = -1

/**
 * 进度条只在真实终端里画。
 * 输出被重定向到文件或管道时（例如自动化测试）\r 不会回到行首，
 * 会把内容刷成成千上万行，所以这时干脆不画。
 *
 * 想强制看到进度条（例如录屏、调试）可以加 --progress。
 */
const showBar = !QUIET && (process.stdout.isTTY === true || argv.includes('--progress'))

/** 在同一行重画进度条（带节流，百分比没变就不重画）。 */
const bar = (label, done, total) => {
  if (!showBar) return
  const ratio = total === 0 ? 1 : done / total
  const pct = Math.round(ratio * 100)
  if (pct === lastPct && done !== total) return
  lastPct = pct

  const filled = Math.round(BAR_WIDTH * ratio)
  const line = `   ${label.padEnd(12)} ${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)} ${String(
    pct,
  ).padStart(3)}%  ${done}/${total}`
  process.stdout.write('\r' + line + (line.length < lastLen ? ' '.repeat(lastLen - line.length) : ''))
  lastLen = line.length
}

const barEnd = () => {
  if (!showBar) return
  process.stdout.write('\n')
  lastLen = 0
  lastPct = -1
}

let stepNo = 0
const step = (title) => {
  stepNo++
  say(`\n[${stepNo}/5] ${title}`)
}
const tick = (msg) => say(`   ${msg}`)

// ===========================================================================
// 1. 定位 Claude
// ===========================================================================
step('定位 Claude Desktop')
const found = findResources(argv)
if (found === null) {
  say('   ✘ 没有找到')
  console.log()
  console.error(diagnoseNotFound())
  process.exit(1)
}
const RES = found.dir
tick(`✔ 找到（${found.source}）`)
tick(RES)

// ===========================================================================
// 2. 检查随包数据
// ===========================================================================
step('检查随包语言数据')
const DATA = join(PROJECT_ROOT, 'data')

// 「英文原文 → 中文」字典：跨版本兼容的关键。
//
// Claude 每次发版都会重新生成 i18n 的键（不透明哈希），而文案本身很稳定。
// 只按键合并的话，换一个版本命中率就是 0（实测把键换成等价的假哈希后，
// 装完中文覆盖率 0.00%）。所以包里另带一份按原文索引的字典，安装时
// 对「这次没匹配上、还是英文」的条目按原文回填。
const byText = readPack(join(DATA, 'zh-CN-by-text.json')) ?? {}
if (!Object.keys(byText).length) {
  say('   ! 缺少 data/zh-CN-by-text.json，只能做同版本安装（换版本会大面积回退英文）')
}

const packs = [
  {
    label: '前端界面',
    file: join(DATA, 'zh-CN-complete.json'),
    target: join(RES, FRONTEND_I18N, 'zh-CN.json'),
    // 目标不存在时（例如刚重装完 Claude）用它当骨架
    enFile: join(RES, FRONTEND_I18N, 'en-US.json'),
  },
  {
    label: '桌面外壳',
    file: join(DATA, 'zh-CN-desktop-complete.json'),
    target: join(RES, 'zh-CN.json'),
    enFile: join(RES, 'en-US.json'),
  },
]

for (const p of packs) {
  if (!packFile(p.file)) {
    say(`   ✘ 缺少数据文件：${p.file}`)
    say('   请确认下载的项目是完整的（data/ 目录不能少）。')
    process.exit(1)
  }
  tick(`✔ ${p.label} 数据就绪（${(sizeOf(packFile(p.file)) / 1024).toFixed(0)} KB）`)
}

// 逐个目标算清楚要补哪些键。
//
// 关键点：不能因为目标文件不存在就跳过。
// Claude 重装后会把 zh-CN.json 整个删掉，而此时 config.json 里的 locale
// 仍然是 zh-CN —— 界面找不到语言文件就渲染不出来。所以目标缺失时，
// 必须以英文文件为骨架生成一份完整的中文文件。
for (const p of packs) {
  const pack = readPack(p.file)
  const targetExists = existsSync(p.target)

  // 骨架三件套，顺序很重要：
  //   1. 当前版本的英文文件（决定"这个版本有哪些键"，缺了它界面就会漏字）
  //   2. 已有的中文文件（保留上次的译文和旧版本遗留键）
  //   3. 中文包（覆盖前两者）
  //
  // 早先的写法是「目标存在就用目标，不存在才用英文文件」，结果遇到
  // 「中文文件被清成 {}」这种现场时，骨架里一条当前版本的键都没有，
  // 装完界面还是英文（覆盖率 0.00%，tests/test-cross-version.mjs 用例 3）。
  // 现在无条件以英文文件打底。
  const enBase = existsSync(p.enFile) ? readJson(p.enFile) : {}
  const cur = targetExists ? readJson(p.target) : {}
  if (!Object.keys(enBase).length && !Object.keys(cur).length) {
    say(`   ✘ 既没有 ${p.target} 也没有 ${p.enFile}，无法处理 ${p.label}`)
    process.exit(1)
  }
  const base = { ...enBase, ...cur }
  p.creating = !targetExists

  // 要写入的内容 = 骨架 ∪ 中文包（中文包优先，覆盖英文）
  const merged = { ...base }
  for (const [k, v] of Object.entries(pack)) {
    // 新建文件时只需要覆盖当前版本里存在的键；
    // 目标已存在时把旧键一并保留，方便以后降级回旧版本。
    if (targetExists || Object.prototype.hasOwnProperty.call(base, k)) merged[k] = v
  }

  // 跨版本回填：没命中中文包、但原文在字典里的条目，按原文补上中文。
  let textFilled = 0
  for (const [k, v] of Object.entries(merged)) {
    if (typeof v !== 'string') continue
    if (Object.prototype.hasOwnProperty.call(pack, k)) continue // 包里已有这条
    if (/[\u4e00-\u9fff]/.test(v)) continue // 已经是中文（上次装过）
    const zh = byText[v]
    if (typeof zh === 'string' && zh !== v && compareMessage(v, zh).ok) {
      merged[k] = zh
      textFilled++
    }
  }

  // 需要报告的"新增/更新"条目数
  const toAdd = {}
  for (const [k, v] of Object.entries(merged)) {
    if (base[k] !== v) toAdd[k] = v
  }

  p.base = base
  p.merged = merged
  p.toAdd = toAdd
  p.total = Object.keys(toAdd).length
  p.textFilled = textFilled
}

const grandTotal = packs.reduce((n, p) => n + p.total, 0)

// ===========================================================================
// 3. 注册语言白名单
//
// 这一步不可省：Claude 前端有一份硬编码的“支持语言”数组，
// 语言代码不在里面就会被丢弃、回退英文 —— 语言文件存在也没用。
// 官方没有简体中文，所以必须把 zh-CN 补进这个数组。
// ===========================================================================
step('注册简体中文到语言白名单')

const wl = patchWhitelist(RES, { check: DRY, quiet: true })
for (const line of wl.log) say(`   ${line}`)

if (wl.failed > 0) {
  say('')
  say('   ✘ 语言白名单处理失败')
  say('   这一步失败时界面不会变成中文（会回退英文）。')
  say('   请到项目 Issues 反馈，或改用管理员身份运行。')
  process.exit(1)
}
if (wl.patched > 0) {
  tick(`✔ 已在 ${wl.patched} 个文件里补上 zh-CN`)
} else if (wl.already > 0) {
  tick(`✔ 白名单已包含 zh-CN，无需改动`)
} else if (DRY) {
  tick(`! 需要补 zh-CN（空跑模式未修改）`)
}

// 静默检查模式（.bat 用它决定是否需要提权）：有东西要改就返回 2
if (DRY && QUIET) {
  const needsWhitelist = wl.patched === 0 && wl.already === 0
  const needsLang = packs.some((p) => p.total > 0)
  if (needsWhitelist || needsLang) process.exit(2)
}

// ===========================================================================
// 4. 校验 + 写入语言文件
// ===========================================================================
step(DRY ? '校验语言文件（空跑模式，不会写入）' : '校验并写入语言文件')
say(`   需要补充 ${grandTotal} 条${DRY ? '（本模式只校验，不落盘）' : ''}`)

let checked = 0
let written = 0

for (const p of packs) {
  if (p.total === 0) {
    tick(`✔ ${p.label}：已经是最新，无需改动`)
    continue
  }

  // 逐条结构校验（最耗时的一步，进度条用在这里）。
  // 以英文原文为基准比对；英文文件也可能缺某些键，那就跳过校验。
  let bad = 0
  for (const [k, v] of Object.entries(p.toAdd)) {
    const en = p.base[k]
    if (typeof en === 'string' && !compareMessage(en, v).ok) bad++
    checked++
    if (checked % 100 === 0 || checked === grandTotal) bar('校验译文', checked, grandTotal)
  }
  bar('校验译文', checked, grandTotal)
  barEnd()

  if (bad > 0) {
    say(`   ✘ ${p.label}：有 ${bad} 条译文结构校验不通过`)
    say('   为避免弄坏界面，本次不写入任何文件。请到项目 Issues 反馈。')
    process.exit(1)
  }
  tick(`✔ ${p.label}：${p.total} 条通过校验`)
  if (p.textFilled > 0) tick(`✔ ${p.label}：其中 ${p.textFilled} 条按原文补齐（跨版本）`)

  if (DRY) continue

  // 备份原文件（目标不存在时没有可备份的东西，这正是重装后的情况）。
  // 注意：这里刻意不用 copyFileSync —— 从 WindowsApps 这种受保护目录
  // 直接 copyFile 会抛 UNKNOWN(-4094)，但读入内存再写出是可靠的。
  if (existsSync(p.target)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const backupDir = join(RES, '.zh-cn-toolkit-backup', stamp)
    mkdirSync(backupDir, { recursive: true })
    const backupFile = join(backupDir, `${p.label}-${p.target.split(/[\\/]/).pop()}`)
    writeFileSync(backupFile, readFileSync(p.target))
    tick(`✔ ${p.label}：原文件已备份`)
  } else {
    tick(`✔ ${p.label}：原本没有这个文件，将新建`)
  }

  // 写入合并结果
  mkdirSync(join(p.target, '..'), { recursive: true })
  writeFileSync(p.target, JSON.stringify(p.merged, null, 2), 'utf8')
  written += Object.keys(p.toAdd).length
  tick(`✔ ${p.label}：已写入 ${(sizeOf(p.target) / 1024).toFixed(0)} KB`)
}

// ===========================================================================
// 4. 收尾
// ===========================================================================
step('完成')
say('   ' + '─'.repeat(56))
if (DRY) {
  say('   空跑结束：以上是将会执行的内容，未改动任何文件。')
  say('   去掉 check 参数就会真正安装。')
} else if (written === 0) {
  say('   无需改动，你的 Claude 已经是最新中文界面。')
} else {
  say(`   已补充 ${written} 条中文。`)
  say('')
  say('   请完全退出 Claude 再重新打开：')
  say('     右下角托盘图标（时钟旁边）→ 右键 → 退出 → 再启动')
  say('     只关窗口不够，Claude 会留在托盘里继续跑。')
  say('')
  say('   如需还原，双击「一键还原.bat」')
}
say('   ' + '─'.repeat(56))

// 用退出码告诉 .bat 实际结果，避免它误报"完成"：
//   0 = 真的改了东西（或已是最新）
//   4 = 只是空跑检查，什么都没做
if (DRY) process.exit(4)
