import { readFileSync } from 'node:fs'
const R = process.argv[2]
const load = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const en = load(R + '/ion-dist/i18n/en-US.json')
const zh = load(R + '/ion-dist/i18n/zh-CN.json')
let total = 0
let cjk = 0
let same = 0
for (const [k, v] of Object.entries(en)) {
  if (typeof v !== 'string' || !v.trim()) continue
  total++
  const t = zh[k]
  if (typeof t !== 'string') continue
  if (/[\u4e00-\u9fff]/.test(t)) cjk++
  else if (t === v) same++
}
console.log(`前端：${total} 条可翻，其中已出中文 ${cjk}（${((cjk / total) * 100).toFixed(2)}%），仍英文 ${same}`)
const enS = load(R + '/en-US.json')
const zhS = load(R + '/zh-CN.json')
let ts = 0
let cs = 0
for (const [k, v] of Object.entries(enS)) {
  if (typeof v !== 'string' || !v.trim()) continue
  ts++
  if (/[\u4e00-\u9fff]/.test(zhS[k] || '')) cs++
}
console.log(`外壳：${ts} 条，已出中文 ${cs}（${((cs / ts) * 100).toFixed(2)}%）`)
