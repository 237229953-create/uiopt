# uiopt(显示优化)卸载脚本(幂等;会备份 cordis.patch.yml)
# 用法: powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-ProfilePath C:\...\profiles\web]
param(
    [string]$ProfilePath = "$env:USERPROFILE\.dsh\profiles\web"
)
$ErrorActionPreference = 'Stop'
$pkgName = 'uiopt'
$src = $PSScriptRoot
$dest = Join-Path $ProfilePath "node_modules\$pkgName"
$patch = Join-Path $ProfilePath 'cordis.patch.yml'

# 1) 备份并移除挂载条目
if (Test-Path $patch) {
    Copy-Item $patch ($patch + '.bak') -Force
    Write-Host "[1/3] 已备份 cordis.patch.yml -> cordis.patch.yml.bak"
    $node = (Get-Command node -ErrorAction Stop).Source
    & $node (Join-Path $src 'patch-remove.cjs') $patch
    if ($LASTEXITCODE -ne 0) { throw '移除挂载条目失败' }
}

# 2) 删除插件目录
if (Test-Path $dest) {
    Remove-Item $dest -Recurse -Force
    Write-Host "[2/3] 已删除 $dest"
} else {
    Write-Host '[2/3] 插件目录不存在,跳过'
}

# 3) 提示余额状态文件
$state = Join-Path $ProfilePath 'balance-state.json'
Write-Host "[3/3] 卸载完成。余额差值累计状态: $state"
Write-Host '      (如不再需要,可手动删除该文件;重启 dsh 后插件即完全移除)'
