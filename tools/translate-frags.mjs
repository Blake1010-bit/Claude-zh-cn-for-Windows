/**
 * 把 en-US.json 里还没翻译（或只是把英文原样抄了一遍）的条目补齐。
 *
 * 和 early 的 translate-missing.mjs 的区别：
 *   - 先把每条拆成「纯文本片段」和「结构」，片段单独送翻，
 *     结构（ICU 参数、复数分支、HTML 标签、`#`）原样拼回去。
 *     机器翻译不会破坏 ICU 语法，整条是复数块的条目也能翻。
 *   - 片段级缓存（data/_frag-cache.json），重跑不重复花钱/花额度。
 *   - 成品按条校验（lib/icu-check.mjs compareMessage），不合格的丢掉并记下来。
 *
 * 用法：
 *   node tools/translate-frags.mjs                      # 默认 mymemory
 *   node tools/translate-frags.mjs --limit 200          # 先试 200 条
 *   node tools/translate-frags.mjs --provider deepl
 *   node tools/translate-frags.mjs --dry                # 只统计不翻译
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA = join(ROOT, 'data')
const { parseNodes, renderNodes, textRuns, worthTranslating } = await import(
  pathToFileURL(join(ROOT, 'lib', 'icu-translate.mjs')).href
)
const { compareMessage } = await import(pathToFileURL(join(ROOT, 'lib', 'icu-check.mjs')).href)

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const PROVIDER = arg('provider', 'mymemory')
const LIMIT = parseInt(arg('limit', '0'), 10) || 0
const CONCURRENCY = parseInt(arg('concurrency', '6'), 10) || 6
const DRY = process.argv.includes('--dry')
/** 只做拼装（片段已由子代理/其他途径翻好放在缓存里）。 */
const ASSEMBLE_ONLY = process.argv.includes('--assemble')

const CACHE_PATH = join(DATA, '_frag-cache.json')
const OUT_PATH = join(DATA, '_tr-rt-auto.json')

const readJson = (p, def) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return def
  }
}
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2), 'utf8')

// ---------------------------------------------------------------------------
// 翻译服务
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PROVIDERS = {
  /** 免费、免注册，实测国内直连可用（Google 免费端点无代理时超时）。 */
  async mymemory(text) {
    if (text.length > 490) throw new Error('超过 MyMemory 490 字符上限')
    const url = `https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=${encodeURIComponent(text)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) })
    if (!res.ok) throw new Error(`MyMemory ${res.status}`)
    const j = await res.json()
    const st = String(j.responseStatus)
    if (st !== '200') throw new Error(`MyMemory ${st}: ${(j.responseDetails || '').slice(0, 60)}`)
    const out = j.responseData?.translatedText
    if (typeof out !== 'string' || !out.trim()) throw new Error('MyMemory 空结果')
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE/i.test(out))
      throw new Error(`MyMemory ${out.slice(0, 50)}`)
    return out
  },

  /** Google 免费端点，需要代理时可用。 */
  async google(text) {
    const key = process.env.GOOGLE_TRANSLATE_KEY
    if (!key) {
      const res = await fetch(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`,
        { signal: AbortSignal.timeout(20000) },
      )
      if (!res.ok) throw new Error(`Google ${res.status}`)
      const j = await res.json()
      return j[0].map((x) => x[0]).join('')
    }
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: [text], source: 'en', target: 'zh-CN', format: 'text' }),
    })
    if (!res.ok) throw new Error(`Google ${res.status}`)
    const j = await res.json()
    return j.data.translations[0].translatedText
  },

  /** DeepL，需要 DEEPL_KEY。 */
  async deepl(text) {
    const key = process.env.DEEPL_KEY
    if (!key) throw new Error('未设置 DEEPL_KEY')
    const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com'
    const res = await fetch(`https://${host}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: [text], source_lang: 'EN', target_lang: 'ZH' }),
    })
    if (!res.ok) throw new Error(`DeepL ${res.status}`)
    const j = await res.json()
    return j.translations[0].text
  },
}

if (!PROVIDERS[PROVIDER]) {
  console.error(`✘ 不支持的服务：${PROVIDER}（可用：${Object.keys(PROVIDERS).join(', ')}）`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 术语回填：机器翻译会把品牌/产品名音译，界面上必须保持原样
// ---------------------------------------------------------------------------
const TERMS = [
  [/克劳德|克勞德|克洛德/g, 'Claude'],
  [/基岩/g, 'Bedrock'],
  [/人体学|人类学|人择公司/g, 'Anthropic'],
  [/皮划艇|小艇/g, 'Canvas'],
  [/钩子程序|钩子/g, 'Hook'],
  [/工作树/g, 'Worktree'],
  [/工件|伪影|文物/g, 'Artifact'],
  [/技能包|技能库/g, 'Skill'],
  [/子代理|子智能体/g, 'subagent'],
  [/MCP服务器|MCP 服务器/g, 'MCP Server'],
  [/代币/g, 'token'],
  [/提示令牌|提示词/g, 'prompt'],
]
function fixTerms(s) {
  let out = s
  for (const [re, to] of TERMS) out = out.replace(re, to)
  // 中英之间补空格（「Claude 桌面版」而不是「Claude桌面版」）
  out = out.replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
  out = out.replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2')
  out = out.replace(/\s{2,}/g, ' ')
  return out
}

// ---------------------------------------------------------------------------
// 待翻清单
// ---------------------------------------------------------------------------
const { findResources } = await import(pathToFileURL(join(ROOT, 'lib', 'paths.mjs')).href)
const found = findResources([])
if (!found) {
  console.error('✘ 找不到 Claude 资源目录（Claude 是否已安装？）')
  process.exit(1)
}
const EN = readJson(join(found.dir, 'ion-dist', 'i18n', 'en-US.json'), {})
const ZH = readJson(join(DATA, 'zh-CN-complete.json'), {})

/** 完全没译 + 假翻译（值等于原文）。 */
const todo = []
for (const k of Object.keys(EN)) {
  const src = EN[k]
  if (typeof src !== 'string' || !src.trim()) continue
  if (ZH[k] === undefined || ZH[k] === src) todo.push({ key: k, en: src })
}
const work = LIMIT ? todo.slice(0, LIMIT) : todo

const fragCache = readJson(CACHE_PATH, {})
const results = readJson(OUT_PATH, {})
console.log('=== 待翻译 ===')
console.log(`  资源目录        : ${found.dir}`)
console.log(`  未译/假翻译条数 : ${todo.length}${LIMIT ? `（本次只做前 ${LIMIT} 条）` : ''}`)
console.log(`  服务            : ${PROVIDER}`)
console.log(`  片段缓存        : ${Object.keys(fragCache).length} 条`)

// 收集所有需要翻的片段（去重）
// 品牌名（Claude、Google Play…）原样保留，机器翻译会把它们音译成「克劳德」。
const BRAND = /^(Claude( Code| Pro| Max| Free| Desktop)?|Anthropic|Bedrock|Cowork|Artifact|Canvas|Google Play|Google Pay|Apple Pay|AWS KMS|Google Cloud KMS|Haiku|Sonnet|Opus|OpenDyslexic|Cowork|MCP|API|URL|JSON|CSV|PDF)$/i
const need = new Map() // 片段 -> 出现次数
for (const item of work) {
  for (const run of textRuns(item.en)) {
    if (!worthTranslating(run)) continue
    if (fragCache[run] !== undefined) continue
    if (BRAND.test(run.trim())) {
      fragCache[run] = run // 保持英文
      continue
    }
    need.set(run, (need.get(run) || 0) + 1)
  }
}
console.log(`  待翻片段（去重）: ${need.size}`)

if (DRY) {
  const sample = [...need.keys()].slice(0, 8)
  for (const s of sample) console.log('    ' + JSON.stringify(s).slice(0, 100))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 翻译片段
// ---------------------------------------------------------------------------
let ok = 0
let fail = 0
const failed = []
const fragList = [...need.keys()]
let cursor = 0

function flushCache() {
  try {
    writeJson(CACHE_PATH, fragCache)
  } catch (e) {
    console.error('  写缓存失败：' + e.message)
  }
}

async function translateFrag(text) {
  const lead = /^\s/.test(text) ? ' ' : ''
  const trail = /\s$/.test(text) ? ' ' : ''
  let lastErr = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await PROVIDERS[PROVIDER](text)
      if (typeof out === 'string' && out.trim()) {
        // 片段单独送翻会丢掉首尾空格，拼回去时中英文会粘在一起
        const body = fixTerms(out.trim())
        // 有英文词却没翻出中文（`to ` 原样返回、`removed` 变大写）说明这条
        // 片段太短机器翻译没处理，宁可让整条保持英文，也不要半中半英。
        if (/[A-Za-z]{2,}/.test(text) && !/[\u4e00-\u9fff]/.test(body)) {
          lastErr = '译文无中文'
          break
        }
        return lead + body + trail
      }
      lastErr = '空结果'
    } catch (e) {
      lastErr = e.message.slice(0, 80)
      if (/超过|上限/.test(lastErr)) break
    }
    await sleep(700 * (attempt + 1))
  }
  throw new Error(lastErr || '未知错误')
}

async function worker() {
  for (;;) {
    const i = cursor++
    if (i >= fragList.length) return
    const src = fragList[i]
    try {
      const zh = fixTerms(await translateFrag(src))
      fragCache[src] = zh
      ok++
    } catch (e) {
      fail++
      failed.push({ src, why: e.message.slice(0, 80) })
    }
    const done = ok + fail
    if (done % 100 === 0) {
      flushCache()
      console.log(`  片段进度 ${done}/${fragList.length}（成功 ${ok} / 失败 ${fail}）`)
    }
  }
}

const t0 = Date.now()
if (ASSEMBLE_ONLY) {
  console.log('  跳过翻译（--assemble），直接用现有片段缓存拼装')
} else {
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker))
  flushCache()
  console.log(`\n=== 片段翻译完成 ===`)
  console.log(`  成功: ${ok}  失败: ${fail}  耗时: ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  if (failed.length) {
    console.log('  失败样例（前 10）:')
    for (const f of failed.slice(0, 10)) console.log(`    ${JSON.stringify(f.src).slice(0, 60)} — ${f.why}`)
  }
}

// ---------------------------------------------------------------------------
// 拼装 + 校验
// ---------------------------------------------------------------------------
let built = 0
let rejected = 0
const rejectSamples = []
const allRejects = []
const missingFrag = new Set()

for (const item of work) {
  const nodes = parseNodes(item.en)
  const lookup = (run) => {
    if (!worthTranslating(run)) return run
    const zh = fragCache[run]
    if (zh === undefined) {
      missingFrag.add(run)
      return run
    }
    return zh
  }
  const out = renderNodes(nodes, lookup)
  const chk = compareMessage(item.en, out)
  if (!chk.ok) {
    rejected++
    const why = chk.reasons.join('; ')
    allRejects.push({ en: item.en, out, why })
    if (rejectSamples.length < 10) rejectSamples.push({ en: item.en, out, why })
    continue
  }
  // 拼完还是原样的英文（片段没翻出来）就别写进库里，避免污染覆盖率统计
  const hasWord = /[A-Za-z]{3,}/.test(item.en)
  if (hasWord && !/[\u4e00-\u9fff]/.test(out)) {
    rejected++
    allRejects.push({ en: item.en, out, why: '拼装后仍无中文' })
    if (rejectSamples.length < 10) rejectSamples.push({ en: item.en, out, why: '拼装后仍无中文' })
    continue
  }
  results[item.en] = out
  built++
}

writeJson(OUT_PATH, results)
writeJson(join(DATA, '_rejects.json'), allRejects)
writeJson(join(DATA, '_missing-frags.json'), [...missingFrag])
console.log(`\n=== 成品 ===`)
console.log(`  拼装成功: ${built}`)
console.log(`  校验拒绝: ${rejected}`)
if (missingFrag.size) console.log(`  缺片段  : ${missingFrag.size}（多为翻失败，重跑会补）`)
for (const s of rejectSamples) console.log(`    拒绝: ${JSON.stringify(s.en).slice(0, 70)}\n           -> ${s.why.slice(0, 90)}`)
console.log(`  已写入 ${OUT_PATH}（累计 ${Object.keys(results).length} 条）`)
console.log('  下一步：node tools/merge-translations.mjs')
