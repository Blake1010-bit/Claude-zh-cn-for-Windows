/**
 * 把还没翻的片段导成若干小 JSON，交给子代理（LLM）逐条翻译。
 *
 * 每个片段配一条上下文（它所在的那句英文），避免「to 」「file」这种
 * 单词片段脱离语境被翻错。
 *
 * 用法：node tools/export-frags.mjs [每片条数]
 * 产出：data/_llm/in-01.json …，以及 data/_llm/manifest.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA = join(ROOT, 'data')
const OUT = join(DATA, '_llm')
const { textRuns, worthTranslating } = await import(pathToFileURL(join(ROOT, 'lib', 'icu-translate.mjs')).href)

const CHUNK = parseInt(process.argv[2] || '120', 10) || 120
const readJson = (p, def) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return def
  }
}

const { findResources } = await import(pathToFileURL(join(ROOT, 'lib', 'paths.mjs')).href)
const found = findResources([])
if (!found) {
  console.error('✘ 找不到 Claude 资源目录')
  process.exit(1)
}
const EN = readJson(join(found.dir, 'ion-dist', 'i18n', 'en-US.json'), {})
const ZH = readJson(join(DATA, 'zh-CN-complete.json'), {})
const cache = readJson(join(DATA, '_frag-cache.json'), {})

const BRAND = /^(Claude( Code| Pro| Max| Free| Desktop)?|Anthropic|Bedrock|Cowork|Artifact|Canvas|Google Play|Google Pay|Apple Pay|AWS KMS|Google Cloud KMS|Haiku|Sonnet|Opus|OpenDyslexic|MCP|API|URL|JSON|CSV|PDF)$/i

const todo = []
for (const k of Object.keys(EN)) {
  const src = EN[k]
  if (typeof src !== 'string' || !src.trim()) continue
  if (ZH[k] === undefined || ZH[k] === src) todo.push(src)
}

/** 片段 -> 第一次出现的整句（作为上下文） */
const need = new Map()
for (const en of todo) {
  for (const run of textRuns(en)) {
    if (!worthTranslating(run)) continue
    if (cache[run] !== undefined) continue
    if (BRAND.test(run.trim())) continue
    if (!need.has(run)) need.set(run, en.length > 220 ? en.slice(0, 220) + '…' : en)
  }
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const list = [...need.entries()]
const files = []
let idx = 0
for (let i = 0; i < list.length; i += CHUNK) {
  idx++
  const part = list.slice(i, i + CHUNK).map(([text, ctx], n) => ({ id: n + 1, text, ctx }))
  const name = `in-${String(idx).padStart(2, '0')}.json`
  writeFileSync(join(OUT, name), JSON.stringify(part, null, 2), 'utf8')
  files.push({ file: name, count: part.length, start: i })
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ total: list.length, chunk: CHUNK, files }, null, 2), 'utf8')

console.log(`导出片段 ${list.length} 条，分成 ${files.length} 个文件（每个 ${CHUNK} 条）`)
console.log('目录：' + OUT)
