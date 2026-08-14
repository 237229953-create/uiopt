# uiopt(显示优化)安装脚本
# 官方方式: dsh plugin --profile web add <本目录>(pnpm link,改代码即生效,无需本脚本)
# 兼容方式(无 pnpm/老环境): 本脚本拷贝 + patch 挂载
# 用法: powershell -ExecutionPolicy Bypass -File install.ps1 [-ProfilePath C:\...\profiles\web]
param(
    [string]$ProfilePath = "$env:USERPROFILE\.dsh\profiles\web"
)
$ErrorActionPreference = 'Stop'
$pkgName = 'uiopt'
$src = $PSScriptRoot
$dest = Join-Path $ProfilePath "node_modules\$pkgName"
$patch = Join-Path $ProfilePath 'cordis.patch.yml'
$pkgJson = Join-Path $ProfilePath 'package.json'

if (-not (Test-Path (Join-Path $src 'lib\index.js'))) { throw "未找到插件源码: $src" }
if (-not (Test-Path $patch)) { throw "profile 不存在或无 cordis.patch.yml: $ProfilePath" }

# 0) 官方 bundle 方式检测:profile 的 dsh.profile.bundles 已含 uiopt → 改代码直接生效,无需拷贝/patch
if (Test-Path $pkgJson) {
    try {
        $pf = Get-Content $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json
        $bundles = @($pf.dsh.profile.bundles)
        if ($bundles -contains $pkgName) {
            Write-Host "[OK] 已通过官方方式安装(dsh plugin add, bundle=$pkgName):"
            Write-Host "     改代码直接生效(桌面目录 = profile 链接),无需本脚本。"
            Write-Host "     如加载异常,先跑 'dsh plugin --profile web remove $pkgName' 再 'dsh plugin --profile web add 本目录'。"
            exit 0
        }
    } catch {
        # 解析失败按兼容路径继续
    }
}

# 1) 拷贝插件包(兼容方式)
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'lib') | Out-Null
Copy-Item (Join-Path $src 'package.json') (Join-Path $dest 'package.json') -Force
Copy-Item (Join-Path $src 'lib\index.js')  (Join-Path $dest 'lib\index.js') -Force
Copy-Item (Join-Path $src 'lib\client.js') (Join-Path $dest 'lib\client.js') -Force
Write-Host "[1/3] 插件包已拷贝到 $dest"

# 2) 确保挂载条目存在(幂等)
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $src 'patch-add.cjs') $patch
if ($LASTEXITCODE -ne 0) { throw '追加挂载条目失败' }

# 3) YAML 校验(js-yaml 从 profile 的 node_modules 解析)
$jsYaml = Join-Path $ProfilePath 'node_modules\js-yaml'
if (-not (Test-Path $jsYaml)) { $jsYaml = "$env:USERPROFILE\.dsh\profiles\node_modules\js-yaml" }
& $node -e "const y=require(process.argv[1]);const fs=require('fs');y.load(fs.readFileSync(process.argv[2],'utf8'));console.log('YAML OK')" $jsYaml $patch
if ($LASTEXITCODE -ne 0) { throw 'cordis.patch.yml 校验失败' }

Write-Host '[3/3] 安装完成。请重启 dsh(Ctrl+C → dsh web)后生效。'
