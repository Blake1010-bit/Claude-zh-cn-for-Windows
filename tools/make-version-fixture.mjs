/**
 * 造一个"别的 Claude 版本"的资源目录，用来测跨版本兼容。
 *
 * 做法：拿当前版本的 en-US.json，把每个键换成"假的、完全不同的哈希键"
 * （模拟新版本重新生成的键），英文原文保持不变。真实世界里 Claude 每次
 * 发版都会重新生成这些键，所以这正是"换版本"的本质。
 *
 * 用法：
 *   node tools/make-version-fixture.mjs <输出目录> [--keys=shift]
 *   --keys=shift   键名换成 fake-000001 这种（模拟全新键集）
 *   --keys=same    键名保持不变（对照组：应当 100% 命中）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const out = process.argv[2]
if (!out) {
  console.error('用法：node tools/make-version-fixture.mjs <输出目录> [--keys=shift|same]')
  process.exit(2)
}
const mode = (process.argv.find((a) => a.startsWith('--keys=')) || '--keys=shift').split('=')[1]

const { findResources } = await import(pathToFileURL(join(ROOT, 'lib', 'paths.mjs')).href)
const found = findResources([])
if (!found) {
  console.error('✘ 找不到 Claude 资源目录')
  process.exit(1)
}
const load = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const EN_FRONT = load(join(found.dir, 'ion-dist', 'i18n', 'en-US.json'))
const EN_SHELL = load(join(found.dir, 'en-US.json'))

const remap = (obj) => {
  if (mode === 'same') return obj
  const out = {}
  let i = 0
  for (const [k, v] of Object.entries(obj)) {
    i++
    out['k' + String(i).padStart(6, '0') + k.slice(-4)] = v
  }
  return out
}

const dirs = {
  i18n: join(out, 'ion-dist', 'i18n'),
  root: out,
}
if (existsSync(out)) {
  console.error(`✘ 目标已存在，先删掉：${out}`)
  process.exit(2)
}
mkdirSync(dirs.i18n, { recursive: true })
writeFileSync(join(dirs.i18n, 'en-US.json'), JSON.stringify(remap(EN_FRONT), null, 2), 'utf8')
writeFileSync(join(out, 'en-US.json'), JSON.stringify(remap(EN_SHELL), null, 2), 'utf8')
console.log(`已生成模拟版本资源目录（键名模式：${mode}）`)
console.log('  ' + dirs.i18n + '\\en-US.json  (' + Object.keys(EN_FRONT).length + ' 键)')
console.log('  ' + join(out, 'en-US.json') + '  (' + Object.keys(EN_SHELL).length + ' 键)')
