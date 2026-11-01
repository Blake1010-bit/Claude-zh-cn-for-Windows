#!/usr/bin/env node
/**
 * 复验：确认安装后的语言文件确实完好。
 *
 * 只读，不改任何文件。安装完想确认「有没有弄坏界面」就跑这个。
 *
 * 用法：node scripts/verify.mjs
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { FRONTEND_I18N, findResources, diagnoseNotFound, readJson } from '../lib/paths.mjs'
import { compareMessage } from '../lib/icu-check.mjs'

const argv = process.argv.slice(2)
const found = findResources(argv)

if (found === null) {
  console.error(diagnoseNotFound())
  process.exit(1)
}
const RES = found.dir

let failed = 0

const check = (label, enPath, zhPath) => {
  if (!existsSync(zhPath)) {
    console.log(`【${label}】文件不存在，跳过`)
    console.log()
    return
  }
  const en = readJson(enPath)
  const zh = readJson(zhPath)
  const ek = Object.keys(en)

  let missing = 0
  let structural = 0
  let empty = 0
  let stillEn = 0
  const samples = []

  for (const k of ek) {
    if (!(k in zh)) {
      missing++
      stillEn++
      continue
    }
    const v = zh[k]
    if (typeof v !== 'string' || v.trim() === '') {
      empty++
      continue
    }
    if (v === en[k]) stillEn++
    const r = compareMessage(en[k], v)
    if (!r.ok) {
      structural++
      if (samples.length < 3) samples.push([k, en[k], v, r.reasons[0]])
    }
  }

  const cjk = Object.keys(zh).filter((k) => typeof zh[k] === 'string' && /[\u4e00-\u9fff]/.test(zh[k])).length
  // 两个不同的指标，别混着看：
  //   键覆盖率     = 当前版本需要的键里，文件里有几条（缺键会让界面漏字）
  //   真实中文率   = 其中值真的变成中文的（品牌名/纯占位符条目本来就该留英文）
  // 早先只报前者，显示 100%，容易被理解成"全都翻译好了"。
  const pctKeys = ((100 * (ek.length - missing)) / ek.length).toFixed(1)
  const pctZh = ((100 * (ek.length - stillEn)) / ek.length).toFixed(2)

  console.log(`【${label}】  键 ${pctKeys}% · 中文 ${pctZh}% · 结构损坏 ${structural} · 空值 ${empty}`)
  console.log(`  中文值 ${cjk} 条，仍是英文 ${stillEn} 条（含品牌名/纯占位符等本就该留英文的）`)
  for (const [k, s, d, why] of samples) {
    console.log(`    ! ${k}`)
    console.log(`      英文: ${JSON.stringify(s).slice(0, 80)}`)
    console.log(`      中文: ${JSON.stringify(d).slice(0, 80)}`)
    console.log(`      原因: ${why.slice(0, 100)}`)
  }
  console.log()

  if (structural > 0 || empty > 0) failed++
}

check('前端界面', join(RES, FRONTEND_I18N, 'en-US.json'), join(RES, FRONTEND_I18N, 'zh-CN.json'))
check('桌面外壳', join(RES, 'en-US.json'), join(RES, 'zh-CN.json'))

console.log('────────────────────────────────────────')
if (failed === 0) {
  console.log('复验通过：界面数据完好，可以放心使用。')
} else {
  console.log('复验未通过：发现结构问题，建议用还原脚本回到安装前状态。')
  console.log('  还原：node scripts/restore.mjs')
  process.exit(1)
}
console.log('────────────────────────────────────────')
