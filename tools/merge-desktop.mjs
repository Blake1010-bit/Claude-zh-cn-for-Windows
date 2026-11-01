/**
 * 把 data/zh-CN-desktop-extra.json 合并进桌面外壳译文包。
 *
 * 外壳包（zh-CN-desktop-complete.json）对应 resources/<locale>.json，
 * 菜单、对话框、崩溃提示都在这里。合并前用 lib/icu-check.mjs 做结构校验，
 * 占位符/复数分支对不上的一律不入包（否则运行时整块 UI 会崩）。
 *
 * 用法：node tools/merge-desktop.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA = join(ROOT, 'data')
const CHECK_ONLY = process.argv.includes('--check')
const { compareMessage } = await import(pathToFileURL(join(ROOT, 'lib', 'icu-check.mjs')).href)
const { findResources } = await import(pathToFileURL(join(ROOT, 'lib', 'paths.mjs')).href)

const load = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const found = findResources([])
if (!found) {
  console.error('✘ 找不到 Claude 资源目录')
  process.exit(1)
}
const EN = load(join(found.dir, 'en-US.json'))
const extra = load(join(DATA, 'zh-CN-desktop-extra.json'))
const pack = load(join(DATA, 'zh-CN-desktop-complete.json'))

let added = 0
let fixed = 0
const problems = []
const unknown = []

for (const [key, zh] of Object.entries(extra)) {
  const src = EN[key]
  if (typeof src !== 'string') {
    unknown.push(key)
    continue
  }
  const chk = compareMessage(src, zh)
  if (!chk.ok) {
    problems.push(`${key}: ${chk.reasons.join('; ')} — ${JSON.stringify(src).slice(0, 50)}`)
    continue
  }
  const had = Object.prototype.hasOwnProperty.call(pack, key)
  const isFake = had && pack[key] === src
  if (!had) added++
  else if (isFake) fixed++
  pack[key] = zh
}

console.log('=== 桌面外壳合并 ===')
console.log(`  待合并条目 : ${Object.keys(extra).length}`)
console.log(`  新增       : ${added}`)
console.log(`  修假翻译   : ${fixed}`)
if (unknown.length) console.log(`  本版本无此 key: ${unknown.length}（${unknown.slice(0, 5).join(', ')}）`)
console.log(`  校验失败   : ${problems.length}`)
for (const p of problems.slice(0, 20)) console.log(`    ✘ ${p}`)

if (CHECK_ONLY) process.exit(problems.length ? 1 : 0)
if (!problems.length || problems.length < Object.keys(extra).length) {
  writeFileSync(join(DATA, 'zh-CN-desktop-complete.json'), JSON.stringify(pack, null, 2), 'utf8')
  console.log(`  已写入，包内 key 数 ${Object.keys(pack).length}`)
}
