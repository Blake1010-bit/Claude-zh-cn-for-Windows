/**
 * 生成「英文原文 → 中文」字典 data/zh-CN-by-text.json。
 *
 * 为什么需要它
 * ------------
 * Claude 每次发版都会重新生成 i18n 的键（键是不透明的哈希，像 `++aHcm3XP/`），
 * 而界面文案本身变化很小。install.mjs 原来是按键合并的，于是：
 *   - 同一版本：100% 命中；
 *   - 换一个版本：键全变了 → **命中 0%**，界面整片回退英文。
 *     （实测：把键名换成等价的假哈希后，装完中文覆盖率 0.00%）
 * 所以除了「键 → 中文」，还要带一份「原文 → 中文」，安装时按原文回填。
 *
 * 数据来源（优先级从高到低）：
 *   1. 当前版本 en-US.json + 主包 zh-CN-complete.json（键对得上，最可靠）
 *   2. data/_tr-rt-auto.json（自动翻译产出的 原文→译文）
 *   3. data/_tr-batch-*.json（人工批次，原文→译文）
 * 每条都过 compareMessage 结构校验，坏的不进字典。
 *
 * 用法：node tools/build-by-text.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA = join(ROOT, 'data')
const { compareMessage } = await import(pathToFileURL(join(ROOT, 'lib', 'icu-check.mjs')).href)
const { findResources } = await import(pathToFileURL(join(ROOT, 'lib', 'paths.mjs')).href)

const load = (p, d = null) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return d
  }
}

const dict = {}
let skipped = 0
const add = (en, zh, from) => {
  if (typeof en !== 'string' || typeof zh !== 'string') return
  if (!en.trim() || !zh.trim()) return
  if (dict[en] !== undefined) return
  if (!/[A-Za-z]/.test(en)) return // 纯符号/纯数字不需要
  const chk = compareMessage(en, zh)
  if (!chk.ok) {
    skipped++
    return
  }
  dict[en] = zh
  void from
}

// 1) 当前版本：键对齐，最可靠
const found = findResources([])
if (!found) {
  console.error('✘ 找不到 Claude 资源目录（需要先装 Claude，才能按当前版本生成）')
  process.exit(1)
}
const EN = load(join(found.dir, 'ion-dist', 'i18n', 'en-US.json'), {})
const ZH = load(join(DATA, 'zh-CN-complete.json'), {})
for (const [k, en] of Object.entries(EN)) {
  const zh = ZH[k]
  if (typeof zh === 'string') add(en, zh, 'pack')
}
const EN_S = load(join(found.dir, 'en-US.json'), {})
const ZH_S = load(join(DATA, 'zh-CN-desktop-complete.json'), {})
for (const [k, en] of Object.entries(EN_S)) {
  const zh = ZH_S[k]
  if (typeof zh === 'string') add(en, zh, 'shell')
}

// 2) 自动翻译产出
const auto = load(join(DATA, '_tr-rt-auto.json'), {})
for (const [en, zh] of Object.entries(auto)) add(en, zh, 'auto')

// 3) 人工批次
for (const f of readdirSync(DATA).filter((n) => /^_tr-batch-\d+\.json$/.test(n)).sort()) {
  const obj = load(join(DATA, f), {})
  for (const [en, zh] of Object.entries(obj)) add(en, zh, f)
}
for (const f of readdirSync(DATA).filter((n) => /^_tr-rt-\d+\.json$/.test(n)).sort()) {
  const obj = load(join(DATA, f), {})
  for (const [en, zh] of Object.entries(obj)) add(en, zh, f)
}

const out = join(DATA, 'zh-CN-by-text.json')
writeFileSync(out, JSON.stringify(dict, null, 0), 'utf8')
const withCjk = Object.values(dict).filter((v) => /[\u4e00-\u9fff]/.test(v)).length
console.log('=== 原文→译文 字典 ===')
console.log(`  条目数      : ${Object.keys(dict).length}`)
console.log(`  其中含中文  : ${withCjk}`)
console.log(`  结构校验拒绝: ${skipped}`)
console.log(`  已写入      : ${out}（${(readFileSync(out).length / 1024 / 1024).toFixed(2)} MB）`)
