// Split an UI string into translatable plain-text runs and verbatim structure.
//
// Why this exists: machine translation services destroy ICU MessageFormat
// syntax and HTML tags. Protecting them behind markers works for Google
// (`⟦0⟧` comes back intact) but not for every engine — MyMemory turned
// `Delete ⟦0⟧ permanently?` into `⟧ 永久删除⟦0 ？`. And a message that is
// nothing but a plural block (`{count, plural, one {# file} other {# files}}`)
// has no plain text at all outside the branches, so a marker-based approach
// translates nothing.
//
// So instead of protecting structure, this module takes the message apart:
// plain text runs are handed to the translator one by one, and the structure
// (arguments, selectors, tags) is stored verbatim and reassembled afterwards.
// Reassembly is lossless by construction, so the only thing that can vary is
// the text — and that is exactly what `lib/icu-check.mjs` already validates.

/** Read `{`…`}` starting at `start` (which must be `{`). Mirrors icu-check. */
function readMessage(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" && text[i + 1] === "'") {
      i++
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { body: text.slice(start + 1, i), end: i }
    }
  }
  return null
}

const CHOICE_TYPES = /^(plural|select|selectordinal)$/
const TAG = /^<\/?[a-zA-Z][\w-]*>/

/**
 * Parse a message body into branch list, or return null when it is a plain
 * argument (`{name}`, `{name, number}`, …).
 */
function parseChoice(body) {
  const firstBrace = body.indexOf('{')
  const headerRaw = firstBrace === -1 ? body : body.slice(0, firstBrace)
  const header = headerRaw.split(',').map((s) => s.trim())
  const arg = header[0]
  const type = header[1]
  if (firstBrace === -1 || !CHOICE_TYPES.test(type || '')) return null

  const branches = []
  // 从 0 开始扫：第一个分支的选择子（`one`）写在第一个 `{` 之前，
  // 若从 firstBrace 起扫，回退查选择子时会被下界挡住，导致选择子变成空串。
  let cursor = 0
  while (cursor < body.length) {
    const next = body.indexOf('{', cursor)
    if (next === -1) break
    let selEnd = next
    while (selEnd > cursor && /\s/.test(body[selEnd - 1])) selEnd--
    let selStart = selEnd
    while (selStart > cursor && !/[\s{}]/.test(body[selStart - 1])) selStart--
    const selector = body.slice(selStart, selEnd).trim()
    const m = readMessage(body, next)
    if (m === null) break
    branches.push({ selector, nodes: parseNodes(m.body) })
    cursor = m.end + 1
  }
  if (!branches.length) return null
  return { arg, type, branches }
}

/**
 * Split a message into nodes.
 * - `{t:'text', v}`  plain text, to be translated
 * - `{t:'raw',  v}`  `{arg}` / `{arg, number, …}` / HTML tag / `#`, kept as-is
 * - `{t:'choice', arg, type, branches}`  plural/select block
 */
export function parseNodes(src) {
  const nodes = []
  let buf = ''
  const flush = () => {
    if (buf) nodes.push({ t: 'text', v: buf })
    buf = ''
  }
  let i = 0
  while (i < src.length) {
    if (src[i] === '{') {
      const m = readMessage(src, i)
      if (m === null) {
        buf += src[i++]
        continue
      }
      flush()
      const choice = parseChoice(m.body)
      nodes.push(choice ? { t: 'choice', ...choice } : { t: 'raw', v: src.slice(i, m.end + 1) })
      i = m.end + 1
      continue
    }
    if (src[i] === '<') {
      const m = src.slice(i).match(TAG)
      if (m) {
        flush()
        nodes.push({ t: 'raw', v: m[0] })
        i += m[0].length
        continue
      }
    }
    // `#` inside a plural branch is ICU's count token; it must not move around.
    if (src[i] === '#') {
      flush()
      nodes.push({ t: 'raw', v: '#' })
      i++
      continue
    }
    buf += src[i]
    i++
  }
  flush()
  return nodes
}

/** Rebuild a message from nodes, taking each text run from `lookup`. */
export function renderNodes(nodes, lookup = (s) => s) {
  let out = ''
  for (const n of nodes) {
    if (n.t === 'text') {
      const v = lookup(n.v)
      out += typeof v === 'string' && v !== '' ? v : n.v
    } else if (n.t === 'raw') {
      out += n.v
    } else {
      const branches = n.branches.map((b) => `${b.selector} {${renderNodes(b.nodes, lookup)}}`)
      out += `{${n.arg}, ${n.type}, ${branches.join(' ')}}`
    }
  }
  return out
}

/** Every distinct plain-text run in a message that is worth translating. */
export function textRuns(src) {
  const out = []
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.t === 'text') out.push(n.v)
      else if (n.t === 'choice') for (const b of n.branches) walk(b.nodes)
    }
  }
  walk(parseNodes(src))
  return out
}

/** A run needs translating only if it contains real words. */
export function worthTranslating(s) {
  return /[A-Za-z]{2,}/.test(s)
}
