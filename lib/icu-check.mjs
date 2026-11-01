// ICU MessageFormat-aware structural validator.
//
// A "compare every {…} token" check cannot tell a renamed placeholder from a
// legitimately translated plural branch, so it reports false positives on any
// message containing ICU syntax. This module compares a structural shape
// instead: argument names, argument types and branch selectors must survive
// translation, while the human-readable text inside branches is free to differ.
//
// ICU plural/select bodies separate their branches with WHITESPACE, not commas:
//   {count, plural, one {# file} other {# files}}
//                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ two branches
// so the body needs its own tokenizer rather than a comma split.

/** Result of reading `{`…`}` starting at `start` (which must be a `{`). */
function readMessage(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" && text[i + 1] === "'") {
      i++ // ICU escape for a literal apostrophe
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { body: text.slice(start + 1, i), end: i }
    }
  }
  return null // unbalanced
}

/** Every `{`…`}` span at depth 0 of `text`, with its body. */
function topLevelMessages(text) {
  const found = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" && text[i + 1] === "'") {
      i += 2
      continue
    }
    if (ch === '{') {
      const m = readMessage(text, i)
      if (m === null) break
      found.push(m.body)
      i = m.end + 1
      continue
    }
    i++
  }
  return found
}

/**
 * Split an ICU body into its leading header and its selector/branch pairs.
 * Branch selectors are separated by whitespace, and a selector may be glued to
 * the previous branch's closing brace (`{# file} other {…}`), so walk the body
 * forward instead of splitting it.
 */
function parseIcuBody(body) {
  const firstBrace = body.indexOf('{')
  const header = (firstBrace === -1 ? body : body.slice(0, firstBrace))
    .split(',')
    .map((s) => s.trim())
  const arg = header[0]
  const type = header[1]

  const branches = []
  if (firstBrace !== -1) {
    // Start at 0, not at firstBrace: the FIRST branch's selector (`one` in
    // `{n, plural, one {…}`) sits BEFORE the first brace, and walking back
    // from firstBrace is blocked by the cursor, which made the first selector
    // read as an empty string — indistinguishable from a lost selector.
    let cursor = 0
    while (cursor < body.length) {
      const next = body.indexOf('{', cursor)
      if (next === -1) break
      // The selector sits before this brace, but NOT immediately adjacent:
      // it reads `one {a}` with a space, so skip back over whitespace FIRST
      // and only then take the run of non-space characters.
      let selEnd = next
      while (selEnd > cursor && /\s/.test(body[selEnd - 1])) selEnd--
      let selStart = selEnd
      while (selStart > cursor && !/[\s{}]/.test(body[selStart - 1])) selStart--
      const selector = body.slice(selStart, selEnd).trim()
      const m = readMessage(body, next)
      if (m === null) break
      branches.push({ selector, body: m.body })
      cursor = m.end + 1
    }
  }
  return { arg, type, branches }
}

/**
 * Collect the structural shape of every ICU argument and branch in `text`.
 * Plain arguments become `a:<arg>`, ICU arguments `t:<arg>:<type>`, and each
 * branch `s:<selector>`.
 */
function shape(text, out = []) {
  for (const body of topLevelMessages(text)) {
    const { arg, type, branches } = parseIcuBody(body)
    if (/^(plural|select|selectordinal)$/.test(type)) {
      out.push(`t:${arg}:${type}`)
      for (const b of branches) {
        out.push(`s:${b.selector}`)
        shape(b.body, out)
      }
    } else if (arg.startsWith('#')) {
      // `#` is ICU's plural-count token, not an argument. It may be written
      // `{# files}` or `{# 个文件}`, so its text is translatable and comparing
      // it would report false failures. Count occurrences instead.
      out.push('hash')
    } else {
      out.push(`a:${arg}`)
      for (const b of branches) shape(b.body, out)
    }
  }
  return out
}

/** Top-level plain placeholders, which must survive translation verbatim. */
function plainPlaceholders(text) {
  const out = []
  for (const body of topLevelMessages(text)) {
    const { type, arg, branches } = parseIcuBody(body)
    if (/^(plural|select|selectordinal)$/.test(type)) continue
    if (branches.length === 0) out.push(arg)
  }
  return out
}

const tagNames = (s) =>
  [...s.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]).sort()

/**
 * Blank out tag markup so brace scanning can see ICU nested inside tags, e.g.
 * `<install>{count, plural, …}</install>`. Gaps keep their length so nothing
 * else shifts.
 */
function stripTags(s) {
  return s.replace(/<\/?[a-zA-Z][^>]*>/g, (m) => ' '.repeat(m.length))
}

/**
 * Every translatable text run. Tag content already contains anything nested
 * inside a tag, so the whole tag-stripped string is used only when the message
 * has no tags at all — otherwise nested ICU would be counted twice and the
 * multiset comparison would fail on a correct translation.
 */
function textSegments(s) {
  const tags = [...s.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)[^>]*>([\s\S]*?)<\/\1>/g)]
  if (tags.length === 0) return [stripTags(s)]
  const segs = tags.map((m) => stripTags(m[2]))
  const outside = stripTags(s.replace(/<([a-zA-Z][a-zA-Z0-9-]*)[^>]*>[\s\S]*?<\/\1>/g, ' '))
  if (outside.trim() !== '') segs.push(outside)
  return segs
}

/**
 * Collect the raw body text of every ICU branch.
 *
 * Used for coverage checking rather than structural validation: a branch whose
 * translation is byte-identical to the English source is the signature of an
 * agent that "fixed" a naive placeholder check by reverting the branch to
 * English. Structure alone cannot see that, because such output is perfectly
 * well-formed.
 */
export function icuBranches(text, out = []) {
  for (const body of topLevelMessages(text)) {
    const { type, branches } = parseIcuBody(body)
    if (/^(plural|select|selectordinal)$/.test(type)) {
      for (const b of branches) {
        out.push(b.body.trim())
        icuBranches(b.body, out)
      }
      continue
    }
    for (const b of branches) icuBranches(b.body, out)
  }
  return out
}

/**
 * Is this branch pair an untranslated English leftover?
 *
 * Deliberately conservative, because a false positive here would send valid
 * work back for re-translation:
 *  - the translation must be byte-identical to the source, and
 *  - it must contain at least three distinct English words of 3+ letters, and
 *  - it must contain no Chinese at all.
 *
 * Short branches such as `# file` / `# files` therefore do not trip it. This
 * catches the real damage (a whole English clause left in place); it is a
 * coverage signal, not a proof, and the audit reports it separately from
 * structural validity.
 */
export function isUntranslatedBranch(srcBody, dstBody) {
  if (srcBody !== dstBody) return false
  if (/[\u4e00-\u9fff]/.test(dstBody)) return false
  const words = dstBody.replace(/#/g, ' ').match(/[A-Za-z]{3,}/g) ?? []
  return new Set(words.map((w) => w.toLowerCase())).size >= 3
}

/** Does a piece of branch text still look like untranslated English prose? */
export function looksUntranslated(branchText, sourceText) {
  return isUntranslatedBranch(sourceText, branchText)
}

/**
 * Report ICU branches whose text was left in English.
 *
 * This is a coverage signal, not a structural error, so it is deliberately
 * kept out of {@link compareMessage}: leaking English must be visible in the
 * audit without rejecting an otherwise-valid translation.
 *
 * @returns {Array<{source: string, translation: string}>}
 */
export function englishBranches(src, dst) {
  if (typeof dst !== 'string') return []
  const srcBranches = icuBranches(src)
  const dstBranches = icuBranches(dst)
  const out = []
  for (let i = 0; i < Math.min(srcBranches.length, dstBranches.length); i++) {
    if (looksUntranslated(dstBranches[i], srcBranches[i])) {
      out.push({ source: srcBranches[i], translation: dstBranches[i] })
    }
  }
  return out
}

/**
 * Every ICU plural/select block in a message, with its selectors, including
 * blocks nested inside tags. Used to enforce the app parser's
 * `requiresOtherClause: true` rule.
 *
 * @returns {Array<{arg: string, type: string, selectors: string[]}>}
 */
export function icuSelectorReport(text, out = []) {
  const visit = (s) => {
    for (const body of topLevelMessages(s)) {
      const { arg, type, branches } = parseIcuBody(body)
      if (/^(plural|select|selectordinal)$/.test(type)) {
        out.push({ arg, type, selectors: branches.map((b) => b.selector) })
        for (const b of branches) visit(b.body)
      } else {
        for (const b of branches) visit(b.body)
      }
    }
  }
  visit(stripTags(text))
  for (const m of text.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)[^>]*>([\s\S]*?)<\/\1>/g)) visit(stripTags(m[2]))
  return out
}

/**
 * Ordered bag of every ICU branch as `arg|type|selector`, collected across all
 * message segments.
 *
 * `shape()` deliberately sorts selector tokens so a language may reorder
 * clauses, but that also means it compares only HOW MANY branches exist, never
 * their names — renaming `other` to `many` would pass. This multiset restores
 * the selector names, and because it is a set comparison, legitimate branch
 * reordering still passes.
 */
function branchKeys(segments) {
  const out = []
  for (const s of segments) {
    for (const b of icuSelectorReport(s)) {
      for (const sel of b.selectors) out.push(`${b.arg}|${b.type}|${sel}`)
    }
  }
  return out.sort().join('|')
}

/**
 * Compare a source string with its translation.
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function compareMessage(src, dst) {
  const reasons = []
  if (typeof dst !== 'string') return { ok: false, reasons: ['not-a-string'] }
  if (dst.trim() === '') return { ok: false, reasons: ['empty'] }

  const ta = tagNames(src)
  const tb = tagNames(dst)
  if (ta.join('|') !== tb.join('|'))
    reasons.push(`tags: expected [${ta.join('|')}] got [${tb.join('|')}]`)

  const segsA = textSegments(src)
  const segsB = textSegments(dst)
  if (segsA.length !== segsB.length)
    reasons.push(`segments: expected ${segsA.length} got ${segsB.length}`)

  const ia = segsA.flatMap((s) => shape(s)).sort().join('|')
  const ib = segsB.flatMap((s) => shape(s)).sort().join('|')
  if (ia !== ib) reasons.push(`icu-shape: expected [${ia}] got [${ib}]`)

  // Selector NAMES, which the sorted shape comparison cannot see.
  const ba = branchKeys(segsA)
  const bb = branchKeys(segsB)
  if (ba !== bb) reasons.push(`icu-selectors: expected [${ba}] got [${bb}]`)

  const pa = segsA.flatMap(plainPlaceholders).sort().join('|')
  const pb = segsB.flatMap(plainPlaceholders).sort().join('|')
  if (pa !== pb) reasons.push(`placeholder: expected [${pa}] got [${pb}]`)

  return { ok: reasons.length === 0, reasons }
}
