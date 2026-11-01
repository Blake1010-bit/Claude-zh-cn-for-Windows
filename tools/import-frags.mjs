/**
 * 把子代理产出的 out-XX.json 合并进片段缓存 data/_frag-cache.json。
 *
 * 键用「原文片段」，所以 LLM 的译文会覆盖掉之前机器翻译留下的条目。
 * 只接受非空、且与原文不同的结果；纯英文结果（品牌名/标识符）也保留，
 * 拼装阶段不会因此报错。
 *
 * 用法：node tools/import-frags.mjs
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIR = join(ROOT, 'data', '_llm')
const CACHE_PATH = join(ROOT, 'data', '_frag-cache.json')

const load = (p, def) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return def
  }
}

const cache = load(CACHE_PATH, {})
const outs = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^out-\d+\.json$/.test(f)).sort() : []
if (!outs.length) {
  console.error('✘ data/_llm 下没有 out-*.json')
  process.exit(1)
}

let added = 0
let overridden = 0
let sameAsSource = 0
const problems = []

for (const outName of outs) {
  const inName = outName.replace(/^out-/, 'in-')
  const src = load(join(DIR, inName), null)
  const dst = load(join(DIR, outName), null)
  if (!src || !dst) {
    problems.push(`${outName}: 读不出来`)
    continue
  }
  for (const e of src) {
    const zh = dst[String(e.id)]
    if (typeof zh !== 'string' || !zh.trim()) continue
    const had = cache[e.text]
    if (had === undefined) added++
    else if (had !== zh) overridden++
    if (!/[\u4e00-\u9fff]/.test(zh) && /[A-Za-z]{3,}/.test(e.text)) sameAsSource++
    cache[e.text] = zh
  }
}

writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8')
console.log(`合并 ${outs.length} 个文件`)
console.log(`  新增 ${added} 条，覆盖 ${overridden} 条`)
console.log(`  仍是英文的片段 ${sameAsSource} 条（品牌名/标识符/未译）`)
if (problems.length) console.log('  问题：' + problems.join('; '))
console.log(`  缓存总数 ${Object.keys(cache).length}`)
