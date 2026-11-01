#!/usr/bin/env node
/**
 * 批量翻译待译条目（英文 → 简体中文）。
 *
 * 支持多家服务。API key 只从**环境变量**读，不接受命令行明文，
 * 也不会写进任何文件或日志。
 *
 *   DeepL      DEEPL_AUTH_KEY            （免费版自动用 api-free）
 *   腾讯云      TENCENT_SECRET_ID + TENCENT_SECRET_KEY
 *   阿里云      ALIYUN_ACCESS_KEY_ID + ALIYUN_ACCESS_KEY_SECRET
 *   火山引擎    VOLC_ACCESSKEY + VOLC_SECRETKEY
 *   谷歌(非官方) GOOGLE_TRANSLATE_KEY     （translate.googleapis.com，仅供自用测试）
 *
 * 核心设计：占位符保护
 * --------------------
 * 待译文本里混着 ICU 占位符（{count, plural, ...}）和 HTML 标签（<link>）。
 * 直接丢给翻译 API 会把它们翻坏或改写成全角括号，导致界面崩溃。
 * 这里先把它们替换成 `⟦0⟧`、`⟦1⟧` 这种不会变的标记，翻完再原样换回；
 * 还原时若标记数量对不上，直接判为失败、该条不采用。
 *
 * 用法：
 *   node tools/translate-missing.mjs --provider deepl
 *   node tools/translate-missing.mjs --provider deepl --dry     # 只翻 5 条看看效果
 *   node tools/translate-missing.mjs --provider tencent --limit 500
 *
 * 输出：data/_tr-rt-*.json（与 merge-translations.mjs 的批次格式一致）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, createHmac } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA = join(ROOT, 'data')

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const PROVIDER = arg('provider', 'deepl')
const LIMIT = parseInt(arg('limit', '0'), 10) || 0
const DRY = process.argv.includes('--dry')
const CONCURRENCY = parseInt(arg('concurrency', '4'), 10) || 4

// ---------------------------------------------------------------------------
// 占位符保护
// ---------------------------------------------------------------------------
/**
 * 占位符标记。用 [[n]] 是因为实测 MyMemory 会吃掉 ⟦⟧ 里的字符，
 * 把 "Delete ⟦0⟧ permanently?" 翻成 "⟧ 永久删除⟦0 ？"，导致还原失败。
 * [[0]] / %0% / {0} 都能原样保留，选 [[0]] 最短且不易被拆分。
 */
const M_OPEN = '[['
const M_CLOSE = ']]'

/** 抽出所有需要保护的片段：ICU 花括号表达式 + HTML 标签。 */
function protect(src) {
  const slots = []
  // 源文自带 [[ ]] 时会与标记撞车，交给调用方判失败，不做有损处理
  const conflict = src.includes(M_OPEN) || src.includes(M_CLOSE)
  // 先匹配嵌套的 ICU 表达式（{...} 可能内含 {..}），再匹配 HTML 标签
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src[i] === '{') {
      let depth = 0
      let j = i
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') {
          depth--
          if (depth === 0) {
            j++
            break
          }
        }
      }
      if (depth === 0) {
        slots.push(src.slice(i, j))
        out += `${M_OPEN}${slots.length - 1}${M_CLOSE}`
        i = j
        continue
      }
    }
    if (src[i] === '<') {
      const m = src.slice(i).match(/^<\/?[a-zA-Z][\w-]*>/)
      if (m) {
        slots.push(m[0])
        out += `${M_OPEN}${slots.length - 1}${M_CLOSE}`
        i += m[0].length
        continue
      }
    }
    out += src[i]
    i++
  }
  return { text: out, slots, conflict }
}

/** 把标记还原成原文；标记数不匹配则返回 null（该条判失败）。 */
function restore(translated, slots) {
  let n = 0
  const out = translated.replace(/\[\[\s*(\d+)\s*\]\]/g, (_, d) => {
    const idx = Number(d)
    if (idx >= slots.length) return `__BAD${d}__`
    n++
    return slots[idx]
  })
  if (n !== slots.length) return null
  if (out.includes('__BAD')) return null
  return out
}

/**
 * 术语回填：机器翻译常把品牌/产品名音译或意译，界面上必须保持原样。
 * 这一步放在还原之后，把已知术语改回英文。
 *
 * 实测踩到：Google 把 "Claude" 翻成「克劳德」、把 "Bedrock" 翻成「基岩」，
 * 在界面上非常违和，必须纠正。
 */
const TERMS = [
  // [错误写法（正则）, 正确写法]
  [/克劳德|克勞德/g, 'Claude'],
  [/基岩/g, 'Bedrock'],
  [/Anthropic\s*公司|人择|人类学/g, 'Anthropic'],
  [/科沃克|共同工作|协作空间/g, 'Cowork'],
  [/伪影|文物|手工制品/g, 'Artifact'],
  [/钩子程序/g, 'Hook'],
  [/工作树/g, 'Worktree'],
  [/技能包/g, 'Skill'],
  [/克劳德代码|Claude代码/g, 'Claude Code'],
  [/奥普斯|作品opus/gi, 'Opus'],
  [/十四行诗/gi, 'Sonnet'],
  [/俳句/gi, 'Haiku'],
  [/欧普斯/gi, 'Opus'],
]
function fixTerms(s) {
  let out = s
  for (const [re, to] of TERMS) out = out.replace(re, to)
  // 中英文之间补空格，观感更自然（只在两侧都是"字"时补）
  out = out.replace(/([\u4e00-\u9fff])([A-Za-z])/g, '$1 $2').replace(/([A-Za-z])([\u4e00-\u9fff])/g, '$1 $2')
  return out
}

// ---------------------------------------------------------------------------
// 各服务适配器
// ---------------------------------------------------------------------------
function needEnv(names) {
  const miss = names.filter((n) => !process.env[n])
  if (miss.length) {
    console.error(`✘ 缺少环境变量：${miss.join(', ')}`)
    console.error('  请在**当前终端**里设置后再运行，例如：')
    console.error(`     $env:${miss[0]}="你的key"`
    )
    process.exit(1)
  }
}

const PROVIDERS = {
  async deepl(texts) {
    needEnv(['DEEPL_AUTH_KEY'])
    const key = process.env.DEEPL_AUTH_KEY
    // 免费版 key 以 :fx 结尾，走 api-free
    const base = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'
    const res = await fetch(`${base}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texts, source_lang: 'EN', target_lang: 'ZH', preserve_formatting: true }),
    })
    if (!res.ok) throw new Error(`DeepL ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const j = await res.json()
    return j.translations.map((t) => t.text)
  },

  async tencent(texts) {
    needEnv(['TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY'])
    const sid = process.env.TENCENT_SECRET_ID
    const skey = process.env.TENCENT_SECRET_KEY
    const host = 'tmt.tencentcloudapi.com'
    const payload = JSON.stringify({ SourceText: texts[0], Source: 'en', Target: 'zh', ProjectId: 0 })
    const date = new Date().toISOString().slice(0, 10)
    const ts = Math.floor(Date.now() / 1000)
    const signed = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:texttranslate\n\ncontent-type;host\n${createHash('sha256').update(payload).digest('hex')}`
    const scope = `${date}/tmt/tc3_request`
    const sts = `TC3-HMAC-SHA256\n${ts}\n${scope}\n${createHash('sha256').update(signed).digest('hex')}`
    const sig = createHmac('sha256', `TC3${skey}`).update(sts).digest('hex')
    const auth = `TC3-HMAC-SHA256 Credential=${sid}/${scope}, SignedHeaders=content-type;host, Signature=${sig}`
    const res = await fetch(`https://${host}/`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        'X-TC-Action': 'TextTranslate',
        'X-TC-Version': '2018-03-21',
        'X-TC-Timestamp': String(ts),
        'X-TC-Region': process.env.TENCENT_REGION || 'ap-shanghai',
      },
      body: payload,
    })
    if (!res.ok) throw new Error(`腾讯云 ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const j = await res.json()
    if (j.Response?.Error) throw new Error(`腾讯云 ${j.Response.Error.Code}: ${j.Response.Error.Message}`)
    return [j.Response.TargetText]
  },

  async google(texts) {
    const key = process.env.GOOGLE_TRANSLATE_KEY
    if (!key) {
      // 无 key 时用官方免费端点（无需鉴权，但有频率限制，仅供自用小批量）
      const res = await fetch(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(texts[0])}`,
      )
      if (!res.ok) throw new Error(`Google ${res.status}`)
      const j = await res.json()
      return [j[0].map((x) => x[0]).join('')]
    }
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts, source: 'en', target: 'zh-CN', format: 'text' }),
    })
    if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const j = await res.json()
    return j.data.translations.map((t) => t.translatedText)
  },

  /**
   * MyMemory：完全免费、无需注册，实测国内可直连（Google 免费端点在无代理时超时）。
   * 单次上限 500 字符，匿名额度约每天 5000 词，够本项目这种一次性补齐。
   * 质量中等偏上，品牌词会被音译，交给 fixTerms() 回填。
   */
  async mymemory(texts) {
    const out = []
    for (const t of texts) {
      const q = t.length > 490 ? t.slice(0, 490) : t
      const url = `https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=${encodeURIComponent(q)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) })
      if (!res.ok) throw new Error(`MyMemory ${res.status}`)
      const j = await res.json()
      const st = String(j.responseStatus)
      if (st !== '200') throw new Error(`MyMemory ${st}: ${(j.responseDetails || '').slice(0, 60)}`)
      const txt = j.responseData?.translatedText
      if (typeof txt !== 'string' || !txt.trim()) throw new Error('MyMemory 空结果')
      // 额度用尽时它会把提示塞进 translatedText
      if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE/i.test(txt)) throw new Error(`MyMemory ${txt.slice(0, 50)}`)
      out.push(txt)
    }
    return out
  },
}

/** 部分服务一次只能翻一条，这里统一成"逐条调用"。 */
const ONE_AT_A_TIME = new Set(['tencent', 'google', 'mymemory'])

// ---------------------------------------------------------------------------
// 取待译清单
// ---------------------------------------------------------------------------
const { findResources } = await import('../lib/paths.mjs')
const found = findResources([])
if (!found) {
  console.error('✘ 找不到 Claude 资源目录')
  process.exit(1)
}
const EN = JSON.parse(readFileSync(join(found.dir, 'ion-dist', 'i18n', 'en-US.json'), 'utf8').replace(/^\uFEFF/, ''))
const ZH = JSON.parse(readFileSync(join(DATA, 'zh-CN-complete.json'), 'utf8').replace(/^\uFEFF/, ''))

/** 需要翻译的：完全未译 + 假翻译（值等于原文）。 */
// 增量落盘文件：固定名，中断后重跑会接着补（不重复翻）。
const OUTPATH = join(DATA, '_tr-rt-auto.json')
const results = {}
try {
  const prev = JSON.parse(readFileSync(OUTPATH, 'utf8').replace(/^\uFEFF/, ''))
  for (const [k, v] of Object.entries(prev)) if (typeof v === 'string' && v.trim()) results[k] = v
  if (Object.keys(results).length) console.log(`  续跑：已有 ${Object.keys(results).length} 条结果，自动跳过`)
} catch {}

const todo = []
for (const k of Object.keys(EN)) {
  const src = EN[k]
  if (typeof src !== 'string' || !src.trim()) continue
  const cur = ZH[k]
  if (cur === undefined || cur === src) todo.push({ key: k, en: src })
}

/** 跳过不该翻译的：品牌名、纯占位符、纯符号、纯路径。 */
const SKIP = [
  /^[\s\d{}%.,:;()\-–/×+=<>]*$/, // 纯符号/数字/占位符
  /^(Google Play|Google Pay|Apple Pay|AWS KMS|Google Cloud KMS|Anthropic|Claude|Claude Code|Claude Pro|Claude Max|Claude Free|Haiku|Sonnet|Opus|OpenDyslexic|Acme Inc|@Claude|Cowork)$/i,
  /^[\w./~-]+$/, // 单个标识符/路径
  /^(Ctrl|Alt|Command|Shift|Meta)\+/i, // 快捷键
  /^X-[A-Za-z-]+$/, // HTTP 头
  /^#?[0-9A-F]{3,8}$/i, // 颜色码
]
const isSkip = (s) => SKIP.some((re) => re.test(s.trim()))

// 已翻过的（续跑文件里有）不再送翻
const queue = todo.filter((x) => !isSkip(x.en) && results[x.en] === undefined)
console.log(`=== 待翻译 ===`)
console.log(`  未译或假翻译总数 : ${todo.length}`)
console.log(`  跳过（品牌/符号）: ${todo.length - queue.length}`)
console.log(`  实际送翻          : ${queue.length}`)
console.log(`  服务              : ${PROVIDER}`)
if (!PROVIDERS[PROVIDER]) {
  console.error(`✘ 不支持的服务：${PROVIDER}（可用：${Object.keys(PROVIDERS).join(', ')}）`)
  process.exit(1)
}

const work = LIMIT ? queue.slice(0, LIMIT) : queue
if (DRY) {
  console.log(`\n[dry] 只翻前 5 条：`)
  for (const x of work.slice(0, 5)) console.log(`    ${JSON.stringify(x.en).slice(0, 80)}`)
}

// ---------------------------------------------------------------------------
// 翻译
// ---------------------------------------------------------------------------
// 增量落盘：固定文件名，每翻完一批就覆盖写一次。
// 早先只在全部跑完时才写一次，结果中途被中断就一条不剩（实际踩过）。
// 现在中断也能保留大部分成果，重跑自动接着补（results 已在上方预加载）。
function flush() {
  try {
    writeFileSync(OUTPATH, JSON.stringify(results, null, 2), 'utf8')
  } catch {}
}
let ok = 0
let fail = 0
const failed = []

async function translateOne(item) {
  const { text, slots, conflict } = protect(item.en)
  if (conflict) {
    fail++
    failed.push({ en: item.en, why: '源文含 [[ ]]，与占位符标记冲突' })
    return
  }
  if (PROVIDER === 'mymemory' && text.length > 490) {
    fail++
    failed.push({ en: item.en, why: '超过 MyMemory 490 字符上限' })
    return
  }
  let out
  let lastErr = ''
  // 免费端点会偶发 429/超时，重试 3 次
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      out = await PROVIDERS[PROVIDER]([text])
      out = Array.isArray(out) ? out[0] : out
      if (typeof out === 'string' && out.trim()) break
      lastErr = '空结果'
    } catch (e) {
      lastErr = e.message.slice(0, 80)
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
  }
  if (typeof out !== 'string' || !out.trim()) {
    fail++
    failed.push({ en: item.en, why: lastErr || '空结果' })
    return
  }
  const restored = restore(out, slots)
  if (restored === null) {
    fail++
    failed.push({ en: item.en, why: '占位符还原失败' })
    return
  }
  results[item.en] = fixTerms(restored)
  ok++
  if (ok % 25 === 0) flush()
  if (ok % 50 === 0) console.log(`  已翻 ${ok} 条…`)
}

if (!DRY) {
  // 逐条服务：每轮并发 CONCURRENCY 条；批量服务：一次 40 条
  const perStep = ONE_AT_A_TIME.has(PROVIDER) ? Math.max(1, CONCURRENCY) : 40
  for (let i = 0; i < work.length; i += perStep) {
    const chunk = work.slice(i, i + perStep)
    if (ONE_AT_A_TIME.has(PROVIDER)) {
      // 逐条 + 并发
      await Promise.all(chunk.map((x) => translateOne(x)))
    } else {
      // 批量接口：一次多条
      const protectedList = chunk.map((x) => protect(x.en))
      try {
        const out = await PROVIDERS[PROVIDER](protectedList.map((p) => p.text))
        chunk.forEach((x, idx) => {
          const restored = restore(out[idx] ?? '', protectedList[idx].slots)
          if (restored === null || !restored.trim()) {
            fail++
            failed.push({ en: x.en, why: '占位符还原失败/空' })
          } else {
            results[x.en] = fixTerms(restored)
            ok++
          }
        })
      } catch (e) {
        for (const x of chunk) {
          fail++
          failed.push({ en: x.en, why: e.message.slice(0, 60) })
        }
      }
    }
    // 每轮都落盘，中断也能保住成果
    flush()
    if ((i / perStep) % 10 === 0) console.log(`  进度 ${Math.min(i + perStep, work.length)}/${work.length}（成功 ${ok} / 失败 ${fail}）`)
    // 轻微延迟，避免触发限流
    await new Promise((r) => setTimeout(r, 200))
  }
}

console.log(`\n=== 结果 ===`)
console.log(`  成功: ${ok}`)
console.log(`  失败: ${fail}`)
if (failed.length) {
  console.log('  失败样例（前 10）:')
  for (const f of failed.slice(0, 10)) console.log(`    ${JSON.stringify(f.en).slice(0, 50)} — ${f.why}`)
}
if (DRY) process.exit(0)

// 写批次（格式与 merge-translations.mjs 兼容）
if (Object.keys(results).length) {
  flush()
  console.log(`\n  已写入 ${OUTPATH}（${Object.keys(results).length} 条）`)
  console.log('  下一步：node tools/merge-translations.mjs')
}
