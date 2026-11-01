/**
 * 检查译文包的质量问题，并导出需要重译的条目。
 *
 * 背景（这是实测发现的真实问题）
 * ------------------------------
 * 早先的译文包混进了 1,799 条「译文 === 英文原文」的条目。
 * 它们被算作"已翻译"，于是覆盖率统计虚高；而界面上那一条依然是英文，
 * 用户看到的就是"没翻干净"。
 *
 * 其中有一部分是**应该保留英文**的（品牌名、产品名、代码/路径，
 * 如 Google Play、OpenDyslexic、~/Documents/work），
 * 另一部分才是真正漏译的（如 "Stop this task"、"Visualize anything"）。
 *
 * 本脚本把两类分开：
 *   * 保留英文：写进 keep 列表，不报错
 *   * 需要重译：导出到 data/_retranslate.json
 *
 * 用法：node tools/audit-translations.mjs [--json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const JSONONLY = process.argv.includes('--json')

const { findResources } = await import('../lib/paths.mjs')
const found = findResources([])
if (!found) {
  console.error('✘ 找不到 Claude 资源目录')
  process.exit(1)
}
const EN = JSON.parse(readFileSync(join(found.dir, 'ion-dist', 'i18n', 'en-US.json'), 'utf8').replace(/^\uFEFF/, ''))
const ZH = JSON.parse(readFileSync(join(ROOT, 'data', 'zh-CN-complete.json'), 'utf8').replace(/^\uFEFF/, ''))

/**
 * 这些名字/格式**应当保持英文**，翻译反而错。
 * 判断依据：知名品牌、产品名、技术标识符、纯路径、纯占位符。
 */
const KEEP_EN = [
  /^Google Play$/i,
  /^Google Cloud KMS$/i,
  /^OpenDyslexic$/i,
  /^Anthropic/,
  /^Claude$/,
  /^Claude Code$/,
  /^Claude for Excel$/,
  /^Claude Security/,
  /^Haiku$/,
  /^Sonnet/,
  /^Opus/,
  /^GitHub/,
  /^X-[A-Za-z-]+$/, // HTTP 头名
  /^[\w./~-]+$/, // 单个标识符/路径，如 Python、CI、~/Documents/work
  /^[^a-zA-Z]*$/, // 无英文字母（纯符号/数字）
  /^\{[^}]*\}$/, // 纯占位符
  /^[\d\s{}%.,:;()\-–/]+$/, // 数字与符号组合
]

const isKeep = (s) => KEEP_EN.some((re) => re.test(s))

const real = []
const fakeNeedTranslate = []
const fakeKeep = []
const noCjk = []
let missing = 0

for (const k of Object.keys(EN)) {
  if (!Object.prototype.hasOwnProperty.call(ZH, k)) {
    missing++
    continue
  }
  const src = EN[k]
  const v = ZH[k]
  if (typeof src !== 'string' || typeof v !== 'string') continue
  if (v === src) {
    if (isKeep(src)) fakeKeep.push({ key: k, en: src })
    else fakeNeedTranslate.push({ key: k, en: src })
  } else if (!/[\u4e00-\u9fff]/.test(v) && /\{/.test(src)) {
    // 只带格式转换（如半角括号→全角），不算真翻译，但优先级低
    noCjk.push({ key: k, en: src, zh: v })
  } else if (!/[\u4e00-\u9fff]/.test(v)) {
    noCjk.push({ key: k, en: src, zh: v })
  } else real.push(k)
}

const total = Object.keys(EN).length
// 只统计当前版本里的键：译文包里还留着旧版本的键（新版本删掉的文案），
// 早先直接用 Object.keys(ZH).length 相减，出现过 -2783 这种负数。
const untranslated = missing

if (!JSONONLY) {
  console.log('=== 译文质量审计 ===')
  console.log(`  当前版本键数          : ${total}`)
  console.log(`  有真实中文            : ${real.length}  (${((real.length / total) * 100).toFixed(2)}%)`)
  console.log(`  假翻译·该保留英文     : ${fakeKeep.length}`)
  console.log(`  假翻译·真漏译（要修） : ${fakeNeedTranslate.length}`)
  console.log(`  无中文（多为格式转换）: ${noCjk.length}`)
  console.log(`  完全未译              : ${untranslated}`)
  console.log('')
  console.log('  假翻译·该保留英文 样例：')
  for (const x of fakeKeep.slice(0, 8)) console.log(`    ${JSON.stringify(x.en).slice(0, 50)}`)
  console.log('  假翻译·真漏译 样例：')
  for (const x of fakeNeedTranslate.slice(0, 12)) console.log(`    ${JSON.stringify(x.en).slice(0, 60)}`)
}

writeFileSync(join(ROOT, 'data', '_retranslate.json'), JSON.stringify(fakeNeedTranslate, null, 2), 'utf8')
writeFileSync(join(ROOT, 'data', '_keep-english.json'), JSON.stringify(fakeKeep, null, 2), 'utf8')
if (!JSONONLY) {
  console.log(`\n  已导出：data/_retranslate.json（${fakeNeedTranslate.length}）/ data/_keep-english.json（${fakeKeep.length}）`)
}
