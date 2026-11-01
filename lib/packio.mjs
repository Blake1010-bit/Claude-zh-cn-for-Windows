/**
 * 读取随包的语言数据。
 *
 * 为什么要有这层：数据文件比较大（zh-CN-complete.json 2.1 MB、
 * zh-CN-by-text.json 3.0 MB），仓库里改成存 gzip（*.json.gz），
 * 下载和提交都小一半以上。读取时优先用明文，没有就解 gzip，
 * 这样开发时本地留 .json、发布时只留 .gz，两边都能跑。
 *
 * 实测背景：直接往 GitHub 提交 2 MB 以上的 blob 会稳定返回 401
 * （同一份请求 1.5 MB 就正常），所以大文件必须压缩后再进仓库。
 */
import { readFileSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

/** @returns {object|null} 读不到时返回 null，不抛异常。 */
export function readPack(file) {
  try {
    if (existsSync(file)) return JSON.parse(stripBom(readFileSync(file, 'utf8')))
    const gz = file + '.gz'
    if (existsSync(gz)) return JSON.parse(stripBom(gunzipSync(readFileSync(gz)).toString('utf8')))
  } catch {
    return null
  }
  return null
}

/** 这个数据文件在磁盘上实际叫什么（明文或 gzip），找不到返回 null。 */
export function packFile(file) {
  if (existsSync(file)) return file
  if (existsSync(file + '.gz')) return file + '.gz'
  return null
}
