// 显示优化:从 cordis.patch.yml 移除挂载条目(幂等,还原为加块前状态)
// 用法: node patch-remove.cjs <cordis.patch.yml 路径>
const fs = require('fs')
const path = process.argv[2]
if (!path) { console.error('usage: node patch-remove.cjs <patch.yml>'); process.exit(2) }
let c = fs.readFileSync(path, 'utf8')
const re = /\n# 余额实时查询小窗口\(常驻\):[^\n]*\n- insert:\n    - id: uiopt\n      name: uiopt\n      config: \{\}\n?/
if (!re.test(c)) { console.log('patch: entry not found, skip'); process.exit(0) }
fs.writeFileSync(path, c.replace(re, '\n').trimEnd() + '\n')
console.log('patch: entry removed')
