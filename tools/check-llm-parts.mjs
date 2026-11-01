/**
 * 校验子代理产出的片段译文文件。
 *
 * 用法：node tools/check-llm-parts.mjs out-01.json out-07.json …
 * 检查：合法 JSON、条目数与输入一致、id 对齐、值非空字符串。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIR = join(ROOT, 'data', '_llm')
const load = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))

const names = process.argv.slice(2)
if (!names.length) {
  console.error('用法：node tools/check-llm-parts.mjs out-01.json …')
  process.exit(2)
}

let bad = 0
for (const name of names) {
  const base = name.replace(/^out-/, '')
  const inPath = join(DIR, 'in-' + base)
  const outPath = join(DIR, 'out-' + base)
  try {
    if (!existsSync(outPath)) throw new Error('输出文件不存在')
    const src = load(inPath)
    const dst = load(outPath)
    if (Array.isArray(dst)) throw new Error('输出应是对象（id→译文），不是数组')
    const missing = src.filter((e) => typeof dst[String(e.id)] !== 'string' || !dst[String(e.id)].trim())
    const extra = Object.keys(dst).filter((k) => !src.some((e) => String(e.id) === k))
    const lines = [`${name}: ${Object.keys(dst).length}/${src.length} 条`]
    if (missing.length) lines.push(`  缺 ${missing.length} 条：id ${missing.slice(0, 8).map((e) => e.id).join(',')}`)
    if (extra.length) lines.push(`  多 ${extra.length} 个未知 id：${extra.slice(0, 8).join(',')}`)
    if (missing.length || extra.length) {
      bad++
      console.log(lines.join('\n'))
    } else {
      console.log(lines[0] + ' OK')
    }
  } catch (e) {
    bad++
    console.log(`${name}: ✘ ${e.message}`)
  }
}
if (bad) {
  console.log(`\n共 ${bad} 个文件有问题`)
  process.exit(1)
}
console.log('\n全部通过 OK')
