/**
 * 跨版本兼容性回归测试。
 *
 * 背景（真实踩过的坑）
 * --------------------
 * Claude 每次发版都会重新生成 i18n 的键（不透明哈希），文案基本不变。
 * install.mjs 最早只按键合并，于是"换一个版本"的实测结果是
 * **中文覆盖率 0.00%** —— 界面整片回退英文。
 *
 * 现在安装时多了一道「按英文原文回填」：包里带
 * data/zh-CN-by-text.json，没命中键的条目按原文查中文。
 *
 * 本测试的做法：拿当前版本的 en-US.json，把键名全部换成假哈希
 * （等价于"另一个版本"），跑一次安装，然后统计中文覆盖率。
 * 期望 ≥ 95%；同时检查：
 *   - 不会因为出现全新的文案而崩溃（新文案保持英文，不算错）
 *   - 目标文件已存在但内容被清空时能自愈
 *
 * 用法：node tests/test-cross-version.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NODE = process.execPath
const TMP = join(process.env.TEMP || '.', 'claude-zh-cross-version-test')

const { findResources } = await import(pathToFileURL(join(ROOT, 'lib', 'paths.mjs')).href)
const found = findResources([])
if (!found) {
  console.log('跳过：本机没有装 Claude Desktop，无法生成夹具')
  process.exit(0)
}

const load = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const EN_FRONT = load(join(found.dir, 'ion-dist', 'i18n', 'en-US.json'))
const EN_SHELL = load(join(found.dir, 'en-US.json'))

/** 生成"另一个版本"的夹具：键换成假哈希，可选塞入全新文案。 */
function makeFixture(dir, extraTexts = []) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'ion-dist', 'i18n'), { recursive: true })
  const rename = (obj) => {
    const out = {}
    let i = 0
    for (const [k, v] of Object.entries(obj)) {
      i++
      out['z' + String(i).padStart(6, '0')] = v
    }
    return out
  }
  const front = rename(EN_FRONT)
  let n = 0
  for (const t of extraTexts) front['new' + String(++n).padStart(5, '0')] = t
  writeFileSync(join(dir, 'ion-dist', 'i18n', 'en-US.json'), JSON.stringify(front, null, 2), 'utf8')
  writeFileSync(join(dir, 'en-US.json'), JSON.stringify(rename(EN_SHELL), null, 2), 'utf8')

  // 白名单文件要被找到，否则第 3 步会失败（真实环境里它一定存在）
  const wlSrc = join(found.dir, 'ion-dist', 'assets', 'v1')
  const wlDst = join(dir, 'ion-dist', 'assets', 'v1')
  mkdirSync(wlDst, { recursive: true })
  for (const name of existsSync(wlSrc) ? ['shared-2-C6aD8DvJ.js'] : []) {
    const s = join(wlSrc, name)
    if (existsSync(s)) writeFileSync(join(wlDst, name), readFileSync(s))
  }
  return front
}

function runInstall(dir) {
  try {
    execFileSync(NODE, [join(ROOT, 'scripts', 'install.mjs'), '--resources', dir, '--quiet'], {
      stdio: 'pipe',
      encoding: 'utf8',
    })
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') }
  }
  return { ok: true, out: '' }
}

function coverage(dir) {
  const en = load(join(dir, 'ion-dist', 'i18n', 'en-US.json'))
  const zh = load(join(dir, 'ion-dist', 'i18n', 'zh-CN.json'))
  let total = 0
  let cjk = 0
  for (const [k, v] of Object.entries(en)) {
    if (typeof v !== 'string' || !v.trim()) continue
    total++
    if (/[\u4e00-\u9fff]/.test(zh[k] || '')) cjk++
  }
  const enS = load(join(dir, 'en-US.json'))
  const zhS = load(join(dir, 'zh-CN.json'))
  let totalS = 0
  let cjkS = 0
  for (const [k, v] of Object.entries(enS)) {
    if (typeof v !== 'string' || !v.trim()) continue
    totalS++
    if (/[\u4e00-\u9fff]/.test(zhS[k] || '')) cjkS++
  }
  return { front: cjk / total, shell: totalS ? cjkS / totalS : 1, total, cjk }
}

let failures = 0
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`  ✔ ${name}`)
  } else {
    failures++
    console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// ---- 用例 1：键全换掉（模拟任意另一个版本） ----
console.log('[1/3] 键名全部换掉 + 夹具为空目录')
const dir1 = join(TMP, 'v-other')
makeFixture(dir1)
const r1 = runInstall(dir1)
check('安装不报错', r1.ok, r1.out.slice(-300))
const c1 = coverage(dir1)
check(`前端中文覆盖率 ≥ 95%（实测 ${(c1.front * 100).toFixed(2)}%）`, c1.front >= 0.95)
check(`桌面外壳中文覆盖率 ≥ 95%（实测 ${(c1.shell * 100).toFixed(2)}%）`, c1.shell >= 0.95)

// ---- 用例 2：夹带全新文案（这个版本新增的句子） ----
console.log('[2/3] 增加 6 条字典里没有的新文案')
const dir2 = join(TMP, 'v-newstrings')
makeFixture(dir2, [
  'This is a brand new sentence from a future release',
  'Another one that nobody has translated yet',
  'Click here to do something entirely new',
  'Your quota resets on the first of next month',
  'Invite a teammate to this workspace',
  'Try the new experimental feature',
])
const r2 = runInstall(dir2)
check('安装不报错（新文案保持英文即可）', r2.ok, r2.out.slice(-300))
const c2 = coverage(dir2)
check(`前端覆盖率仍 ≥ 95%（实测 ${(c2.front * 100).toFixed(2)}%）`, c2.front >= 0.95)
const zh2 = load(join(dir2, 'ion-dist', 'i18n', 'zh-CN.json'))
check('未翻译的新文案保持英文而不是空白', Object.keys(zh2).some((k) => String(zh2[k]).includes('brand new sentence')))

// ---- 用例 3：目标中文文件被清空（异常现场） ----
console.log('[3/3] 目标 zh-CN.json 被清成 {} 后重装')
const dir3 = join(TMP, 'v-corrupt')
makeFixture(dir3)
writeFileSync(join(dir3, 'ion-dist', 'i18n', 'zh-CN.json'), '{}', 'utf8')
writeFileSync(join(dir3, 'zh-CN.json'), '{}', 'utf8')
const r3 = runInstall(dir3)
check('安装不报错', r3.ok, r3.out.slice(-300))
const c3 = coverage(dir3)
check(`能自愈，覆盖率 ≥ 95%（实测 ${(c3.front * 100).toFixed(2)}%）`, c3.front >= 0.95)

rmSync(TMP, { recursive: true, force: true })
console.log('')
if (failures) {
  console.log(`跨版本测试失败：${failures} 项`)
  process.exit(1)
}
console.log('跨版本测试全部通过')
