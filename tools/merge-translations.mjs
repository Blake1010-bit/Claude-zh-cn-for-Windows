/**
 * 合并翻译批次到 data/zh-CN-complete.json，并做严格校验。
 *
 * 为什么需要校验：Claude 用 ICU MessageFormat，译文写错不会当场报错，
 * 而是在**渲染那一刻**才炸，表现为整个页面崩掉。所以每条译文入包前必须验：
 *   1. 占位符集合必须与原文一致（{name} / {count, plural, ...}）
 *   2. <tag> 标签必须成对且同名
 *   3. 不能有空值
 *
 * 用法：
 *   node tools/merge-translations.mjs           校验并合并全部 _tr-batch-*.json
 *   node tools/merge-translations.mjs --check   只校验不写盘
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA = join(ROOT, 'data')
const CHECK_ONLY = process.argv.includes('--check')

/** 找出 Claude 当前版本的资源目录（复用 lib/paths.mjs 的探测）。 */
const { findResources } = await import('../lib/paths.mjs')
const found = findResources([])
if (!found) {
  console.error('✘ 找不到 Claude 资源目录')
  process.exit(1)
}
const EN = JSON.parse(readFileSync(join(found.dir, 'ion-dist', 'i18n', 'en-US.json'), 'utf8').replace(/^\uFEFF/, ''))

// 结构校验用 lib/icu-check.mjs 的 compareMessage：它会正确区分
// 「占位符 {name}」和「复数分支里的普通文本」。早先这里是用正则自己抓
// `{` 后面的单词当占位符，于是 `one {The person who asked…}` 被读成占位符
// {The}，报出一批假警报（43+ 条），真正的错误反而被淹没。
const { compareMessage } = await import('../lib/icu-check.mjs')

// 人工批次在前，自动翻译（translate-frags.mjs 产出的 _tr-rt-auto.json）在后，
// 后者优先级更高：同一条原文被自动翻译覆盖时以新译文为准。
const files = [
  ...readdirSync(DATA).filter((n) => /^_tr-batch-\d+\.json$/.test(n)).sort(),
  ...readdirSync(DATA).filter((n) => /^_tr-rt.*\.json$/.test(n)).sort(),
]
if (!files.length) {
  console.error('✘ data/ 下没有 _tr-batch-*.json 或 _tr-rt*.json')
  process.exit(1)
}

const merged = {}
const problems = []
let total = 0

for (const f of files) {
  let obj
  try {
    obj = JSON.parse(readFileSync(join(DATA, f), 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    problems.push(`${f}: JSON 解析失败 — ${e.message}`)
    continue
  }
  for (const [en, zh] of Object.entries(obj)) {
    total++
    if (typeof zh !== 'string' || !zh.trim()) {
      problems.push(`${f}: 空译文 — ${JSON.stringify(en).slice(0, 50)}`)
      continue
    }
    // 结构校验：占位符名、ICU 分支选择名、HTML 标签序列必须与原文一致
    const chk = compareMessage(en, zh)
    if (!chk.ok) {
      problems.push(`${f}: ${chk.reasons.join('; ')} — ${JSON.stringify(en).slice(0, 60)}`)
      continue
    }
    merged[en] = zh
  }
}

console.log(`=== 合并前校验 ===`)
console.log(`  批次文件 : ${files.length} 个`)
console.log(`  译文条目 : ${total}`)
console.log(`  问题     : ${problems.length}`)
for (const p of problems.slice(0, 40)) console.log(`    ✘ ${p}`)
if (problems.length > 40) console.log(`    … 另有 ${problems.length - 40} 条`)

if (problems.length) {
  console.log('\n有问题的条目不会被合并。修好后重跑。')
}
if (CHECK_ONLY) process.exit(problems.length ? 1 : 0)

// ---- 合并进主包 ----
const packPath = join(DATA, 'zh-CN-complete.json')
const pack = JSON.parse(readFileSync(packPath, 'utf8').replace(/^\uFEFF/, ''))
const before = Object.keys(pack).length

// 译文包是「键 → 中文」，键与 Claude 的 i18n 键一一对应。
// 批次里只有英文原文，所以这里要反查：英文原文 → 当前版本的所有键。
//
// 注意：同一段原文可能对应**多个键**（Claude 在不同组件里复用了同一句话，
// 但键是哈希所以各不相同）。早先只记第一个键，导致大量条目"跳过"——
// 其实那些键依然缺译文。这里改成一对多，全部填上。
const keysByEn = new Map()
for (const [k, v] of Object.entries(EN)) {
  if (typeof v !== 'string') continue
  if (!keysByEn.has(v)) keysByEn.set(v, [])
  keysByEn.get(v).push(k)
}

// 额外一轮：用**主包里已有的译文**按原文回填。
// 老包里有 28,872 条译文，其中不少原文在新版本里被换到了新键上 ——
// 直接用现成的中文填过去，不必重新翻译。
const existingZhByEn = new Map()
for (const [k, v] of Object.entries(pack)) {
  const src = EN[k]
  if (typeof src === 'string' && typeof v === 'string' && !existingZhByEn.has(src)) existingZhByEn.set(src, v)
}

let added = 0
let skipped = 0
let autoFilled = 0
let fixedFake = 0
const FORCE = process.argv.includes('--force')

// 先把批次里没覆盖、但主包已有同原文译文的键自动补上
for (const [src, zh] of existingZhByEn) {
  for (const k of keysByEn.get(src) ?? []) {
    if (!Object.prototype.hasOwnProperty.call(pack, k)) {
      pack[k] = zh
      autoFilled++
    }
  }
}

// 再合并人工/新翻译的批次（优先级更高，可覆盖自动回填）
//
// 重要：如果包里已有该键、但**译文等于英文原文**（假翻译），必须允许覆盖。
// 早先只判断"键是否存在"，导致假翻译永远修不掉 —— 实测踩过。
for (const [en, zh] of Object.entries(merged)) {
  const keys = keysByEn.get(en)
  if (!keys || !keys.length) {
    skipped++
    continue
  }
  for (const key of keys) {
    const exists = Object.prototype.hasOwnProperty.call(pack, key)
    const isFake = exists && pack[key] === en
    if (!exists || isFake || FORCE) {
      pack[key] = zh
      added++
      if (isFake) fixedFake++
    } else skipped++
  }
}

writeFileSync(packPath, JSON.stringify(pack, null, 2), 'utf8')
console.log(`\n=== 合并结果 ===`)
console.log(`  合并前键数      : ${before}`)
console.log(`  批次新增        : ${added}`)
console.log(`  按原文自动回填  : ${autoFilled}`)
console.log(`  跳过            : ${skipped}（原文在本版本找不到 / 已有译文）`)
console.log(`  合并后键数      : ${Object.keys(pack).length}`)
