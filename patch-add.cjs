// 显示优化:向 cordis.patch.yml 追加/移除挂载条目(幂等)
// 用法: node patch-add.cjs <cordis.patch.yml 路径>
const fs = require('fs')
const path = process.argv[2]
if (!path) { console.error('usage: node patch-add.cjs <patch.yml>'); process.exit(2) }
const marker = '- id: uiopt'
let c = fs.readFileSync(path, 'utf8')
if (c.includes(marker)) { console.log('patch: already present, skip'); process.exit(0) }
const entry = '\n# 余额实时查询小窗口(常驻):宿主路由 /api/dsh-balance + 输入框下方余额卡\n- insert:\n    - id: uiopt\n      name: uiopt\n      config: {}\n'
fs.writeFileSync(path, c.trimEnd() + '\n' + entry)
console.log('patch: entry appended')
