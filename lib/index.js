/**
 * 显示优化 — Host 半
 *
 * 注册同源路由 GET /api/dsh-balance:
 * - 按当前模型 provider 分派余额查询:
 *   · deepseek-official → DeepSeek 官方 GET https://api.deepseek.com/user/balance(CNY)
 *   · opencode-go      → 订阅制,无公开余额接口,返回用量限制说明(USD)
 * - 会话消耗:扫 assistant/message 事件的 usage,按每条消息的 provider/model
 *   查内置单价表(DeepSeek 官方峰谷价 / OpenCode Go 网关价)逐条计价。
 * API Key 只存在于宿主进程,绝不进入浏览器。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  cpSync,
  statSync,
  existsSync,
  renameSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'

export const name = '显示优化'
export const inject = ['webServer', 'credentials']

/**
 * 单价表(元或美元 / 百万 tokens)。
 * deepseek-official:官方峰谷价,peak=true 时高峰(北京时间 9-12、14-18)翻倍。
 * opencode-go:OpenCode Zen Go 网关价(美元,来自 pi-ai 模型目录,无峰谷)。
 */
const PRICING = {
  'deepseek-official': {
    'deepseek-v4-flash': { input: 1, cache: 0.02, output: 2, peak: true, currency: 'CNY' },
  },
  'opencode-go': {
    'deepseek-v4-flash': { input: 0.14, cache: 0.0028, output: 0.28, peak: false, currency: 'USD' },
    'deepseek-v4-pro': { input: 0.435, cache: 0.003625, output: 0.87, peak: false, currency: 'USD' },
    'glm-5.1': { input: 1.4, cache: 0.26, output: 4.4, peak: false, currency: 'USD' },
    'glm-5.2': { input: 1.4, cache: 0.26, output: 4.4, peak: false, currency: 'USD' },
    'hy3': { input: 0.14, cache: 0.035, output: 0.58, peak: false, currency: 'USD' },
    'kimi-k2.6': { input: 0.95, cache: 0.16, output: 4, peak: false, currency: 'USD' },
    'kimi-k2.7-code': { input: 0.95, cache: 0.19, output: 4, peak: false, currency: 'USD' },
    'kimi-k3': { input: 3, cache: 0.3, output: 15, peak: false, currency: 'USD' },
    'mimo-v2.5': { input: 0.14, cache: 0.0028, output: 0.28, peak: false, currency: 'USD' },
    'mimo-v2.5-pro': { input: 0.435, cache: 0.003625, output: 0.87, peak: false, currency: 'USD' },
    'minimax-m2.7': { input: 0.3, cache: 0.06, output: 1.2, peak: false, currency: 'USD' },
    'minimax-m3': { input: 0.3, cache: 0.06, output: 1.2, peak: false, currency: 'USD' },
    'qwen3.6-plus': { input: 0.5, cache: 0.05, output: 3, peak: false, currency: 'USD' },
    'qwen3.7-max': { input: 2.5, cache: 0.5, output: 7.5, peak: false, currency: 'USD' },
    'qwen3.7-plus': { input: 0.4, cache: 0.04, output: 1.6, peak: false, currency: 'USD' },
    'grok-4.5': { input: 2, cache: 0.5, output: 6, peak: false, currency: 'USD' },
  },
}

const DEFAULT_CURRENCY = 'CNY'

/** 模型上下文窗口容量缓存(provider|model → contextWindow),避免每次刷新都调 resolveModelInfo。 */
const CONTEXT_WINDOW_CACHE = new Map()

/**
 * 余额差值计费:持久化每个会话最近一次查询到的余额,会话消耗 = 起点余额 − 当前余额(累计)。
 * 中途充值/余额增加不丢弃已累计消耗(区间差为负时只更新锚点);文件存于 profile 目录。
 */
const BALANCE_STATE_PATH = (process.env.DSH_HOME || 'C:\\Users\\86191\\.dsh') + '\\profiles\\web\\balance-state.json'

function readBalanceState() {
  try {
    return JSON.parse(readFileSync(BALANCE_STATE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function writeBalanceState(state) {
  try {
    writeFileSync(BALANCE_STATE_PATH, JSON.stringify(state, null, 2))
  } catch {
    /* 持久化失败不影响余额展示 */
  }
}

/**
 * 每条消息的余额差计费:每次查询(回合结束后触发)时,若自上次查询以来出现了新的
 * assistant 消息,则"上次余额 − 本次余额"即该条消息的真实消耗,记入 perMessage。
 * 会话总额 = 各条消息之和。首次查询仅建立锚点(消耗 0)。状态持久化在 profile 目录。
 */
function advanceBalanceCost(state, sessionId, currentTotal, currency, latestMsgId, estH, model) {
  const prev = state[sessionId]
  const perMessage = prev && prev.perMessage && typeof prev.perMessage === 'object' ? prev.perMessage : {}
  // msgId 只在"绑定成功"时推进:余额尚未扣减(delta<=0)时保持旧锚点,后续查询可重试绑定同一条消息
  let nextMsgId = prev && prev.msgId ? prev.msgId : (latestMsgId || null)
  if (prev && typeof prev.last === 'number' && latestMsgId && prev.msgId !== latestMsgId) {
    const delta = Math.round((prev.last - currentTotal) * 100) / 100
    if (delta > 0) {
      const old = perMessage[latestMsgId]
      perMessage[latestMsgId] = {
        a: Math.round(((old && typeof old.a === 'number' ? old.a : 0) + delta) * 100) / 100,
        c: currency || DEFAULT_CURRENCY,
        ...(estH !== null && estH !== undefined ? { h: estH } : {}),
        ...(model ? { m: model } : (old && old.m ? { m: old.m } : {})),
      }
      nextMsgId = latestMsgId
    }
  }
  let acc = 0
  for (const k of Object.keys(perMessage)) {
    const e = perMessage[k]
    if (e && typeof e.a === 'number') acc += e.a
  }
  state[sessionId] = { last: currentTotal, msgId: nextMsgId, perMessage, at: Date.now() }
  return { acc: Math.round(acc * 100) / 100, perMessage }
}

function isPeak(ms) {
  const h = (new Date(ms).getUTCHours() + 8) % 24
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** 按 provider/model/时刻计价;未知模型返回 null。 */
function costOfUsage(usage, provider, model, ms) {
  const table = PRICING[provider]
  const spec = table ? table[model] : undefined
  if (!spec) return null
  const p = spec.peak && isPeak(ms)
    ? { input: spec.input * 2, cache: spec.cache * 2, output: spec.output * 2 }
    : { input: spec.input, cache: spec.cache, output: spec.output }
  const inT = num(usage.inputTokens)
  const cacheT = num(usage.cacheReadTokens)
  const writeT = num(usage.cacheWriteTokens)
  const outT = num(usage.outputTokens)
  // cacheWrite 无独立价时按普通输入价近似
  return {
    amount: (inT * p.input + cacheT * p.cache + writeT * p.input + outT * p.output) / 1e6,
    currency: spec.currency || DEFAULT_CURRENCY,
  }
}

/** 扫会话日志 assistant/message 事件的 usage,按消息的 provider/model 逐条计价;同时返回逐条明细与最新消息 id。 */
async function sessionCost(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return { amount: null, currency: DEFAULT_CURRENCY, perMessage: null, latestMsgId: null }
  try {
    const loaded = await persistence.readFrom(sessionId, 0)
    let total = 0
    let currency = DEFAULT_CURRENCY
    const perMessage = {}
    let latestMsgId = null
    let latestProvider = null
    let latestModel = null
    if (loaded && Array.isArray(loaded.events)) {
      for (const ev of loaded.events) {
        if (ev && ev.type === 'assistant/message' && ev.data) {
          const msg = ev.data.message
          const id = msg && typeof msg.id === 'string' && msg.id.length > 0 ? msg.id : ''
          if (id) latestMsgId = id
          const provider = msg && msg.source && typeof msg.source.provider === 'string' ? msg.source.provider : ''
          const model = msg && msg.source && typeof msg.source.model === 'string' ? msg.source.model : ''
          if (provider) latestProvider = provider
          if (model) latestModel = model
          if (ev.data.usage) {
            const priced = costOfUsage(ev.data.usage, provider, model, typeof ev.time === 'number' ? ev.time : Date.now())
            if (priced) {
              total += priced.amount
              currency = priced.currency
              if (id) {
                const u = ev.data.usage
                const inT = num(u.inputTokens)
                const cacheT = num(u.cacheReadTokens)
                const writeT = num(u.cacheWriteTokens)
                const d = inT + cacheT + writeT
                perMessage[id] = {
                  a: Math.round(priced.amount * 10000) / 10000,
                  c: priced.currency,
                  h: d > 0 ? Math.round((cacheT / d) * 1000) / 10 : 0,
                  m: model || '',
                }
              }
            }
          }
        }
      }
    }
    return { amount: total, currency, perMessage, latestMsgId, latestProvider, latestModel }
  } catch {
    return { amount: null, currency: DEFAULT_CURRENCY, perMessage: null, latestMsgId: null, latestProvider: null, latestModel: null }
  }
}

/** 当前模型 provider(默认 deepseek-official)。 */
function currentProvider(ctx) {
  try {
    const adm = ctx.get('agentDefaultModel')
    const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : undefined
    if (sel && typeof sel.provider === 'string' && sel.provider.length > 0) return sel.provider
  } catch {
    /* fall through */
  }
  return 'deepseek-official'
}

async function deepseekBalance(ctx) {
  const hit = await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))
  const key = hit && typeof hit.value === 'string' && hit.value.length > 0 ? hit.value : ''
  if (!key) {
    return { ok: false, errorCode: 'MISSING_API_KEY', error: '请先输入 DeepSeek API Key(设置 → 模型 页面)' }
  }
  const resp = await fetch('https://api.deepseek.com/user/balance', {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  })
  const json = await resp.json()
  const infos = Array.isArray(json.balance_infos)
    ? json.balance_infos.map((b) => ({
        currency: String(b.currency || ''),
        total: String(b.total_balance || ''),
        granted: String(b.granted_balance || ''),
        toppedUp: String(b.topped_up_balance || ''),
      }))
    : []
  return { ok: true, isAvailable: !!json.is_available, infos }
}

/** OpenCode Go 用量查询(官方未文档化端点):GET /zen/go/v1/usage,返回 5h/周/月 已用百分比与重置时间。 */
async function opencodeUsage(ctx) {
  const hit = await ctx.credentials.resolve(credentialRef('OPENCODE_GO_API_KEY'))
  const key = hit && typeof hit.value === 'string' && hit.value.length > 0 ? hit.value : ''
  if (!key) {
    return { ok: false, errorCode: 'MISSING_API_KEY', error: '请先输入 OpenCode API Key(设置 → 模型 页面)' }
  }
  try {
    const resp = await fetch('https://opencode.ai/zen/go/v1/usage', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) {
      const text = (await resp.text()).slice(0, 200)
      return { ok: false, error: `OpenCode 用量接口请求失败 (HTTP ${resp.status})` + (text ? ': ' + text : '') }
    }
    const json = await resp.json()
    const u = json && typeof json === 'object' ? json.usage : null
    const norm = (w) => (w && typeof w === 'object'
      ? {
          percent: typeof w.percent === 'number' ? Math.round(w.percent * 10) / 10 : null,
          resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
        }
      : null)
    return {
      ok: true,
      usage: u ? { rolling: norm(u.rolling), weekly: norm(u.weekly), monthly: norm(u.monthly) } : null,
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
}

/**
 * ---------------- 插件导入(设置 → 插件 → 额外插件 → 导入插件) ----------------
 *
 * Profile 目录:插件本包安装在 <profile>/node_modules/显示优化/lib/index.js,
 * import.meta.url 向上三级即 profile 根(dirname=lib → ..显示优化 → ..node_modules → ..profile)。
 * 这样无论 profile 名如何都能正确定位,不依赖写死的 "web"。
 * 临时文件与安装目标均基于此目录。
 */
const IMPORT_PROFILE_DIR = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))
/** 导入互斥锁:同一时间只允许一个导入任务,防止并发双导入互相覆盖/写坏 patch。 */
let importBusy = false
/** 追加导入插件的 mount 条目到 cordis.patch.yml(幂等,UTF-8 无 BOM,遵循 patch-add.cjs 的写法)。 */
function appendPatchMount(patchFile, name) {
  // 整行匹配 + 大小写不敏感:避免子串误判(- id: foo 命中 foobar),也避免大小写变体重复挂载
  const re = new RegExp('^\\s*-\\s*id:\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'im')
  let c = readFileSync(patchFile, 'utf8')
  if (re.test(c)) return false
  const entry = '\n# 通过“设置 → 插件 → 导入插件”自动安装的插件\n- insert:\n    - id: ' + name + '\n      name: ' + name + '\n      config: {}\n'
  writeFileSync(patchFile, c.trimEnd() + '\n' + entry)
  return true
}

/** 追加后 YAML 校验(与 install.ps1 同源:js-yaml 从 profile node_modules 引导);返回错误串或 null(不可用 js-yaml 时跳过)。 */
function validatePatchYaml(patchFile) {
  const candidates = [
    path.join(IMPORT_PROFILE_DIR, 'node_modules', 'js-yaml'),
    path.join(path.dirname(IMPORT_PROFILE_DIR), 'node_modules', 'js-yaml'),
  ]
  let jsYaml = null
  for (const c of candidates) {
    try {
      if (existsSync(path.join(c, 'package.json'))) { jsYaml = c; break }
    } catch { /* ignore */ }
  }
  if (!jsYaml) return null
  try {
    const require = createRequire(import.meta.url)
    require(jsYaml).load(readFileSync(patchFile, 'utf8'))
    return null
  } catch (e) {
    return String(e && e.message ? e.message : e)
  }
}

/** 递归拷贝目录(src → dest),跳过 dest 自身与 .tmp/隐藏临时目录。 */
function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.tmp-')) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirRecursive(s, d)
    else if (entry.isFile()) copyFileSync(s, d)
  }
}

/** 校验读取解压后包内的 package.json name,通过 → 返回 {name};否则 {error}。 */
function validatePluginName(unpackDir, topName) {
  const pkgPath = path.join(unpackDir, 'package.json')
  if (!existsSync(pkgPath)) return { error: '未在插件包中找到 package.json(请确认 zip 内含插件包清单)' }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (e) {
    return { error: '插件包 package.json 解析失败: ' + String(e && e.message ? e.message : e) }
  }
  const raw = pkg && typeof pkg.name === 'string' ? pkg.name.trim() : ''
  // 严格白名单 + 拒绝路径穿越/点目录(含单点 ".",防止解析到目录自身)/系统保留名(Windows CON/NUL/COM1 等)
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
  if (!raw || !/^[A-Za-z0-9._-]+$/.test(raw) || raw.includes('..') || raw.includes('/') || raw.includes('\\') || raw === '.' || reserved.test(raw)) {
    return { error: '插件包名非法:必须为字母/数字/._- 组合,且不含路径分隔符、.. 或系统保留名' }
  }
  return { name: raw, topName }
}

/** 读 POST 请求 JSON body(限制长度,防止超大 zip 转 base64 泛洪)。 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(new Error('请求体不是合法 JSON: ' + String(e && e.message ? e.message : e)))
      }
    })
    req.on('error', reject)
  })
}

/** 用系统 PowerShell Expand-Archive 解压 zip 到 dest(Windows 自带)。解压前先校验条目名,拒绝 zip-slip(../ 或绝对路径)。 */
async function unzipViaPowershell(ctx, zipPath, dest) {
  const sub = ctx.get('subprocess')
  if (sub === undefined || typeof sub.spawn !== 'function') {
    return { ok: false, error: '宿主无 subprocess 服务,无法解压' }
  }
  let resolved = null
  const candidates = ['powershell', 'powershell.exe', 'pwsh']
  for (const c of candidates) {
    try {
      const r = await sub.resolveExecutable(c)
      if (typeof r === 'string' && r.length > 0) { resolved = r; break }
    } catch {
      /* try next */
    }
  }
  if (resolved === null) return { ok: false, error: '未找到 PowerShell(无法解压 zip)' }
  const q = (s) => String(s).replace(/'/g, "''")
  const script = 'Add-Type -AssemblyName System.IO.Compression.FileSystem;' +
    "$zip = [System.IO.Compression.ZipFile]::OpenRead('" + q(zipPath) + "');" +
    'try { foreach ($e in $zip.Entries) {' +
    " $n = $e.FullName -replace '/', '\\';" +
    " if ($n -like '*\\..\\*' -or $n -like '..\\*' -or $n -eq '..' -or $n.StartsWith('\\') -or ($n -match '^[A-Za-z]:')) { exit 87 } } }" +
    ' finally { $zip.Dispose() };' +
    "Expand-Archive -LiteralPath '" + q(zipPath) + "' -DestinationPath '" + q(dest) + "' -Force"
  try {
    const handle = sub.spawn({
      argv: [resolved, '-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
      cwd: IMPORT_PROFILE_DIR,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      graceMs: 30000,
    })
    const outcome = await handle.done
    if (outcome && outcome.exitCode !== 0 && outcome.exitCode !== null) {
      let msg = '解压失败(code=' + outcome.exitCode + ')'
      if (outcome.exitCode === 87) msg = '插件包包含非法路径(疑似路径穿越),已拒绝'
      try {
        const err = handle.collected && handle.collected.stderr
        if (err) {
          const t = err.readFrom(0).text
          if (t && t.trim()) msg += ': ' + t.trim().slice(0, 300)
        }
      } catch { /* ignore */ }
      return { ok: false, error: msg }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: '解压异常: ' + String(e && e.message ? e.message : e) }
  }
}

/** 用系统 tar(Windows 10+ 自带 bsdtar)解压 tgz 到 dest。先列出条目校验,拒绝 zip-slip(../ 或绝对路径)。 */
async function unzipViaTar(ctx, tgzPath, dest) {
  const sub = ctx.get('subprocess')
  if (sub === undefined || typeof sub.spawn !== 'function') {
    return { ok: false, error: '宿主无 subprocess 服务,无法解压' }
  }
  let resolved = null
  const candidates = ['tar', 'tar.exe', 'C:\\Windows\\System32\\tar.exe']
  for (const c of candidates) {
    try {
      const r = await sub.resolveExecutable(c)
      if (typeof r === 'string' && r.length > 0) { resolved = r; break }
    } catch {
      /* try next */
    }
  }
  if (resolved === null) return { ok: false, error: '未找到 tar(无法解压 .tgz)' }
  const runTar = async (args) => {
    const handle = sub.spawn({
      argv: [resolved, ...args],
      cwd: IMPORT_PROFILE_DIR,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 2 * 1024 * 1024 }, stderr: { maxBytes: 65536 } },
      graceMs: 30000,
    })
    const outcome = await handle.done
    const text = () => {
      try {
        const o = handle.collected && handle.collected.stdout
        return o ? o.readFrom(0).text : ''
      } catch { return '' }
    }
    return { code: outcome && outcome.exitCode, text }
  }
  try {
    // 1) 列出条目,校验路径安全(zip-slip 防护)
    const list = await runTar(['-tzf', tgzPath])
    if (list.code !== 0 && list.code !== null) {
      return { ok: false, error: '读取 tgz 失败(code=' + list.code + ')' }
    }
    const entries = (list.text() || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    for (const e of entries) {
      const n = e.replace(/\\/g, '/')
      if (n === '..' || n.startsWith('../') || n.includes('/../') || n.startsWith('/') || /^[A-Za-z]:/.test(n)) {
        return { ok: false, error: '插件包包含非法路径(疑似路径穿越),已拒绝' }
      }
    }
    // 2) 解压到 dest
    const x = await runTar(['-xzf', tgzPath, '-C', dest])
    if (x.code !== 0 && x.code !== null) {
      return { ok: false, error: '解压 tgz 失败(code=' + x.code + ')' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: '解压异常: ' + String(e && e.message ? e.message : e) }
  }
}

/** 插件源码目录与热更新状态文件(通过 pnpm link 的 junction 路径写,实际落在 D:\dsh-plugins\uiopt)。 */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPDATE_STATE_PATH = path.join(PLUGIN_DIR, '.update-state.json')
/** GitHub 仓库(发布源)。 */
const GITHUB_REPO = '237229953-create/uiopt'

function readUpdateState() {
  try {
    return JSON.parse(readFileSync(UPDATE_STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

function writeUpdateState(state) {
  try {
    writeFileSync(UPDATE_STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
  } catch {
    /* 状态写入失败不影响更新 */
  }
}

/** 取 GitHub master 最新提交(sha + 时间);失败返回 null。 */
async function fetchLatestCommit() {
  try {
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/master`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'uiopt-updater' },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return null
    const j = await resp.json()
    return {
      sha: j && typeof j.sha === 'string' ? j.sha : null,
      date: j && j.commit && j.commit.committer && j.commit.committer.date ? j.commit.committer.date : null,
    }
  } catch {
    return null
  }
}

export function apply(ctx) {
  // 每条 assistant 消息完成后自动绑定余额差(不依赖客户端查询时机,保证最新消息也有真实值)
  ctx.on('session/event', (session, event) => {
    if (!event) return
    const sessionId = session && typeof session.id === 'string' ? session.id : null
    if (!sessionId) return
    // 用户发消息时先刷新锚点:AI 回复完成后的差值即该回复的真实消耗(新会话第一条消息也能准确)
    if (event.type === 'user/message') {
      setTimeout(async () => {
        try {
          const balance = await deepseekBalance(ctx)
          if (!balance.ok || !balance.infos || balance.infos.length === 0) return
          const total = Number.parseFloat(balance.infos[0].total)
          if (!Number.isFinite(total)) return
          const state = readBalanceState()
          // latestMsgId 传 null:只刷新 last 锚点,不绑定、不推进 msgId
          advanceBalanceCost(state, sessionId, total, balance.infos[0].currency || DEFAULT_CURRENCY, null, null)
          writeBalanceState(state)
        } catch (e) {
          /* ignore */
        }
      }, 1000)
      return
    }
    if (event.type !== 'assistant/message') return
    const msg = event.data && event.data.message
    const msgId = msg && typeof msg.id === 'string' ? msg.id : null
    if (!msgId) return
    const model = msg && msg.source && typeof msg.source.model === 'string' ? msg.source.model : ''
    const u = event.data && event.data.usage
    const inT = u ? num(u.inputTokens) : 0
    const cacheT = u ? num(u.cacheReadTokens) : 0
    const writeT = u ? num(u.cacheWriteTokens) : 0
    const d = inT + cacheT + writeT
    const estH = d > 0 ? Math.round((cacheT / d) * 1000) / 10 : 0
    const attempt = async () => {
      try {
        const balance = await deepseekBalance(ctx)
        if (!balance.ok || !balance.infos || balance.infos.length === 0) return
        const total = Number.parseFloat(balance.infos[0].total)
        if (!Number.isFinite(total)) return
        const currency = balance.infos[0].currency || DEFAULT_CURRENCY
        const state = readBalanceState()
        advanceBalanceCost(state, sessionId, total, currency, msgId, estH, model)
        const bound = state[sessionId] && state[sessionId].msgId === msgId
        writeBalanceState(state)
        // 余额尚未扣减(未绑定成功)时,20s 后再补一次
        if (!bound) {
          setTimeout(async () => {
            try {
              const b2 = await deepseekBalance(ctx)
              if (!b2.ok || !b2.infos || b2.infos.length === 0) return
              const t2 = Number.parseFloat(b2.infos[0].total)
              if (!Number.isFinite(t2)) return
              const s2 = readBalanceState()
              advanceBalanceCost(s2, sessionId, t2, b2.infos[0].currency || DEFAULT_CURRENCY, msgId, estH, model)
              writeBalanceState(s2)
            } catch (e2) {
              /* ignore */
            }
          }, 20000)
        }
      } catch (e) {
        /* ignore */
      }
    }
    setTimeout(attempt, 5000)
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-balance',
    handler: async (req, res) => {      try {
        const url = new URL(req.url ?? '', 'http://localhost')
        const qp = url.searchParams
        const sessionId = qp.get('sessionId')
        const cost = sessionId ? await sessionCost(ctx, sessionId) : { amount: null, currency: DEFAULT_CURRENCY, perMessage: null, latestProvider: null }
        // provider 判定:客户端上报(会话实时选择) > 会话日志实际使用的 provider > 默认模型设置
        const providerParam = qp.get('provider')
        let providerSource = 'default'
        let provider = null
        if (providerParam && providerParam.length > 0) {
          provider = providerParam
          providerSource = 'report'
        } else if (cost && cost.latestProvider) {
          provider = cost.latestProvider
          providerSource = 'session'
        } else {
          provider = currentProvider(ctx)
        }
        const base = { provider, providerSource, at: Date.now(), sessionCost: cost.amount, sessionCurrency: cost.currency, perMessage: cost.perMessage }
        if (provider === 'opencode-go') {
          const usage = await opencodeUsage(ctx)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ...base, ...usage, balanceType: 'subscription' }))
          return
        }
        if (provider !== 'deepseek-official') {
          // 其他供应商:暂无余额/用量查询支持,给出明确提示而不是误调 DeepSeek 接口
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ...base, ok: true, balanceType: 'unsupported', note: `供应商 "${provider}" 暂不支持余额查询` }))
          return
        }
        const balance = await deepseekBalance(ctx)
        if (balance.ok && sessionId && balance.infos && balance.infos.length > 0) {
          const total = Number.parseFloat(balance.infos[0].total)
          if (Number.isFinite(total)) {
            const currency = balance.infos[0].currency || DEFAULT_CURRENCY
            // 最新消息的估算命中率与模型名(用于余额差条目附带缓存命中率与模型分布)
            const est = cost.perMessage && cost.latestMsgId ? cost.perMessage[cost.latestMsgId] : null
            const estH = est && typeof est.h === 'number' ? est.h : null
            const estM = est && typeof est.m === 'string' ? est.m : ''
            const state = readBalanceState()
            const r = advanceBalanceCost(state, sessionId, total, currency, cost.latestMsgId, estH, estM)
            writeBalanceState(state)
            // 会话消耗与逐条明细 = 余额真实差值(每条 = 上一条余额 − 本条余额)
            cost.amount = r.acc
            cost.currency = currency
            // 用日志扫描明细(带 m)补齐余额差条目的模型名,保证模型分布完整
            const logPer = cost.perMessage
            cost.perMessage = r.perMessage
            if (logPer && cost.perMessage) {
              for (const k of Object.keys(cost.perMessage)) {
                const e = cost.perMessage[k]
                const le = logPer[k]
                if (e && !e.m && le && typeof le.m === 'string' && le.m) {
                  e.m = le.m
                }
              }
            }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ...base, ...balance, balanceType: 'credit' }))
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }))
      }
    },
  })

  // 上下文占用(悬浮窗圆环数据):优先读投影 contextPressure;缺失时回退 measure + llm 模型容量
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-context',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        const providerParam = url.searchParams.get('provider') || ''
        const modelParam = url.searchParams.get('model') || ''
        const sessions = ctx.get('sessions')
        const projections = ctx.get('sessionProjections')
        if (!sessionId || sessions === undefined || projections === undefined) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: '服务不可用' }))
          return
        }
        const session = sessions.get(sessionId)
        if (!session) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: '会话不存在' }))
          return
        }
        let projectedTokens = null
        let contextWindow = null
        // 占用:优先实时 tokenMeter(每次计算,避免投影停留在旧采样);投影作 fallback
        try {
          const meter = ctx.get('tokenMeter')
          if (meter !== undefined && typeof meter.measure === 'function') {
            const m = meter.measure(session)
            if (m && typeof m.totalTokens === 'number') projectedTokens = m.totalTokens
          }
        } catch {
          /* ignore */
        }
        if (projectedTokens === null || contextWindow === null) {
          try {
            const snap = projections.snapshot(session)
            const values = snap && snap.values ? snap.values : {}
            const cp = values.contextPressure || null
            if (projectedTokens === null) projectedTokens = cp && typeof cp.projectedTokens === 'number' ? cp.projectedTokens : null
            contextWindow = cp && typeof cp.contextWindow === 'number' ? cp.contextWindow : null
          } catch {
            /* fall through */
          }
        }
        // 容量:投影缺失时用 llm 模型信息(取上报 provider/model,缺省用默认;结果缓存)
        if (contextWindow === null) {
          try {
            const llm = ctx.get('llm')
              let provider = providerParam || null
              let model = modelParam || null
              if (!provider || !model) {
                const adm = ctx.get('agentDefaultModel')
                const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : undefined
                if (sel) {
                  provider = provider || (typeof sel.provider === 'string' ? sel.provider : null)
                  model = model || (typeof sel.model === 'string' ? sel.model : null)
                }
              }
              if (llm !== undefined && provider && model && typeof llm.resolveModelInfo === 'function') {
                const cacheKey = provider + '|' + model
                if (CONTEXT_WINDOW_CACHE.has(cacheKey)) {
                  contextWindow = CONTEXT_WINDOW_CACHE.get(cacheKey)
                } else {
                  const info = await llm.resolveModelInfo(provider, model)
                  const cw = info && info.context && typeof info.context.contextWindow === 'number'
                    ? info.context.contextWindow
                    : (info && typeof info.contextWindow === 'number' ? info.contextWindow : null)
                  if (cw !== null && cw !== undefined) {
                    contextWindow = cw
                    CONTEXT_WINDOW_CACHE.set(cacheKey, cw)
                  }
                }
              }
            } catch {
              /* ignore */
            }
          }
        const percent = projectedTokens !== null && contextWindow !== null && contextWindow > 0
          ? Math.round(Math.min(1000, (projectedTokens / contextWindow) * 1000)) / 10
          : null
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, projectedTokens, contextWindow, percent }))
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }))
      }
    },
  })

  // 插件列表(设置 → 插件):?all=1 返回全部条目(官方清单),默认仅自主插件;每条带 editable(是否有配置 schema)
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugins',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost')
        const all = url.searchParams.get('all') === '1'
        const loader = ctx.get('loader')
        const entries = []
        if (loader !== undefined && typeof loader.entries === 'function') {
          for (const entry of loader.entries()) {
            const opts = entry.options || {}
            if (opts.group) continue
            const name = typeof opts.name === 'string' ? opts.name : ''
            // 自主添加 = 非官方(@deepseek-ai/)、非系统(cordis:)的插件包
            if (!all && (name.startsWith('@') || name.startsWith('cordis:'))) continue
            let editable = false
            try {
              // cordis registry 的 runtime 记录保存了插件模块导出的 Config(cordis Registry.plugin)
              const runtime = entry.fiber && entry.fiber.runtime
              editable = !!(runtime && runtime.Config)
            } catch {
              editable = false
            }
            entries.push({
              entryId: String(entry.id),
              moduleName: name,
              enabled: !entry.disabled,
              fiberPhase: entry.fiber === undefined || entry.fiber === null ? null : String(entry.fiber.state),
              editable,
            })
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, entries }))
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }))
      }
    },
  })

  // 插件导入(设置 → 插件 → 额外插件 → 导入插件):上传 zip 插件包 → 解压 → 校验 → 安装到 profile → 追加挂载
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-import',
    handler: async (req, res) => {
      const tmpZip = path.join(IMPORT_PROFILE_DIR, '.tmp-import-' + randomBytes(6).toString('hex') + '.zip')
      const tmpDir = path.join(IMPORT_PROFILE_DIR, '.tmp-import-' + randomBytes(6).toString('hex'))
      const jsonResp = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      try {
        if (importBusy) {
          jsonResp(429, { ok: false, error: '已有导入任务进行中,请稍候再试' })
          return
        }
        importBusy = true
        if (req.method !== 'POST') {
          jsonResp(405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req, 64 * 1024 * 1024) // base64 上限:成品内部最多约 48MB
        const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : ''
        const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : ''
        if (!fileName || !dataBase64) {
          jsonResp(400, { ok: false, error: '缺少 fileName 或 dataBase64' })
          return
        }
        if (!/\.(zip|tgz|tar\.gz)$/i.test(fileName)) {
          jsonResp(400, { ok: false, error: '仅支持 .zip 或 .tgz 插件包' })
          return
        }
        // base64 预校验(字符集合法,改善坏包的错误提示)
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
          jsonResp(400, { ok: false, error: '上传数据不是合法 base64' })
          return
        }
        // 1) 写入临时文件并解压(zip 用 PowerShell,tgz 用系统 tar)
        writeFileSync(tmpZip, Buffer.from(dataBase64, 'base64'))
        mkdirSync(tmpDir, { recursive: true })
        const isTgz = /\.(tgz|tar\.gz)$/i.test(fileName)
        const uz = isTgz ? await unzipViaTar(ctx, tmpZip, tmpDir) : await unzipViaPowershell(ctx, tmpZip, tmpDir)
        if (!uz.ok) {
          jsonResp(400, { ok: false, error: uz.error })
          return
        }
        // 2) 定位插件清单根:解压可直接得到插件根,或外层套一层目录
        let unpackDir = tmpDir
        const directPkg = path.join(tmpDir, 'package.json')
        if (!existsSync(directPkg)) {
          const top = readdirSync(tmpDir, { withFileTypes: true }).find((e) => e.isDirectory())
          if (top) {
            const cand = path.join(tmpDir, top.name, 'package.json')
            if (existsSync(cand)) unpackDir = path.join(tmpDir, top.name)
          }
        }
        // 3) 校验包名(严格)
        const v = validatePluginName(unpackDir, path.basename(unpackDir))
        if (v.error) {
          jsonResp(400, { ok: false, error: v.error })
          return
        }
        const pluginName = v.name
        // 4) 重复导入拦截:目标目录已存在(目录名大小写不敏感,含大小写变体)→ 拒绝,不覆盖
        const profileRoot = path.resolve(IMPORT_PROFILE_DIR)
        const destPkg = path.join(profileRoot, 'node_modules', pluginName)
        // 目标必须在 profile 目录内(防越界,避免被拼接出的路径写穿)
        const resolvedDest = path.resolve(destPkg)
        const rel = path.relative(profileRoot, resolvedDest)
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          jsonResp(400, { ok: false, error: '目标路径越界,已拒绝' })
          return
        }
        if (existsSync(resolvedDest)) {
          jsonResp(409, { ok: false, error: '插件 "' + pluginName + '" 已存在(node_modules 中已有同名目录),禁止重复导入。如需替换请先手动删除后再导入。' })
          return
        }
        // 5) 原子安装:先拷到临时目录,校验成功后再替换;避免半安装/失败丢原插件
        const tmpInstall = path.join(profileRoot, 'node_modules', '.tmp-install-' + randomBytes(6).toString('hex'))
        try {
          copyDirRecursive(unpackDir, tmpInstall)
          renameSync(tmpInstall, resolvedDest)
        } catch (e) {
          try { rmSync(tmpInstall, { recursive: true, force: true }) } catch { /* ignore */ }
          jsonResp(500, { ok: false, error: '安装插件目录失败: ' + String(e && e.message ? e.message : e) })
          return
        }
        // 6) 追加挂载条目(patch-add.cjs 同款逻辑,UTF-8 无 BOM);若已挂载(patch 已含同名条目)则回滚目录
        const patchFile = path.join(profileRoot, 'cordis.patch.yml')
        if (!existsSync(patchFile)) {
          try { rmSync(resolvedDest, { recursive: true, force: true }) } catch { /* ignore */ }
          jsonResp(500, { ok: false, error: 'profile 缺少 cordis.patch.yml,无法挂载' })
          return
        }
        const patchBefore = readFileSync(patchFile, 'utf8')
        try {
          if (!appendPatchMount(patchFile, pluginName)) {
            try { rmSync(resolvedDest, { recursive: true, force: true }) } catch { /* ignore */ }
            jsonResp(409, { ok: false, error: '插件 "' + pluginName + '" 已在挂载配置中,禁止重复导入' })
            return
          }
          // YAML 校验:追加后若语法损坏则回滚 patch 与目录,避免下次启动整个配置解析失败
          const yamlErr = validatePatchYaml(patchFile)
          if (yamlErr) {
            try { writeFileSync(patchFile, patchBefore) } catch { /* ignore */ }
            try { rmSync(resolvedDest, { recursive: true, force: true }) } catch { /* ignore */ }
            jsonResp(500, { ok: false, error: '挂载配置 YAML 校验失败,已回滚: ' + yamlErr })
            return
          }
        } catch (e) {
          try { writeFileSync(patchFile, patchBefore) } catch { /* ignore */ }
          try { rmSync(resolvedDest, { recursive: true, force: true }) } catch { /* ignore */ }
          jsonResp(500, { ok: false, error: '写入挂载配置失败: ' + String(e && e.message ? e.message : e) })
          return
        }
        jsonResp(200, { ok: true, name: pluginName, restart: true })
      } catch (err) {
        jsonResp(500, { ok: false, error: String(err && err.message ? err.message : err) })
      } finally {
        importBusy = false
        // 幂等回收临时文件
        try { rmSync(tmpZip, { force: true }) } catch { /* ignore */ }
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    },
  })

  // ── 热更新(从 GitHub 抓取最新代码覆盖本插件源码;host 改动需重启 dsh,client 改动刷新页面) ──

  // 检查更新:本地记录 sha vs GitHub master 最新提交
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-update-check',
    handler: async (req, res) => {
      const jsonResp = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      try {
        const current = readUpdateState()
        const latest = await fetchLatestCommit()
        if (!latest || !latest.sha) {
          jsonResp(200, { ok: true, checkFailed: true, current, latest: null, hasUpdate: false, error: '无法连接 GitHub(检查网络后重试)' })
          return
        }
        const hasUpdate = !current || !current.sha || current.sha !== latest.sha
        jsonResp(200, { ok: true, current, latest, hasUpdate })
      } catch (err) {
        jsonResp(502, { ok: false, error: String(err && err.message ? err.message : err) })
      }
    },
  })

  // 执行更新:下载 codeload tar.gz → tar 解压 → 校验 → 备份 → 覆盖 lib/ 与清单 → 记录状态
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-update-apply',
    handler: async (req, res) => {
      const jsonResp = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      const tmpTgz = path.join(PLUGIN_DIR, '.tmp-update-' + randomBytes(6).toString('hex') + '.tgz')
      const tmpDir = path.join(PLUGIN_DIR, '.tmp-update-' + randomBytes(6).toString('hex'))
      try {
        if (req.method !== 'POST') {
          jsonResp(405, { ok: false, error: 'method not allowed' })
          return
        }
        // 1) 下载 master 源码包
        const resp = await fetch(`https://codeload.github.com/${GITHUB_REPO}/tar.gz/refs/heads/master`, {
          headers: { 'user-agent': 'uiopt-updater' },
          signal: AbortSignal.timeout(60000),
        })
        if (!resp.ok) {
          jsonResp(502, { ok: false, error: '下载 GitHub 源码包失败 (HTTP ' + resp.status + ')' })
          return
        }
        const buf = Buffer.from(await resp.arrayBuffer())
        if (buf.length < 1000) {
          jsonResp(502, { ok: false, error: '下载内容异常(过小),已放弃' })
          return
        }
        writeFileSync(tmpTgz, buf)
        mkdirSync(tmpDir, { recursive: true })
        // 2) 解压(复用 tar 解压 + zip-slip 防护)
        const uz = await unzipViaTar(ctx, tmpTgz, tmpDir)
        if (!uz.ok) {
          jsonResp(502, { ok: false, error: uz.error })
          return
        }
        // 3) 定位解压根(uiopt-master/ 或直接根)
        let srcDir = tmpDir
        if (!existsSync(path.join(tmpDir, 'package.json'))) {
          const top = readdirSync(tmpDir, { withFileTypes: true }).find((e) => e.isDirectory())
          if (top) srcDir = path.join(tmpDir, top.name)
        }
        const pkgPath = path.join(srcDir, 'package.json')
        const libIndex = path.join(srcDir, 'lib', 'index.js')
        const libClient = path.join(srcDir, 'lib', 'client.js')
        if (!existsSync(pkgPath) || !existsSync(libIndex) || !existsSync(libClient)) {
          jsonResp(502, { ok: false, error: '更新包结构不完整(缺 package.json 或 lib/),已放弃' })
          return
        }
        let pkgName = ''
        try {
          pkgName = JSON.parse(readFileSync(pkgPath, 'utf8')).name
        } catch {
          /* ignore */
        }
        if (pkgName !== 'uiopt') {
          jsonResp(502, { ok: false, error: '更新包 name 不是 uiopt,已放弃' })
          return
        }
        // 4) 备份当前 lib/ 与 package.json(只保留最近一次备份)
        const backups = readdirSync(PLUGIN_DIR, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name.startsWith('.update-backup-'))
          .map((e) => path.join(PLUGIN_DIR, e.name))
        for (const b of backups) {
          try { rmSync(b, { recursive: true, force: true }) } catch { /* ignore */ }
        }
        const backupDir = path.join(PLUGIN_DIR, '.update-backup-' + Date.now())
        try {
          mkdirSync(path.join(backupDir, 'lib'), { recursive: true })
          copyDirRecursive(path.join(PLUGIN_DIR, 'lib'), path.join(backupDir, 'lib'))
          copyFileSync(path.join(PLUGIN_DIR, 'package.json'), path.join(backupDir, 'package.json'))
        } catch {
          /* 备份失败不阻断更新 */
        }
        // 5) 覆盖 lib/ 与清单(不动 node_modules、.git、README 等)
        try {
          rmSync(path.join(PLUGIN_DIR, 'lib'), { recursive: true, force: true })
          copyDirRecursive(path.join(srcDir, 'lib'), path.join(PLUGIN_DIR, 'lib'))
          copyFileSync(pkgPath, path.join(PLUGIN_DIR, 'package.json'))
          if (existsSync(path.join(srcDir, 'cordis.patch.yml'))) {
            copyFileSync(path.join(srcDir, 'cordis.patch.yml'), path.join(PLUGIN_DIR, 'cordis.patch.yml'))
          }
        } catch (e) {
          jsonResp(502, { ok: false, error: '覆盖源码失败: ' + String(e && e.message ? e.message : e) + '(可用 ' + backupDir + ' 恢复)' })
          return
        }
        // 6) 记录同步状态
        const latest = await fetchLatestCommit()
        writeUpdateState({ sha: latest && latest.sha ? latest.sha : null, at: Date.now(), source: 'github' })
        jsonResp(200, { ok: true, restart: true, sha: latest && latest.sha, backup: path.basename(backupDir) })
      } catch (err) {
        jsonResp(502, { ok: false, error: String(err && err.message ? err.message : err) })
      } finally {
        try { rmSync(tmpTgz, { force: true }) } catch { /* ignore */ }
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    },
  })
}
