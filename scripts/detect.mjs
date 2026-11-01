#!/usr/bin/env node
/**
 * 检查当前机器上的 Claude Desktop 情况，不修改任何文件。
 *
 * 不确定自己的 Claude 装在哪里、汉化生效没有，跑这个就好。
 *
 * 用法：
 *   node scripts/detect.mjs
 *   node scripts/detect.mjs --resources "<路径>"
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  FRONTEND_I18N,
  findResources,
  diagnoseNotFound,
  readJson,
  sizeOf,
} from '../lib/paths.mjs'
import { findWhitelistFiles } from '../lib/whitelist.mjs'

const argv = process.argv.slice(2)
const found = findResources(argv)

if (found === null) {
  console.error(diagnoseNotFound())
  process.exit(1)
}

const RES = found.dir
console.log('✔ 找到 Claude 资源目录')
console.log(`  ${RES}`)
console.log(`  （${found.source}）`)
console.log()

const report = (label, enPath, zhPath) => {
  const en = readJson(enPath)

  // 目标文件不存在是完全正常的状态（刚装完 Claude，或者刚还原过），
  // 早先这里直接 readJson 会抛 ENOENT，用户看到的是一堆堆栈。
  if (!existsSync(zhPath)) {
    console.log(`【${label}】`)
    console.log(`  状态          : 未安装中文（文件不存在）`)
    console.log(`  英文原条目    : ${Object.keys(en).length}`)
    console.log()
    return { missing: 0, stillEn: 0, installed: false }
  }

  const zh = readJson(zhPath)
  const ek = Object.keys(en)
  const missing = ek.filter((k) => !(k in zh))
  // 两个指标要分开看：
  //   键覆盖率   = 当前版本需要的键里，文件里有几条（缺键会让界面漏字）
  //   真实中文率 = 其中值确实变成中文的（品牌名/纯占位符本来就应该留英文）
  // 早先只报前者并写成"中文覆盖率"，显示 100%，容易被理解成"全都翻译好了"。
  const stillEn = ek.filter((k) => !(k in zh) || zh[k] === en[k])
  const pctKeys = ((100 * (ek.length - missing.length)) / ek.length).toFixed(1)
  const pctZh = ((100 * (ek.length - stillEn.length)) / ek.length).toFixed(2)
  const cjk = Object.keys(zh).filter((k) => /[\u4e00-\u9fff]/.test(zh[k])).length

  console.log(`【${label}】`)
  console.log(`  英文原条目    : ${ek.length}`)
  console.log(`  键覆盖率      : ${pctKeys}%（缺键 ${missing.length} 条）`)
  console.log(`  真实中文率    : ${pctZh}%`)
  console.log(`  仍是英文      : ${stillEn.length}（含品牌名、纯占位符等本该留英文的）`)
  console.log(`  含中文的值    : ${cjk}`)
  console.log(`  文件大小      : ${sizeOf(zhPath)} 字节`)
  console.log()
  return { missing: missing.length, stillEn: stillEn.length, installed: true }
}

const r1 = report(
  '前端界面',
  join(RES, FRONTEND_I18N, 'en-US.json'),
  join(RES, FRONTEND_I18N, 'zh-CN.json'),
)

const desktopEn = join(RES, 'en-US.json')
const desktopZh = join(RES, 'zh-CN.json')
let r2 = { missing: 0, stillEn: 0, installed: false }
if (existsSync(desktopEn)) {
  r2 = report('桌面外壳', desktopEn, desktopZh)
}

// 白名单状态。语言代码不在 Claude 硬编码的支持列表里，语言文件存在也不会生效，
// 所以这一步必须一起报，否则用户会以为"文件在就是好了"。
const wlFiles = findWhitelistFiles(RES)
console.log('【语言白名单】')
if (wlFiles.length === 0) {
  console.log('  状态          : 没找到白名单文件（可能 Claude 版本结构变了）')
} else {
  for (const f of wlFiles) {
    console.log(`  ${f.hasZh ? '✔ 已包含 zh-CN' : '✘ 缺少 zh-CN'}  ${f.file}`)
  }
}
console.log()

const notInstalled = !r1.installed || !r2.installed
const wlMissing = wlFiles.some((f) => !f.hasZh)

console.log('────────────────────────────────────────')
if (notInstalled) {
  console.log('结论：还没有安装中文（或语言文件被重装清掉了）。')
  console.log('      双击 一键安装中文.bat 即可安装。')
} else if (wlMissing || r1.missing > 0 || r2.missing > 0) {
  console.log(`结论：还差一点 —— 白名单${wlMissing ? '缺 zh-CN' : '正常'}，${r1.missing + r2.missing} 条缺键。`)
  console.log('      双击 一键安装中文.bat 即可补全。')
} else {
  console.log('结论：中文界面已完整，无需再做任何操作。')
}
console.log('────────────────────────────────────────')
