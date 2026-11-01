/**
 * 把随包数据压成 gzip（*.json.gz），并删掉明文。
 *
 * 为什么要压缩进仓库
 * ------------------
 * 直接往 GitHub 提交 2 MB 以上的 blob 会稳定返回
 *     401 {"message":"Bad credentials"}
 * 同一个令牌、同一条请求，1.5 MB 就正常，2.2 MB 和 3.1 MB 都失败
 * （实测 78~117 秒后报错，明显是中间层而不是 GitHub 在拒绝）。
 * 而这些数据明文本来就大：zh-CN-complete.json 2.1 MB、
 * zh-CN-by-text.json 3.0 MB。压成 gzip 后只有原来的 1/4 左右。
 *
 * 读取端用 lib/packio.mjs 的 readPack()：明文在就用明文，否则解 gzip。
 * 所以开发时可以留着 .json，发布前跑一次这个脚本即可。
 *
 * 用法：
 *   node tools/pack-data.mjs          压缩并删除明文
 *   node tools/pack-data.mjs --keep   压缩但保留明文
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA = join(ROOT, 'data')
const KEEP = process.argv.includes('--keep')

const FILES = ['zh-CN-complete.json', 'zh-CN-desktop-complete.json', 'zh-CN-desktop-extra.json', 'zh-CN-by-text.json']

let total = 0
let saved = 0
for (const name of FILES) {
  const src = join(DATA, name)
  if (!existsSync(src)) {
    if (existsSync(src + '.gz')) continue
    console.log(`  – 跳过 ${name}（不存在）`)
    continue
  }
  const raw = readFileSync(src)
  const gz = gzipSync(raw, { level: 9 })
  writeFileSync(src + '.gz', gz)
  // 立刻验证能解回同样的内容，避免压坏文件
  const { gunzipSync } = await import('node:zlib')
  if (gunzipSync(gz).equals(raw) === false) {
    console.error(`  ✘ ${name} 压缩后校验失败，保留明文`)
    process.exit(1)
  }
  total += raw.length
  saved += raw.length - gz.length
  console.log(
    `  ✔ ${name}  ${(raw.length / 1024 / 1024).toFixed(2)} MB → ${(gz.length / 1024 / 1024).toFixed(2)} MB（${(
      100 -
      (gz.length / raw.length) * 100
    ).toFixed(0)}% 省下）`,
  )
  if (!KEEP) unlinkSync(src)
}

console.log('')
console.log(`合计 ${(total / 1024 / 1024).toFixed(2)} MB → 省下 ${(saved / 1024 / 1024).toFixed(2)} MB`)
if (KEEP) console.log('（--keep：明文已保留）')
