# 显示优化

DSH(DeepSeek Harness)WebUI 常驻插件:**余额实时查询小窗口 + 会话/每条消息消耗 + 提供商图标**。

一个自包含插件包,含宿主半(同源路由代理)与客户端半(手写 ModuleLoader bundle),安装后不依赖任何额外运行时。

## 功能

| 功能 | 位置 | 说明 |
|---|---|---|
| 账户余额 | 输入框下方常驻条 | deepseek-official 走官方 `GET /user/balance`(CNY);opencode-go 为订阅制,显示用量限制说明 |
| 本会话已用 | 同上(加粗) | **余额真实扣费减法**:起点余额 − 当前余额累计,持久化在 `profiles/web/balance-state.json`,充值不丢已消耗 |
| 每条消息消耗 | 每条 assistant 消息统计行 | `· 本条 ¥x.xxxx · 缓存 xx%`,宿主逐条精确计价(按消息真实 provider/model),附缓存命中率 |
| 提供商图标 | 模型选择器左侧 | DeepSeek 小鲸鱼(官方 favicon 路径,自绘内联 SVG)/ OpenCode Go 大写 G;订阅共享模型目录 store,切换即时更新 |
| 自主添加插件标签页 | 设置 → 插件 | 第三个标签页(格式与前两个"插件配置/插件清单"一致),列出用户自主安装的非官方插件;数据源:宿主 `/api/dsh-plugins`(loader 过滤) |
| 导入插件 | 设置 → 插件 → 额外插件页顶部 | “导入插件”按钮 → 选择 `.zip` 插件包 → 上传到宿主 `/api/dsh-plugin-import` → 解压、校验包名、复制到 `<profile>/node_modules/<name>/` 并追加 `cordis.patch.yml` 挂载条目(幂等,已存在则跳过);安装后需重启 dsh 生效 |

## 文件结构

```
显示优化/
├── package.json          # 包声明(name: uiopt)dsh.client 注入依赖
├── lib/
│   ├── index.js          # Host 半:GET /api/dsh-balance、/api/dsh-context、/api/dsh-plugins、POST /api/dsh-plugin-import(插件导入:解压+校验+安装+挂载)
│   └── client.js         # Client 半:手写 ModuleLoader bundle(5 个插槽注入,含额外插件页的“导入插件”按钮)
└── README.md
```

### 客户端注入的插槽

- `conversation.composer.dock` — 余额卡(id: balance)
- `conversation.chat.assistant-actions` — 每条消息消耗 + 缓存命中率(id: balance-cost)
- `conversation.input.right` — 提供商图标(id: provider-icon)

## 安装 / 更新

### 官方方式(推荐,dsh plugin + pnpm link)

本包声明了 `dsh.bundle` manifest,是标准组合包(bundle)。安装到任意 profile:

```sh
dsh plugin --profile web add <本目录绝对路径>
# 或分发形式(tarball / GitHub / npm):
dsh plugin --profile web add ./uiopt-1.0.0.tgz
dsh plugin --profile web add github:you/uiopt#<sha>
dsh plugin --profile web add uiopt
```

pnpm 会把包 **link** 进 profile(不是拷贝),并在 `package.json` 的 `dsh.profile.bundles` 注册组合层;包自带的 `cordis.patch.yml` 负责挂载 `uiopt` 行。**改代码直接生效,无需任何同步脚本。** 卸载:`dsh plugin --profile web remove uiopt`。

> 依赖 `pnpm`(dsh plugin 在 profile 目录内转发给 pnpm)。`dsh.bundle` 声明见 package.json;打包分发:`pnpm pack` 生成 `uiopt-<ver>.tgz`。

### 兼容方式(无 pnpm 的老环境,拷贝 + patch)

一键脚本(幂等,重复执行安全;若检测到已用官方方式安装则直接跳过):

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

脚本做的事:
1. 把 `lib/` 与 `package.json` 拷贝到 `<profile>\node_modules\uiopt\`;
2. 若 `cordis.patch.yml` 缺少挂载条目,自动追加:

```yaml
- insert:
    - id: uiopt
      name: uiopt
      config: {}
```

手动安装(等价):
1. 拷贝本目录到 `<profile>\node_modules\uiopt\`;
2. 在 `<profile>\cordis.patch.yml` 追加上述条目;
3. 重启 dsh(`Ctrl+C` → `dsh web`)。

> 默认 profile 路径为 `C:\Users\86191\.dsh\profiles\web`,可用 `-ProfilePath` 参数覆盖。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

脚本删除插件目录与 `cordis.patch.yml` 中的挂载条目(备份 patch 为 `cordis.patch.yml.bak`),并提示手动删除 `balance-state.json`(余额差值累计状态,删掉则重新从零累计)。重启 dsh 生效。

## 配置与凭据

- 无需插件配置;凭据复用 dsh 凭据服务:
  - `DEEPSEEK_API_KEY`(deepseek-official 余额)
  - `OPENCODE_GO_API_KEY`(opencode-go 订阅)
- API Key 只在宿主进程解析与使用,浏览器只访问无凭据的同源路由 `/api/dsh-balance`。

## 计价口径(重要)

- **会话消耗(余额卡)**:deepseek-official 为账户余额真实扣费(减法);opencode-go 无余额接口,退化为按量估算(USD)。
- **每条消息消耗**:按量估算(usage × 单价表),DeepSeek 官方峰谷价(CNY,北京时间 9-12 / 14-18 翻倍)与 OpenCode Go 网关价(USD,内置 16 模型)。因此"每条之和"与"本会话已用"是两个口径,不等属正常。
- **缓存命中率**:`cacheReadTokens / (input + cacheRead + cacheWrite)`。
- 单价表随官方价格变动需人工更新(`PRICING` 常量,host 与 client 各一份,需同步修改)。

## 已知限制

1. OpenCode Go 为订阅制,官方无公开余额接口,只能显示限制说明与控制台指引;
2. 余额减法反映**账户整体扣费**:其他会话/窗口共用同一 API Key 的消耗也会计入;
3. 动态注册/注销模型工具(如调试插件)会使 DeepSeek 前缀缓存整段失效,造成单次全量计费——与插件本身无关;
4. 客户端 bundle 为手写 `window.__ModuleLoader__.load(...)` 格式,修改时保持该结构。

## 开发注意事项(踩坑记录,改代码前必读)

1. **保存 JSON/JS 文件必须用 UTF-8 无 BOM**:带 BOM 的 `package.json` 会让 dsh 的 `JSON.parse` 直接崩溃(插件树加载失败 → 服务异常/页面白屏)。PowerShell 的 `Set-Content -Encoding UTF8` 在 PS 5.1 下会写 BOM——如需用 PowerShell 写文件,改用 `[System.IO.File]::WriteAllText($p, $c, (New-Object System.Text.UTF8Encoding($false)))`,或用 Node 脚本。
2. **slot 冲突检测用 `priority` 字段,不是 `order`**:`order` 只控制渲染顺序;同 `id` 注册覆盖官方条目时,官方 `priority` 为 0,覆盖方必须用 **`priority: -1`**,否则同 id 同 priority 冲突导致插件加载失败。当前 `configurable` 与 `all` 两个替换注册已带 `priority: -1`。
3. **子 slot 只能声明一次**:插件注册时不要用 `children` 重复声明官方已声明的子 slot(如 `settings.plugin.item`),否则 "already declared" 冲突。替换官方标签页时,子 slot 由官方声明,插件只注册条目、不写 `children`。
4. 本目录(`D:\dsh-plugins\uiopt\`)是唯一源码;已用官方方式安装(`dsh plugin add`,pnpm link),**改代码直接生效**,无需任何同步脚本。若退回兼容方式(install.ps1 拷贝),才需要"改完工作区文件后跑 install.ps1、不要直接改 profile 文件"。
5. **link 安装模式的三条约定**(本机 `dsh plugin add <本目录>` 才会遇到;别人用 tgz/GitHub 安装由 pnpm 自动装依赖,不受影响):
   - `lib/client.js` 里 `window.__ModuleLoader__.load({ id: ... })` 的 `id` **必须等于插件名 `uiopt`**,否则报 "Failed to load plugins"(模块注册不上)。
   - 依赖用 **`npm install` 装成实体目录**(本项目 `node_modules` 已装好,@deepseek-ai/dsh-credentials 等 6 个包)。**绝不要再建 junction**——发生过事故:junction 指向 dsh 主包依赖,`Remove-Item -Recurse` 删除含 junction 的目录时**跟随链接删掉了主包的 dsh-credentials**,导致官方插件链断裂、服务起不来。
   - 项目路径**不要带空格**:pnpm 会把 `D:\dsh plugins\uiopt` 按空格拆成两个错误依赖(`link:D:/dsh` + `plugins\uiopt`)。路径必须是 `D:\dsh-plugins\uiopt` 这种无空格形式。
   - 卸载/清理一律用官方命令 `dsh plugin --profile web remove uiopt`;手工删目录时,junction 用 `cmd /c rmdir <链接>`(只删链接),普通目录才用 `Remove-Item -Recurse`。

## 版本历史

- 1.0.0 初始版:余额卡(多 provider)、会话消耗(余额减法)、每消息消耗+缓存命中率、提供商图标(官方鲸鱼路径)、README/安装脚本。
- 1.1.0 新增“导入插件”:设置 → 插件 → 额外插件页顶部的“导入插件”按钮,选择 `.zip` 插件包上传到宿主 `POST /api/dsh-plugin-import`,解压、严格校验包名、复制到 `<profile>/node_modules/<name>/` 并追加挂载条目(幂等),安装后需重启 dsh 生效。
