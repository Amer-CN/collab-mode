/**
 * dsh-collab-mode —— 把 ZCode 侧那套「协作模式」搬到 DeepSeek Harness。
 *
 * 本插件提供三样东西（七个角色子智能体工具——advisor 一份 persona 源展开成三席——
 * 由插件自己用 `ctx.loader.create()` 建行提供；`cordis.patch.yml` 里只有宿主行）：
 *
 *   1. 协作纪律系统提示段（`ctx.systemPrompt.section`），正文来自仓库 `content/collab-rules.md`。
 *   2. 改动前拦截 `tools/pre-execute`：本会话未声明生产文件累计到阈值 → deny，并列出文件名。
 *   3. 审计 `tools/post-execute`：每次工具调用追加一行 JSON 日志（ts/sid/tool/target/ok/latency）。
 *   4. 轮次结束告警 `agent/turn-stopping`：有未声明改动 → 通过 `agent.steer` 告警并列出文件名；否则静默。
 *   5. 子智能体运行列表：同一对工具钩子顺手记下七个角色的起止与真实 provider/model，
 *      折叠成只读列表经自检路由给对话窗口的 dock 卡与右栏竖列（对话转录不注入任何进度行）。
 *      已完成行另从审计日志只读重建，因此 `dsh web` 重启后卡里仍有历史（running 行
 *      是内存态，重启即空 —— 符合设计）。
 *      每行另从子会话事件只读累加 settled 步的 outputTokens/decodeMs（口径与官方
 *      `sessionStats` 投影逐字段相同），供「速率」列使用；没有上报的行标未知。
 *      显示形态由客户端面板可配（`dockCardVisible` / `dockRows` / `dockFold` /
 *      `dockColumns` 四个字段，只影响客户端渲染哪几个面、显示多少行，宿主不据此做事）。
 *      同一份命名空间里还有 `roleColors`（角色 key → 8 色之一）：编辑页写它，列表色点、
 *      dock 行色条、右栏卡片色条三处读它。宿主只做白名单归一化（非法/缺项回落默认），
 *      色值与渲染全在客户端。
 *
 * 钩子走 DSH 的代码级事件，不依赖 `@deepseek-ai/dsh-hooks-claude-code` 适配器，
 * 也不复用 ZCode 的 PowerShell 脚本（任务书第三节设计决策 1）。
 *
 * 本文件刻意零外部依赖：只用 node: 内置模块，因此在 `link:` 安装下也能正常解析，
 * 不需要在插件仓库里再装一份 `@deepseek-ai/*`。
 *
 * @module dsh-collab-mode
 */
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { ROLES, RULES_TEXT } from './generated-content.js'

export const name = 'collab-mode'
export const inject = ['tools', 'systemPrompt']

/** 设置命名空间：设置页卡片、面板读写、自检桥都用这一个键。 */
const NS = 'collab-mode'

/**
 * 一个角色的路由。留空 = 该角色继承父会话模型路由（即 v0.1.0 的行为），
 * 因此面板清空某个字段就是「恢复继承」，不需要额外的开关。
 */
const RoleRoute = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  maxTokens: z.number().default(0),
})

/**
 * 一列可显示的运行行字段。`id` 是客户端渲染用的键，`default` 是出厂是否勾选。
 *
 * `rate` 是**有数据源**的那一列：宿主从子会话事件累加 settled 步的
 * outputTokens / decodeMs（口径与官方 `sessionStats` 投影逐字段相同，见 2b 区块的
 * `foldChildMetrics`），客户端按官方 `formatTokensPerSecond` 渲染。
 *
 * 无数据源的占位列（曾有的 `tokenRate` / `turns`）已删除：`rate` 列点亮后它们
 * 不再有存在的理由，旧设置里残留的键由归一化自动丢弃。
 */
const DOCK_COLUMNS = [
  { id: 'role', label: '角色', default: true },
  { id: 'route', label: '路由', default: true },
  { id: 'state', label: '状态', default: true },
  { id: 'elapsed', label: '耗时', default: true },
  { id: 'startedAt', label: '开始时刻', default: false },
  { id: 'rate', label: '速率', default: true },
]

/** 运行卡/竖列的显示上限：单面最多显示多少行（0 = 不限）。 */
const DOCK_ROWS_MAX = 50
/** 折叠时最多显示多少条已完成行。 */
const DOCK_FOLD_MAX = 20

/**
 * 角色标记色的合法色名集合（8 色）—— 客户端 `COLOR_HEX` 的键就是这份集合，
 * 色值本身只活在客户端（宿主不渲染任何颜色）。
 */
const ROLE_COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']

/** 每个角色的出厂默认标记色；面板没给（或给了非法色名）时回落这里。 */
const DEFAULT_ROLE_COLORS = {
  executor: 'orange',
  'code-reviewer': 'red',
  researcher: 'blue',
  'advisor-A': 'green',
  'advisor-B': 'pink',
  'advisor-C': 'yellow',
  'vision-reader': 'purple',
}

/**
 * 面板里的角色配色 → 生效配色：只认 ROLE_COLOR_NAMES 这 8 个色名，缺项与非法值
 * 一律回落该角色的出厂默认色（照 `columnsFromPanel` 的样板，但**不抛错** ——
 * 标记色是显示偏好，为它把整个命名空间打成红色（或让面板保存失败）不值当，
 * 简报第 3 条要的正是「非法值回落默认、不红不炸」）。
 */
function roleColorsFromPanel(panel) {
  const out = {}
  for (const role of ROLES) {
    const value = panel === null || typeof panel !== 'object' ? undefined : panel[role.key]
    out[role.key] = ROLE_COLOR_NAMES.includes(value) ? value : DEFAULT_ROLE_COLORS[role.key]
  }
  return out
}

/**
 * 面板的全部可编辑项。A 区块 = routes（+ roleColors），B 区块 = 三个开关 + 阈值，
 * C 区块 = 运行卡显示形态（dockCardVisible / dockRows / dockFold / dockColumns）。
 */
const PANEL_SCHEMA = z.object({
  routes: z
    .object(Object.fromEntries(ROLES.map((role) => [role.key, RoleRoute])))
    .default({}),
  gate: z.boolean().default(true),
  audit: z.boolean().default(true),
  warnOnTurnEnd: z.boolean().default(true),
  declarationThreshold: z.number().default(3),
  logDir: z.string().default(''),
  /**
   * 对话窗口那张运行卡（`conversation.input.dock`）的总开关（面板 C 区块，客户端读写）：
   * false = 整卡不渲染。右栏竖列不受它影响（那里另有自己的 tab 开关）。
   */
  dockCardVisible: z.boolean().default(true),
  /** 运行面显示的行数上限（0 = 不限）。 */
  dockRows: z.number().default(8),
  /** 折叠时最多显示多少条「已完成」行（进行中一律全显示）。 */
  dockFold: z.number().default(3),
  /** 显示哪些列（客户端按 DOCK_COLUMNS 勾选写入；至少一列由客户端校验）。 */
  dockColumns: z
    .object(Object.fromEntries(DOCK_COLUMNS.map((col) => [col.id, z.boolean().default(col.default)])))
    .default({}),
  /**
   * 每个角色的标记色（角色 key → 色名）。编辑页点选后写这里，三处显示面
   * （设置列表色点 / 对话 dock 行色条 / 右栏卡片色条）都读同一个值。
   *
   * 值类型用 `z.any()` 而不是 `z.string()`：非法色名要在**读的时候**回落默认色，
   * 而不是让 schema 解析抛错 —— 解析失败会连累整个命名空间（注册直接抛错、
   * 外部改文件时整段值退回上一次的好值）。白名单过滤在 `roleColorsFromPanel` 里。
   */
  roleColors: z
    .object(Object.fromEntries(ROLES.map((role) => [role.key, z.any().default(DEFAULT_ROLE_COLORS[role.key])])))
    .default({}),
})

/**
 * 面板里的列勾选 → 生效值：只认 DOCK_COLUMNS 里的键，缺项或非布尔一律回落到补丁层默认，
 * 免得客户端写进一个半截对象就把某列永久关掉。
 */
function columnsFromPanel(panel, fallback) {
  const out = {}
  for (const col of DOCK_COLUMNS) {
    const value = panel === null || typeof panel !== 'object' ? undefined : panel[col.id]
    out[col.id] = typeof value === 'boolean' ? value : fallback[col.id]
  }
  return out
}

/** 角色行的 loader entry id（与 v0.1.0 的 id 保持一致，便于识别）。 */
const roleEntryId = (key) => `collab-${key}`

/** 七个角色工具名 —— 「工具调用 → 角色」的唯一映射（审计重建也用同一个集合）。 */
const ROLE_TOOLS = new Set(ROLES.map((role) => role.tool))

/** 角色行的完整 config：loader 改写时要以它为底，避免丢字段。 */
function roleRowConfig(role, route) {
  const config = {
    provider: 'spawn',
    toolName: role.tool,
    backgroundMode: 'one-shot',
    maxDepth: 1,
    persona: role.persona,
  }
  if (route !== undefined) {
    const agentOptions = {}
    if (route.provider !== '') agentOptions.provider = route.provider
    if (route.model !== '') agentOptions.model = route.model
    if (route.reasoningEffort !== '') agentOptions.reasoningEffort = route.reasoningEffort
    if (Number.isFinite(route.maxTokens) && route.maxTokens > 0) agentOptions.maxTokens = route.maxTokens
    // 只在这三样至少填了一个时才写 agentOptions：空对象会被
    // dsh-tool-subagent 当成「已配置」去断言 provider 能力，而留空应当是继承。
    if (Object.keys(agentOptions).length > 0) config.agentOptions = agentOptions
  }
  if (role.deny !== null) config.toolFilter = { deny: [...role.deny] }
  return config
}

/** 简报文件名：与本仓库规则文本、ZCode 侧 `enforce-flow.ps1` 保持一致。 */
const BRIEF_MAIN = 'current-task.md'
const BRIEF_PREFIX = 'task-'
const BRIEF_SUFFIX = '.md'

/** 计入统计的工具：只有这两个有「目标文件」语义。 */
const WRITE_TOOLS = new Set(['edit', 'write'])

/** 拦截信息里最多列几个文件名，其余折成 (+N more)，避免拒绝信息过长。 */
const MAX_LISTED = 8

const DEFAULTS = {
  /** 改动前拦截总开关。 */
  gate: true,
  /** 审计日志总开关。 */
  audit: true,
  /** 轮次结束告警总开关。 */
  warnOnTurnEnd: true,
  /** 未声明生产文件累计到这个数就拦截／告警。 */
  declarationThreshold: 3,
  /** 系统提示段的名字，同层重名会抛错。 */
  rulesSection: 'collab-mode:rules',
  /** 系统提示段的排序位：400 = 在 persona prefix(0) 之后、PLAN_POLICY(500) 之前。 */
  rulesOrder: 400,
  /** 审计日志目录；默认 `$DSH_HOME/hooks`。 */
  logDir: undefined,
  /** 对话窗口运行卡的总开关（面板 C 区块）。 */
  dockCardVisible: true,
  /** 运行面显示的行数上限（0 = 不限）。 */
  dockRows: 8,
  /** 折叠时最多显示多少条已完成行。 */
  dockFold: 3,
  /** 勾选了哪些列；缺项由客户端按 DOCK_COLUMNS 的 default 补。 */
  dockColumns: Object.fromEntries(DOCK_COLUMNS.map((col) => [col.id, col.default])),
  /** 每个角色的标记色（面板编辑页写；三处显示面读）。 */
  roleColors: { ...DEFAULT_ROLE_COLORS },
}

/* ────────────────────────── 配置 ────────────────────────── */

/** 校验并冻结配置。配置不合法直接抛错，不回退默认值 —— 静默降级比启动失败更难查。 */
function resolveConfig(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('collab-mode: config must be a mapping')
  }
  const cfg = { ...DEFAULTS, ...raw }
  for (const key of ['gate', 'audit', 'warnOnTurnEnd']) {
    if (typeof cfg[key] !== 'boolean') throw new Error(`collab-mode: \`${key}\` must be a boolean`)
  }
  if (!Number.isInteger(cfg.declarationThreshold) || cfg.declarationThreshold < 1) {
    throw new Error('collab-mode: `declarationThreshold` must be a positive integer')
  }
  if (typeof cfg.rulesSection !== 'string' || cfg.rulesSection === '') {
    throw new Error('collab-mode: `rulesSection` must be a non-empty string')
  }
  if (typeof cfg.rulesOrder !== 'number' || !Number.isFinite(cfg.rulesOrder)) {
    throw new Error('collab-mode: `rulesOrder` must be a finite number')
  }
  if (cfg.logDir !== undefined && (typeof cfg.logDir !== 'string' || cfg.logDir === '')) {
    throw new Error('collab-mode: `logDir` must be a non-empty string when set')
  }
  if (typeof cfg.dockCardVisible !== 'boolean') {
    throw new Error('collab-mode: `dockCardVisible` must be a boolean')
  }
  if (!Number.isInteger(cfg.dockRows) || cfg.dockRows < 0 || cfg.dockRows > DOCK_ROWS_MAX) {
    throw new Error(`collab-mode: \`dockRows\` must be an integer between 0 and ${DOCK_ROWS_MAX}`)
  }
  if (!Number.isInteger(cfg.dockFold) || cfg.dockFold < 0 || cfg.dockFold > DOCK_FOLD_MAX) {
    throw new Error(`collab-mode: \`dockFold\` must be an integer between 0 and ${DOCK_FOLD_MAX}`)
  }
  if (cfg.dockColumns === null || typeof cfg.dockColumns !== 'object' || Array.isArray(cfg.dockColumns)) {
    throw new Error('collab-mode: `dockColumns` must be a mapping of column id → boolean')
  }
  for (const col of DOCK_COLUMNS) {
    const value = cfg.dockColumns[col.id]
    // 缺项补 default；显式给了就必须是布尔 —— 静默改写用户配错的类型比启动失败更难查。
    if (value === undefined) cfg.dockColumns[col.id] = col.default
    else if (typeof value !== 'boolean') throw new Error(`collab-mode: \`dockColumns.${col.id}\` must be a boolean`)
  }
  if (cfg.roleColors === null || typeof cfg.roleColors !== 'object' || Array.isArray(cfg.roleColors)) {
    throw new Error('collab-mode: `roleColors` must be a mapping of role key → color name')
  }
  // 色名本身非法只回落默认色，不抛错（与上面几个字段的严格校验不同，见 roleColorsFromPanel）。
  cfg.roleColors = roleColorsFromPanel(cfg.roleColors)
  return cfg
}

/** `$DSH_HOME`（默认 `~/.dsh`）：与 DSH 自身解析 home 的方式保持一致。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/* ────────────────────────── 路径与简报 ────────────────────────── */

/**
 * 归一化成和 ZCode 侧同一种形式：绝对路径、反斜杠、去掉尾部分隔符、小写。
 * Windows 路径大小写不敏感，统一小写才能去重与比较。
 * @returns 归一化路径，无法解析时返回 null。
 */
function normalizePath(target, cwd) {
  if (typeof target !== 'string' || target.trim() === '') return null
  let abs
  try {
    abs = resolve(cwd ?? process.cwd(), target)
  } catch {
    return null
  }
  let out = abs.replace(/\//g, '\\')
  while (out.length > 3 && out.endsWith('\\')) out = out.slice(0, -1)
  return out.toLowerCase()
}

/**
 * 不计入统计的路径（与 ZCode 侧 enforce-flow.ps1 的豁免一致，另加 `.git/`）：
 *   - `$DSH_HOME` 治理树（规则、设置、会话、插件源）——本协作系统自己的配置树
 *   - 任何 `.work/` 下的文件（简报、报告、决策备忘录）
 *   - `.git/` 内部文件（提交信息临时文件、锁）
 */
function isExcluded(normPath, homeNorm) {
  if (normPath === null) return true
  if (/[\\/]\.work[\\/]/.test(normPath)) return true
  if (/[\\/]\.git[\\/]/.test(normPath)) return true
  if (homeNorm !== null && (normPath === homeNorm || normPath.startsWith(`${homeNorm}\\`))) return true
  return false
}

/**
 * 找简报文件：从起点目录逐级向上，第一个含 `current-task.md` 或 `task-*.md`
 * 的 `.work/` 目录即命中（与 ZCode 侧 Get-BriefFiles 同语义）。
 * @returns 命中目录下的简报文件绝对路径数组；没有则空数组。
 */
function briefFilesFrom(startDir) {
  if (typeof startDir !== 'string' || startDir === '') return []
  let probe
  try {
    probe = resolve(startDir)
  } catch {
    return []
  }
  for (;;) {
    const workDir = join(probe, '.work')
    if (existsSync(workDir)) {
      let entries = []
      try {
        entries = readdirSync(workDir)
      } catch {
        entries = []
      }
      const hits = entries.filter(
        (entry) => entry === BRIEF_MAIN || (entry.startsWith(BRIEF_PREFIX) && entry.endsWith(BRIEF_SUFFIX)),
      )
      if (hits.length > 0) return hits.map((entry) => join(workDir, entry))
    }
    const parent = dirname(probe)
    if (parent === probe) return []
    probe = parent
  }
}

/**
 * 简报集合 = 「会话工作目录树」∪「目标文件自己所在目录树」。
 * 文件可能合法地活在会话项目之外（例如用户级插件树），两棵树都查才不会误拦。
 */
function collectBriefs(cwd, targetPaths) {
  const out = []
  const seen = new Set()
  const roots = [cwd]
  for (const p of targetPaths) roots.push(dirname(p))
  for (const root of roots) {
    for (const file of briefFilesFrom(root)) {
      const key = file.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(file)
    }
  }
  return out
}

/**
 * 覆盖判定：取文件名（leaf）在简报全文里做**子串**匹配，命中即视为已声明。
 * 与 ZCode 侧 Test-Declared 一致（`-match` 本身大小写不敏感）。
 * @param cache - 同一次判定内的简报正文缓存，调用方每次判定新建。
 */
function isDeclared(normPath, briefs, cache) {
  const leaf = parse(normPath).base
  if (!leaf) return false
  const needle = leaf.toLowerCase()
  for (const file of briefs) {
    let text = cache.get(file)
    if (text === undefined) {
      try {
        text = readFileSync(file, 'utf8').toLowerCase()
      } catch {
        text = null
      }
      cache.set(file, text)
    }
    if (text !== null && text.includes(needle)) return true
  }
  return false
}

/** 未声明文件清单：已归一化路径 → 文件名，按 MAX_LISTED 截断成一段可读文本。 */
function listNames(paths) {
  const names = paths.map((p) => parse(p).base)
  const shown = names.slice(0, MAX_LISTED)
  const rest = names.length - shown.length
  return rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ')
}

/* ────────────────────────── 会话状态 ────────────────────────── */

/** sessionId -> { seen, changed, warnedKeys }。会话级内存状态，进程重启即清空。 */
const states = new Map()

function sessionIdOf(agent) {
  const fromSession = agent?.session?.header?.id
  if (typeof fromSession === 'string' && fromSession !== '') return fromSession
  const fromAgent = agent?.id
  return typeof fromAgent === 'string' && fromAgent !== '' ? fromAgent : null
}

function cwdOf(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

function stateFor(agent) {
  const id = sessionIdOf(agent)
  if (id === null) return null
  let state = states.get(id)
  if (state === undefined) {
    state = { seen: new Set(), changed: new Set(), warnedKeys: new Set() }
    states.set(id, state)
  }
  return state
}

/**
 * 只要已存在的状态，不因为一次读取就新建（否则空会话也会留状态）。
 * ⚠ 返回 `undefined` 表示「这个会话没有状态」——调用方必须判 undefined，
 * 不能判 null：`Map.get` 未命中给的是 undefined，把它当成 null 漏过去会在
 * `agent/turn-stopping` 里抛异常，直接把子智能体那一轮打成 error。
 */
function existingState(agent) {
  const id = sessionIdOf(agent)
  if (id === null) return undefined
  return states.get(id)
}

/* ────────────────────────── 消息与日志 ────────────────────────── */

/**
 * 构造一条插件来源的 user 消息。
 * 等价于 `createUserMessage`（`@deepseek-ai/dsh-llm`）：补 role、给一个新 id、冻结。
 * 这里自己构造是为了让本插件零外部依赖，字段与官方 helper 完全一致。
 */
function pluginMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'collab-mode' },
  })
}

/** 会话 id 里不能出现在文件名中的字符一律替换（与 ZCode 侧同规则）。 */
function safeSessionId(sid) {
  const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '_')
  return safe.length > 60 ? safe.slice(0, 60) : safe
}

/** 工具调用的「目标」：文件路径优先，其次命令，其次子智能体任务的描述。 */
function targetOf(exec) {
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return ''
  if (typeof args.file_path === 'string') return args.file_path
  if (typeof args.path === 'string') return args.path
  if (typeof args.command === 'string') return args.command.length > 200 ? `${args.command.slice(0, 200)}...` : args.command
  if (typeof args.description === 'string') return args.description
  return ''
}

/* ──────────────────── 7. opencode free 回传剥除 ──────────────────── *
 *
 * 背景：DSH 走 zen 渠道（openai-responses 协议）的 free 模型在多轮 agent 会话里
 * 报 `reasoning encrypted_content was not issued to this caller`。
 * 机制（2026-09-14 实验矩阵）：pi-ai 发推理档位必带
 * `include:["reasoning.encrypted_content"]`，响应里的加密推理块经 replay 状态在下一轮
 * 原样回传；上游对回传的加密内容做 caller 校验，且**校验不认 `x-opencode-session` 头的值**
 * （T3：新 UUID 回传旧加密内容仍 200）—— 真正的坑就是「回传了加密内容」本身，上游重排
 * 路由/池子时必炸。短会话测不出，长 agent 会话必现。
 *
 * 修法（两个动作，都装在宿主进程 `globalThis.fetch` 的窄包装里）：
 *   A（主修法）**剥除加密回传**：只打 free 端点（路径含 `/zen/v1/`）的 POST JSON 请求，
 *     从 `input` 数组剔除所有 `type === "reasoning"` 的项再转发；付费 `/zen/go/v1` 一个
 *     字节都不碰，保留完整推理连续性。上游接受剥除后的历史（实验 D2），模型从可见历史
 *     重新推理。
 *   B（辅修法）**会话头镜像**：host 含 opencode.ai（含付费 go 端点，语义与 ZCode 一致、
 *     无害）时，把 pi-ai 每请求自带的 `x-client-request-id`（= DSH 会话 id）覆盖写进
 *     `x-opencode-session`；没有该头的请求（如模型目录发现）用进程级懒生成一次的 UUID v4。
 *     目的：符合上游文档契约、路由粘性、prompt 缓存，并终结 settings 里那个写死数月的共享 UUID。
 *
 * 为什么拦得住（实现前已实证，行号见汇报）：
 * - pi-ai `openai-responses.js` 第 112 行 `createClient(...)` 把 `options?.fetch`（DSH 从不传，
 *   `dsh-llm-pi-ai` 第 1867–1874 行只给 headers/sessionId/signal 等）交给第 201–207 行
 *   `new OpenAI({ fetch, defaultHeaders })`；OpenAI SDK `client.js` 第 160 行
 *   `this.fetch = options.fetch ?? Shims.getDefaultFetch()`，而 `shims.js` 第 9–14 行的
 *   `getDefaultFetch()` 返回裸 `fetch` 标识符 = 构造那一刻的 `globalThis.fetch`。
 *   pi-ai 每请求新建 client，包装在插件 apply（进程启动）时已装好，故每次都落在包装里
 *   （实测 `client.fetch === globalThis.fetch`，出站 1 次调用被包装捕获）。
 * - SDK 出站走 `client.js` 第 510 行 `this.fetch.call(undefined, url, fetchOptions)`：
 *   `url` 是字符串、`body` 是 JSON 字符串、**不设 content-length**，故改写 body 无残留长度问题。
 * - profile 静态头经 `requestHeaders()`（`dsh-llm-pi-ai` 第 1723–1730 行）合并进 SDK
 *   `defaultHeaders`（`client.js` 第 624 行），我们在 fetch 层最后改写，天然后发先至，稳赢静态旧值。
 *
 * 幂等与还原：重复安装不叠层（返回同一个 unwrap）；`ctx.effect` 注册的 dispose 完整还原原 fetch。
 * fail-open：非 opencode.ai 域零接触（连 body 都不 parse）；解析失败/不命中一律原样透传，绝不报错。
 */

/** 命中的域名：opencode.ai 本域及子域（点边界，避免 evilopencode.ai 这类擦边）。 */
const OPENCODE_HOST_SUFFIX = 'opencode.ai'
const OPENCODE_SESSION_HEADER = 'x-opencode-session'
const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'
/** free 端点路径标记：付费 `/zen/go/v1/` 不含它，天然被排除在动作 A 之外。 */
const OPENCODE_FREE_PATH_MARK = '/zen/v1/'

let opencodeOriginalFetch = null
let opencodeWrappedFetch = null
let opencodeProcessSessionId = null

/** 进程级懒生成一次的 UUID v4（无会话 id 可用时的兜底身份）。 */
function opencodeProcessSession() {
  if (opencodeProcessSessionId === null) opencodeProcessSessionId = randomUUID()
  return opencodeProcessSessionId
}

/** 动作 B 用：合并出站头（Request 自带头 + init 头，init 赢），再镜像出会话头。 */
function opencodeWrapHeaders(input, init) {
  const headers = new Headers()
  try {
    if (typeof Request === 'function' && input instanceof Request) {
      input.headers.forEach((value, key) => headers.set(key, value))
    }
  } catch {
    // 读不到就当没有，绝不让头部处理炸掉真实请求。
  }
  try {
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  } catch {
    // 同上。
  }
  const clientId = headers.get(CLIENT_REQUEST_ID_HEADER)
  headers.set(OPENCODE_SESSION_HEADER, clientId !== null && clientId !== '' ? clientId : opencodeProcessSession())
  return headers
}

/**
 * 动作 A 用：从请求体 JSON 的 `input` 数组里剔除所有 `type === "reasoning"` 的项。
 * 返回重新序列化的 body；不命中（非法 JSON / 无 input 数组 / 本就没有 reasoning 项）返回 null，
 * 调用方据此原样透传——绝不为「无事可做」而改写字节。
 */
function stripReasoningReplay(rawBody) {
  if (typeof rawBody !== 'string' || rawBody === '') return null
  let parsed
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.input)) return null
  const kept = parsed.input.filter((item) => !(item !== null && typeof item === 'object' && item.type === 'reasoning'))
  if (kept.length === parsed.input.length) return null
  parsed.input = kept
  try {
    return JSON.stringify(parsed)
  } catch {
    return null
  }
}

/** 当前是否装着包装（自检字段与夹具都读它）。 */
export function opencodeFreeRelayInstalled() {
  return opencodeOriginalFetch !== null
}

export function uninstallOpencodeFreeRelay() {
  // 只拆自己的：若之后又叠了别人的包装，不替别人拆。
  if (opencodeOriginalFetch !== null && globalThis.fetch === opencodeWrappedFetch) {
    globalThis.fetch = opencodeOriginalFetch
  }
  opencodeOriginalFetch = null
  opencodeWrappedFetch = null
}

/** 从 input/init 里取 URL 字符串（取不到即 ''，交给调用方透传）。 */
function opencodeUrlOf(input) {
  try {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    if (typeof Request === 'function' && input instanceof Request) return input.url
    if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  } catch {
    // 形状异常一律当没有 URL。
  }
  return ''
}

/**
 * 安装全局 fetch 窄包装（动作 A 剥除加密回传 + 动作 B 会话头镜像），返回 unwrap。
 * 幂等：重复安装不叠层，直接返回同一个 unwrap。
 * 非 opencode.ai 域零接触；URL 解析失败、非法 JSON body、input 形状异常一律原样透传，绝不炸请求。
 */
export function installOpencodeFreeRelay() {
  if (opencodeOriginalFetch !== null) return uninstallOpencodeFreeRelay
  const original = globalThis.fetch
  if (typeof original !== 'function') return () => {}
  const wrapped = async function opencodeFreeRelayFetch(input, init) {
    let host = ''
    let path = ''
    try {
      const url = opencodeUrlOf(input)
      if (url !== '') {
        const parsed = new URL(url)
        host = parsed.hostname.toLowerCase()
        path = parsed.pathname
      }
    } catch {
      host = ''
    }
    // 非 opencode.ai 域：零接触（不碰 header，也不 parse body）。
    if (host === '' || (host !== OPENCODE_HOST_SUFFIX && !host.endsWith('.' + OPENCODE_HOST_SUFFIX))) {
      return original.call(this, input, init)
    }

    const headers = opencodeWrapHeaders(input, init)

    // 动作 A 命中条件：POST + 路径含 `/zen/v1/`（付费 `/zen/go/v1/` 不含该标记，天然排除）
    // + Content-Type json。任一不满足就只做动作 B。
    const isRequest = typeof Request === 'function' && input instanceof Request
    const method = String(init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase()
    const contentType = String(headers.get('content-type') ?? '').toLowerCase()
    const wantsStrip = method === 'POST' && path.includes(OPENCODE_FREE_PATH_MARK) && contentType.includes('json')

    if (wantsStrip) {
      try {
        // 真实路径（OpenAI SDK）：URL 是字符串、body 是 JSON 字符串。
        if (typeof init?.body === 'string') {
          const stripped = stripReasoningReplay(init.body)
          if (stripped !== null) return original.call(this, input, { ...init, headers, body: stripped })
        } else if (isRequest) {
          // Request 形态：clone 读体不消耗原件，读不到就退回原请求。
          const stripped = stripReasoningReplay(await input.clone().text())
          if (stripped !== null) return original.call(this, new Request(input, { headers, body: stripped }), undefined)
        }
      } catch {
        // 改写失败就原样透传（不断请求）。
      }
    }

    try {
      if (typeof input === 'string' || input instanceof URL) {
        return original.call(this, input, { ...init, headers })
      }
      if (isRequest) {
        return original.call(this, new Request(input, { ...init, headers }), undefined)
      }
    } catch {
      // 重建失败就原样透传（不断请求）。
    }
    return original.call(this, input, init)
  }
  opencodeOriginalFetch = original
  opencodeWrappedFetch = wrapped
  globalThis.fetch = wrapped
  return uninstallOpencodeFreeRelay
}

/* ────────────────────────── 远端版本（只读） ────────────────────────── *
 *
 * 面板要在插件落后时提示「有新版本」：本地版本读插件自己的 `package.json`，远端版本
 * 读仓库 main 上那份同文件（判据与 ZCode 侧 `version_check.py` 一致，只是换成本插件的
 * 版本文件）。
 *
 * 三条硬约束（简报）：抓取不阻塞 apply、失败一律静默、2 秒一次的自检轮询不放大远端请求。
 * 因此：进程内一份缓存（TTL 1 小时）+ 单飞（在飞时复用同一个 promise）；抓取只用 node
 * 内建 `fetch` + `AbortSignal.timeout(8s)` 熔断；任何失败（离线 / 超时 / 非 200 / 坏 JSON /
 * 取不到 version）都落成 `null` 并照样计入缓存，绝不抛给调用方、绝不打红面板。
 */

/** 远端版本文件：仓库 main 上本插件的 package.json。 */
const UPDATE_URL = 'https://raw.githubusercontent.com/Amer-CN/collab-mode/main/dsh-collab-mode/package.json'
/** 缓存时长：1 小时。 */
const UPDATE_TTL_MS = 60 * 60 * 1000
/** 单次抓取的熔断时限：8 秒。 */
const UPDATE_TIMEOUT_MS = 8000

/** 远端版本缓存：`at` = 落缓存时刻，`value` = 版本串或 null（没抓到）。 */
let updateCache = { at: 0, value: null }
/** 在飞的那一次抓取（单飞：轮询再密也只有一个请求）。 */
let updateInflight = null

/** `1.10.0` → `[1, 10, 0]`；含非数字段（`v1.2.3`、`abc`、空段）返回 null。 */
function numericVersion(text) {
  const out = []
  for (const part of text.split('.')) {
    if (!/^\d+$/.test(part)) return null
    out.push(Number(part))
  }
  return out
}

/**
 * 本地版本是否落后于远端：按数字段比较（1.10.0 > 1.9.0）；任一侧不可解析时退化为
 * 「字符串不等即落后」（宁可误报一行字，不漏报）。
 */
export function versionIsBehind(local, remote) {
  if (typeof local !== 'string' || typeof remote !== 'string') return false
  if (local === '' || remote === '' || local === remote) return false
  const left = numericVersion(local)
  const right = numericVersion(remote)
  if (left === null || right === null) return true
  const len = Math.max(left.length, right.length)
  for (let index = 0; index < len; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return b > a
  }
  return false
}

/** 远端 package.json 的 version；任何失败都返回 null（静默）。 */
async function fetchRemoteVersion() {
  try {
    const response = await fetch(UPDATE_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    })
    if (response === null || response === undefined || response.ok !== true) return null
    const body = await response.json()
    const version = body !== null && typeof body === 'object' ? body.version : undefined
    return typeof version === 'string' && version.trim() !== '' ? version.trim() : null
  } catch {
    return null
  }
}

/** 抓一次远端版本并落缓存（成功与失败都落，免得失败也去 hammer 远端）；在飞时复用同一个 promise，绝不抛。 */
function refreshRemoteVersion() {
  if (updateInflight !== null) return updateInflight
  updateInflight = (async () => {
    const value = await fetchRemoteVersion()
    updateCache = { at: Date.now(), value }
    updateInflight = null
  })()
  return updateInflight
}

/** 同步读缓存：过期就在**后台**刷一次（不等待），本次仍用旧值 —— 自检轮询永远不会被网络拖住。 */
function cachedRemoteVersion() {
  if (Date.now() - updateCache.at >= UPDATE_TTL_MS) void refreshRemoteVersion()
  return updateCache.value
}

/* ────────────────────────── 插件本体 ────────────────────────── */

/**
 * @param ctx - 拥有这些注册的上下文（本插件挂在 Host 平面）。
 * @param rawConfig - bundle patch 里那一行的 `config`。
 */
export function apply(ctx, rawConfig) {
  // patch 行里的 config 是**默认值**；设置面板的命名空间值覆盖它（任务书第三节 B 区块）。
  const patchCfg = resolveConfig(rawConfig)
  const homeNorm = normalizePath(dshHome())
  const startedAt = new Map()

  /** 生效值：初始等于 patch 默认值，settings 一旦挂上就由它驱动。 */
  let live = { ...patchCfg }
  let logDir = patchCfg.logDir ?? join(dshHome(), 'hooks')
  let auditDirReady = false
  /** 设置面板当前值（未挂 settings 时用组合层默认值）。 */
  let settingsSource = () => null

  /* ---- 设置命名空间 ---- */

  /** 组合层 `base`：面板里点「重置」回到这组值。 */
  const baseEntry = {
    routes: {},
    gate: patchCfg.gate,
    audit: patchCfg.audit,
    warnOnTurnEnd: patchCfg.warnOnTurnEnd,
    declarationThreshold: patchCfg.declarationThreshold,
    logDir: patchCfg.logDir ?? '',
    dockCardVisible: DEFAULTS.dockCardVisible,
    dockRows: DEFAULTS.dockRows,
    dockFold: DEFAULTS.dockFold,
    dockColumns: { ...DEFAULTS.dockColumns },
    roleColors: { ...DEFAULTS.roleColors },
  }

  /** 角色行的 loader entry id。与 v0.1.0 的补丁行 id 同名，便于识别。 */
  const TOOL_SUBAGENT = '@deepseek-ai/dsh-tool-subagent'

  /** 读一个 loader entry；不存在时返回 undefined 而不是抛错。 */
  function resolveEntry(loader, id) {
    try {
      return loader.resolve(id)
    } catch {
      return undefined
    }
  }

  /**
   * 让七个角色行与面板值一致。
   *
   * ⚠ 这七行由**插件自己**用 `ctx.loader.create()` 拥有，不走 cordis.patch.yml 的
   * `insert`。原因：补丁插入的行挂在文件后端 `Include` 的 root group 上，对它调
   * `loader.update` 会走 `EntryTree.update` 结尾的 `source.tree.write()`
   * → `Include.write()` → 把整棵合成树回写进 profile 的 `cordis.yml`，压平
   * bundle / profile / home 三层补丁。插件自己 create 的行挂在 Loader 自己的 root
   * group 上，而 `Loader.write()` 是空实现，因此 `loader.update` 只热重启那一行。
   */
  async function syncRoleRows(routes) {
    const loader = ctx.get('loader')
    if (loader === undefined) {
      ctx.logger?.warn('collab-mode: loader service unavailable — role rows were not registered')
      return
    }
    for (const role of ROLES) {
      const id = roleEntryId(role.key)
      const config = roleRowConfig(role, routes === null || routes === undefined ? undefined : routes[role.key])
      try {
        const entry = resolveEntry(loader, id)
        if (entry === undefined) {
          await loader.create({ id, name: TOOL_SUBAGENT, config })
        } else if (JSON.stringify(entry.options.config ?? null) !== JSON.stringify(config)) {
          await loader.update(id, { config })
        }
      } catch (error) {
        ctx.logger?.warn(`collab-mode: role row "${id}" failed to apply: ${String(error && error.message)}`)
      }
    }
  }

  /** 把面板值落进生效值，并把角色行同步过去。 */
  function syncFromSettings() {
    let panel
    try {
      panel = settingsSource()
    } catch (error) {
      ctx.logger?.warn(`collab-mode: settings source failed: ${String(error && error.message)}`)
      panel = null
    }
    if (panel === null || typeof panel !== 'object') return
    live = {
      ...patchCfg,
      gate: typeof panel.gate === 'boolean' ? panel.gate : patchCfg.gate,
      audit: typeof panel.audit === 'boolean' ? panel.audit : patchCfg.audit,
      warnOnTurnEnd: typeof panel.warnOnTurnEnd === 'boolean' ? panel.warnOnTurnEnd : patchCfg.warnOnTurnEnd,
      declarationThreshold:
        Number.isInteger(panel.declarationThreshold) && panel.declarationThreshold >= 1
          ? panel.declarationThreshold
          : patchCfg.declarationThreshold,
      dockCardVisible:
        typeof panel.dockCardVisible === 'boolean' ? panel.dockCardVisible : patchCfg.dockCardVisible,
      dockRows:
        Number.isInteger(panel.dockRows) && panel.dockRows >= 0 && panel.dockRows <= DOCK_ROWS_MAX
          ? panel.dockRows
          : patchCfg.dockRows,
      dockFold:
        Number.isInteger(panel.dockFold) && panel.dockFold >= 0 && panel.dockFold <= DOCK_FOLD_MAX
          ? panel.dockFold
          : patchCfg.dockFold,
      dockColumns: columnsFromPanel(panel.dockColumns, patchCfg.dockColumns),
      roleColors: roleColorsFromPanel(panel.roleColors),
    }
    const nextLogDir =
      typeof panel.logDir === 'string' && panel.logDir !== '' ? panel.logDir : patchCfg.logDir ?? join(dshHome(), 'hooks')
    if (nextLogDir !== logDir) {
      logDir = nextLogDir
      auditDirReady = false
    }
    void syncRoleRows(panel.routes ?? {})
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, PANEL_SCHEMA, baseEntry, {
      setSource: (current) => {
        settingsSource = current
        syncFromSettings()
      },
      onChange: () => {
        syncFromSettings()
      },
      validate: (value) => {
        if (!Number.isInteger(value.declarationThreshold) || value.declarationThreshold < 1) {
          throw new Error('collab-mode: declarationThreshold must be a positive integer')
        }
        if (!Number.isInteger(value.dockRows) || value.dockRows < 0 || value.dockRows > DOCK_ROWS_MAX) {
          throw new Error('collab-mode: dockRows must be an integer between 0 and ' + DOCK_ROWS_MAX)
        }
        if (!Number.isInteger(value.dockFold) || value.dockFold < 0 || value.dockFold > DOCK_FOLD_MAX) {
          throw new Error('collab-mode: dockFold must be an integer between 0 and ' + DOCK_FOLD_MAX)
        }
      },
    })
  })

  // 没有 settings 也要有七个角色工具（v0.1.0 行为不变）：先用组合层默认值建行。
  void syncRoleRows(baseEntry.routes)

  ctx.logger?.info(
    `collab-mode: active — gate=${live.gate} audit=${live.audit} warnOnTurnEnd=${live.warnOnTurnEnd} ` +
      `threshold=${live.declarationThreshold} logDir=${logDir}`,
  )

  /* ---- 1. 协作纪律提示段 ---- */
  ctx.systemPrompt.section({
    name: patchCfg.rulesSection,
    order: patchCfg.rulesOrder,
    text: RULES_TEXT,
  })

  /* ---- 2. 审计日志 ---- */

  /** 往 `<logDir>/activity-<sid>.log` 追加一行 JSON；失败静默，绝不打断工具链。 */
  function appendAudit(sid, record) {
    if (!live.audit) return
    try {
      if (!auditDirReady) {
        mkdirSync(logDir, { recursive: true })
        auditDirReady = true
      }
      const line = `${JSON.stringify(record)}\n`
      appendFileSync(join(logDir, `activity-${safeSessionId(sid)}.log`), line, { encoding: 'utf8' })
    } catch {
      /* 审计失败不影响工具执行 */
    }
  }

  /* ---- 2b. 子智能体运行可视化（只读状态，对话转录一行都不注入） ----
   *
   * 起止直接借已有的两个工具钩子（`tools/pre-execute` / `tools/post-execute`）：
   * 角色工具调用进来时记一行「开始」，出去时把同一 callId 翻成结束。列表按
   * 开始时间折叠，经自检路由（已过认证栅栏）暴露给对话窗口的 dock 卡。
   *
   * 为什么不用 `subagent/start|end`：那两个事件按委派方作用域派发，身上只有
   * `provider`（子智能体 provider 名，如 `spawn`）和子会话 id，**没有角色名**——
   * 圆桌三席并发时无法把某个 run 认领给 advisor-A/B/C。工具调用天然带 `exec.name`
   * 和逐次唯一的 `callId`，是唯一不歧义的键。
   *
   * 「真实 provider/model」读请求头，不信子智能体自报：优先取角色行上的
   * `agentOptions`（面板配的显式路由），留空则读委派方会话的
   * `session.requestHeader().config` —— 与 `dsh-tool-subagent` 的
   * `parentAgentOptionsForDelegation` / `resolveChildAgentOptions` 同一套继承语义。
   *
   * ⚠ 「没等到 post-execute」**不等于**卡死：前台委派（run_in_background 缺省关闭）
   * 的 post-execute 要等子智能体整轮跑完才来，实测有一次 executor 的 latency 是
   * 1970576ms（33 分钟）。只按 startedAt 超时判 stale，会把正在干活的 33 分钟全标成
   * 「无响应」。所以存活时间 `aliveAt` 由**子会话自己的活动**刷新，且**只刷新它自己
   * 那一行**（按 `session.header.id` 精确到行，未认领的行才按委派方会话粗刷）：
   *   - 子智能体每次工具调用（同一个 pre-execute 钩子，agent 是子会话）；
   *   - 子会话的工具跑完（post-execute，同一钩子）—— 静默长命令结束后立刻回正；
   *   - 子会话每帧流式输出（`agent/assistant-stream`，payload 带 agent）。
   * 精确到行是为了圆桌并发：兄弟席一直有活动时，被吞的那一席不该靠别人的活动续命
   * （旧行为是同一父会话下的在跑行一起刷新，于是那一席永远不转 stale）。
   *
   * 另有一个「在飞命令」例外：子会话正在跑一条无事件的静默长命令（几十秒的构建/测试）时，
   * 上面三种信号一个都不来，光靠 aliveAt 会把它误标成「无响应」。有在飞命令的行
   * （见 `childTools` / `childBusy`）按「正在干活」处理，存活时间报当前时刻。
   * 真被吞（拒绝/杀掉/dsh 重启）时子会话不再有任何活动，行才会在 N 秒后转 stale ——
   * 这正是简报要的「卡死/被吞」。
   *
   * ⚠ 重启后内存 Map 为空，但**已完成行从审计日志只读重建**（见 `auditRuns`）：
   * 重启不再等于整卡消失。running 行无从重建，重启即空 —— 这是设计，不是缺陷。
   */
  /** 列表上限：折叠成「最近 N 次委派」，防止长时间会话无限增长。 */
  const RUN_KEEP = 12
  /** 单份审计日志最多回看最近这么多行（防无界读）。 */
  const AUDIT_LOOKBACK = 50
  /**
   * 单份审计日志最多读多少**字节**（只读尾部，不整文件读入）。
   * 一行审计 JSON 约 200 字节，64 KB ≈ 300 行，够 AUDIT_LOOKBACK=50 用有余；
   * 更老的日志文件再大也不放大单次自检的同步读。
   */
  const AUDIT_TAIL_BYTES = 64 * 1024
  /** 超过这个时长没有任何存活信号 = stale（卡死/被吞）。 */
  const RUN_STALE_MS = 15000
  /** callId -> 一行运行记录（插入顺序 = 开始顺序）。 */
  const runs = new Map()
  /**
   * callId -> 子会话 id：子会话**在飞**的非委派工具调用。
   *
   * 它修的是误标：子会话跑一条无事件的静默长命令（几十秒的构建/测试）时，既没有
   * 流式帧也没有新的工具调用，只有 startedAt 在涨 —— 按旧的存活模型，15 秒后这行
   * 就被标成「无响应」，而它其实正在干活。有在飞命令 = 正在干活（见 childBusy）。
   */
  const childTools = new Map()

  /** 一个角色本次实际用的路由：角色行 agentOptions 优先，其次会话请求头。 */
  function effectiveRoute(agent, roleKey) {
    const loader = ctx.get('loader')
    const entry = loader === undefined ? undefined : resolveEntry(loader, roleEntryId(roleKey))
    const configured = entry?.options?.config?.agentOptions ?? null
    let header = null
    try {
      const session = agent?.session
      if (session !== null && typeof session === 'object' && typeof session.requestHeader === 'function') {
        header = session.requestHeader()?.config ?? null
      }
    } catch {
      header = null
    }
    const pick = (field) => {
      const fromRow = configured === null ? undefined : configured[field]
      if (typeof fromRow === 'string' && fromRow !== '') return { value: fromRow, source: 'row' }
      const fromHeader = header === null ? undefined : header[field]
      if (typeof fromHeader === 'string' && fromHeader !== '') return { value: fromHeader, source: 'header' }
      return { value: '', source: '' }
    }
    const provider = pick('provider')
    const model = pick('model')
    const effort = pick('reasoningEffort')
    return {
      provider: provider.value,
      model: model.value,
      reasoningEffort: effort.value,
      // 'row' = 面板给这个角色配了显式路由；'header' = 继承委派方会话的实际请求头。
      routeSource: provider.source === '' ? model.source : provider.source,
    }
  }

  /** pre-execute：角色工具调用开始。非角色工具只顺手刷一次子会话存活时间。 */
  function noteRunStart(exec) {
    if (!ROLE_TOOLS.has(exec.name)) {
      noteChildToolOpen(exec)
      touchChild(exec.agent)
      return
    }
    const startedAt = Date.now()
    const route = effectiveRoute(exec.agent, exec.name)
    runs.set(exec.callId, {
      callId: exec.callId,
      role: exec.name,
      sid: sessionIdOf(exec.agent) ?? 'unknown',
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      routeSource: route.routeSource,
      startedAt,
      aliveAt: startedAt,
      endedAt: 0,
      ok: null,
      ms: 0,
      // ---- 速率累积（只读；口径见 foldChildMetrics） ----
      /** 认领到的子会话 id（'' = 还没认领）。 */
      childSid: '',
      /** 这次委派的 prompt 头（用于同一父会话下有多个未认领行时精确认领）。 */
      promptHead: promptHeadOf(exec.arguments),
      /** 官方同源的任务标题（委派参数 description，即官方顶部抽屉显示的 label）。 */
      description: descriptionOf(exec.arguments),
      /** 已 settled 步的 outputTokens 累加；null = 还没有「timing 与 outputTokens 齐备」的步。 */
      rateTokens: null,
      /** 已 settled 步的 decodeMs 累加（decode = 组装消息时刻 − 首 token 时刻，TTFT 不在内）。 */
      rateDecodeMs: null,
      /** 当前未收口的那一步（官方 sessionStats 的同名字段）。 */
      openStep: null,
    })
    // 淘汰跳过在跑行：33 分钟的前台委派行一旦被 12 条新行挤掉，就再也认领不回它的
    // 子会话（认领靠 runs 里的行），dock 卡上也会凭空消失。只淘汰最老的一条已结束行。
    while (runs.size > RUN_KEEP) {
      let victim = null
      for (const [callId, record] of runs) {
        if (record.endedAt !== 0) {
          victim = callId
          break
        }
      }
      if (victim === null) break
      runs.delete(victim)
    }
  }

  /** 活动源（agent 或 session）→ 子会话自己的 id；不是子会话 / 读不到时返回 ''。 */
  function childSidOf(source) {
    try {
      const session = source?.session ?? source
      const id = session?.header?.id
      const parent = session?.header?.parentSession
      if (typeof id !== 'string' || id === '' || typeof parent !== 'string' || parent === '') return ''
      return id
    } catch {
      return ''
    }
  }

  /** 这一行名下还有在飞的命令调用吗（= 正在干活，静默长命令不该被判无响应）。 */
  function childBusy(record) {
    if (record.childSid === '') return false
    for (const sid of childTools.values()) {
      if (sid === record.childSid) return true
    }
    return false
  }

  /** 子会话的一次非委派工具调用开始：记下「在飞命令」。 */
  function noteChildToolOpen(exec) {
    const sid = childSidOf(exec.agent)
    if (sid !== '') childTools.set(exec.callId, sid)
  }

  /** 子会话的一次工具调用结束：摘掉「在飞命令」，并补刷一次存活时间。 */
  function noteChildToolEnd(exec) {
    childTools.delete(exec.callId)
    touchChild(exec.agent)
  }

  /**
   * 子会话的一次活动 → 刷新它自己那一行的存活时间。
   *
   * 认领靠 `session.header.parentSession`（子会话 header 上有委派方会话 id）；
   * 刷新按 `session.header.id` **精确到行**：圆桌三席并发时，兄弟席的活动不再给
   * 卡死那一行续命（旧行为是同一父会话下的在跑行一起刷新，于是被吞的那一席永远
   * 不转 stale）。还没认领到子会话的行保持原语义 —— 按委派方会话粗刷。
   * 传进来的可以是 agent 也可以是 session；没有 parentSession 时什么都不做
   * （父会话自己的活动不影响任何行）。
   */
  function touchChild(source) {
    if (runs.size === 0) return
    let parent = ''
    let childSid = ''
    try {
      const session = source?.session ?? source
      const fromHeader = session?.header?.parentSession
      if (typeof fromHeader === 'string') parent = fromHeader
      const id = session?.header?.id
      if (typeof id === 'string') childSid = id
    } catch {
      parent = ''
      childSid = ''
    }
    if (parent === '') return
    const now = Date.now()
    for (const record of runs.values()) {
      if (record.endedAt !== 0) continue
      if (record.childSid !== '') {
        if (record.childSid === childSid) record.aliveAt = now
        continue
      }
      if (record.sid === parent) record.aliveAt = now
    }
  }

  /** post-execute：同一 callId 翻成结束。钩子被吞（拒绝/被杀）时这行不执行 → 行留在 running。 */
  function noteRunEnd(exec, result) {
    const record = runs.get(exec.callId)
    if (record === undefined) return
    record.endedAt = Date.now()
    record.ok = result?.isError !== true
    record.ms = record.endedAt - record.startedAt
  }

  /* ---- 2c. 速率：子会话事件 → 各委派行的 settled 步累积（只读） ----
   *
   * 口径与官方输入框下的速度完全一致，逐字段照抄宿主侧的 `sessionStats` 投影
   * （`@deepseek-ai/dsh-session-stats`，客户端那半是 `deriveTurnMetrics`）：
   *
   *   step/start          开一步（记开始时刻，首 token 还没有）
   *   assistant/attempt   若本步还没记首 token，从它自己的流里取（step 内 llm/retry 后首 token 仍算）
   *   assistant/message   收口这一步：decode = event.time（组装消息时刻）− 首 token 时刻，
   *                       且**只有 usage.outputTokens 也有**才累加（两个都齐才算一步）
   *   step/end            关一步
   *
   * 「按 step last-wins」：`assistant/message` 收口后 `openStep` 置空，同一步再来一条不再重复累加；
   * turn/step 对不上的事件一律忽略（官方同）。`event.time` 就是官方口径里的 completedTime，
   * 首 token 时刻由 `streamFirstTokenTime` 从嵌入流里还原（与 `assistantStreamFirstTokenTime` 同算法）。
   *
   * 只读：不改审计写入、不新增写入路径、不往对话转录注入任何东西、不引入自定义事件类型。
   * 认领不到子会话（或子会话没上报 usage/timing）时计数保持 null → 客户端渲染「未知」，不编数字。
   */

  /** 这次委派的 prompt 头：同一父会话下有多个未认领行时用来精确认领（认领规则见 claimRun）。 */
  function promptHeadOf(args) {
    const prompt = args !== null && typeof args === 'object' && typeof args.prompt === 'string' ? args.prompt.trim() : ''
    return prompt === '' ? '' : prompt.slice(0, 120)
  }

  /** 委派参数里的任务标题（官方顶部抽屉显示的 label 同源；模型没传就是空）。 */
  function descriptionOf(args) {
    const text = args !== null && typeof args === 'object' && typeof args.description === 'string' ? args.description.trim() : ''
    return text === '' ? '' : text.slice(0, 120)
  }

  /** 官方 `usageOutputTokens`：provider 上报的输出 token 数，缺项或非法一律 null。 */
  function usageOutputTokens(usage) {
    if (usage === null || typeof usage !== 'object') return null
    const value = usage.outputTokens
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  }

  /** 官方 `isTokenDelta`：一个 chunk 算不算「吐了一个 token」。 */
  function isTokenDelta(chunk) {
    if (chunk === null || typeof chunk !== 'object') return false
    switch (chunk.type) {
      case 'text-delta':
      case 'reasoning-delta':
        return chunk.text !== ''
      case 'tool-call-delta':
        return chunk.argumentsDelta !== '' || chunk.name !== undefined
      default:
        return false
    }
  }

  /**
   * 官方 `firstRunMemberTime` / `runFirstTokenTime`：被打包的 delta run 里第一个
   * 合格成员的重构时刻（time0 加上逐项 dt）。形状不对就 null（官方会给 NaN，
   * 那会把 NaN 累进统计里；这里宁可未知）。
   */
  function runFirstTokenTime(run) {
    if (run === null || typeof run !== 'object' || !Number.isFinite(run.time0)) return null
    if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0
    const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts
    const dt = run.dt
    if (!Array.isArray(fragments) || !Array.isArray(dt)) return null
    let time = run.time0
    for (let index = 0; index < fragments.length; index += 1) {
      if (index > 0) {
        if (!Number.isFinite(dt[index - 1])) return null
        time += dt[index - 1]
      }
      if (fragments[index] !== '') return time
    }
    return null
  }

  /** 官方 `assistantStreamFirstTokenTime`：一条嵌入流里第一个 token delta 的时刻。 */
  function streamFirstTokenTime(stream) {
    if (!Array.isArray(stream)) return null
    for (const record of stream) {
      if (record === null || typeof record !== 'object') continue
      if (record.type === 'chunk') {
        if (isTokenDelta(record.chunk) && Number.isFinite(record.time)) return record.time
        continue
      }
      const time = runFirstTokenTime(record)
      if (time !== null) return time
    }
    return null
  }

  /**
   * 把一条 `session/event` 折进它所属委派行的速率累积。
   * 只认「和当前开着的那一步 turn/step 对齐」的事件，其余原样忽略（官方同）。
   */
  function foldChildMetrics(record, event) {
    const data = event?.data
    if (data === null || typeof data !== 'object') return
    if (event.type === 'step/start') {
      record.openStep =
        Number.isFinite(event.time) && Number.isFinite(data.turn) && Number.isFinite(data.step)
          ? { turn: data.turn, step: data.step, firstTokenTime: null }
          : null
      return
    }
    if (event.type === 'step/end') {
      record.openStep = null
      return
    }
    const open = record.openStep
    if (open === null || open === undefined) return
    if (data.turn !== open.turn || data.step !== open.step) return
    if (event.type === 'assistant/attempt') {
      if (open.firstTokenTime !== null) return
      const first = streamFirstTokenTime(data.stream)
      if (first !== null) open.firstTokenTime = first
      return
    }
    if (event.type !== 'assistant/message') return
    const firstToken = open.firstTokenTime === null ? streamFirstTokenTime(data.stream) : open.firstTokenTime
    record.openStep = null
    if (firstToken === null || !Number.isFinite(event.time)) return
    const outputTokens = usageOutputTokens(data.usage)
    if (outputTokens === null) return
    record.rateTokens = (record.rateTokens ?? 0) + outputTokens
    record.rateDecodeMs = (record.rateDecodeMs ?? 0) + Math.max(0, event.time - firstToken)
  }

  /**
   * 把一条子会话事件认领回某个在跑的委派行；认领不到返回 null（该事件丢掉，不猜）。
   *
   * 子会话 header 只给得出 `parentSession` —— 官方没有 callId ↔ 子会话的映射（
   * `subagent/descriptor` 里也没有），所以按这三档认领：
   *   1. 这个子会话已经认领过 → 直接返回那一行；
   *   2. 该父会话下只剩**一个**未认领的行 → 认领它（子会话按行的开始顺序创建，一一对应）；
   *   3. 多个未认领的行 → 用子会话的 user/message 正文与各行记下的 prompt 头比对，唯一命中才认领。
   * 仍不唯一就不认领 —— 宁可这一行速率未知，也不认错行、不编数字。
   */
  function claimRun(session, event) {
    const childSid = session?.header?.id
    if (typeof childSid !== 'string' || childSid === '') return null
    const parent = session?.header?.parentSession
    if (typeof parent !== 'string' || parent === '') return null
    const candidates = []
    for (const record of runs.values()) {
      if (record.childSid === childSid) return record
      if (record.childSid === '' && record.sid === parent) candidates.push(record)
    }
    if (candidates.length === 0) return null
    if (candidates.length === 1) {
      candidates[0].childSid = childSid
      return candidates[0]
    }
    if (event?.type !== 'user/message') return null
    const content = event.data?.content
    if (!Array.isArray(content)) return null
    const text = content
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    const hit = candidates.filter((record) => record.promptHead !== '' && text.includes(record.promptHead))
    if (hit.length !== 1) return null
    hit[0].childSid = childSid
    return hit[0]
  }

  /** 路径 → { size, mtimeMs, lines }：未变的审计文件跳过重读（自检 2 秒一次）。 */
  const auditTailCache = new Map()

  /**
   * 只读一个文件**尾部**至多 AUDIT_TAIL_BYTES 字节并切成行（整文件读入的替代）。
   *
   * `mtime + size` 没变就直接命中缓存，不再碰盘 —— 长会话里审计文件每次自检都在长，
   * 但两次自检之间往往没变，缓存把「每次自检都整文件读」摊成「变了才读尾部」。
   * 读不动 / 打不开一律返回 null（调用方跳过，绝不抛异常打断自检路由）；
   * 缓存条数封顶，避免很多会话的日志文件把内存撑起来。
   */
  function readTailLines(file) {
    let stat = null
    try {
      stat = statSync(file)
    } catch {
      return null
    }
    const cached = auditTailCache.get(file)
    if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.lines
    let lines = null
    let fd = -1
    try {
      const start = Math.max(0, stat.size - AUDIT_TAIL_BYTES)
      const length = stat.size - start
      const buffer = Buffer.allocUnsafe(length)
      fd = openSync(file, 'r')
      let read = 0
      while (read < length) {
        const got = readSync(fd, buffer, read, length - read, start + read)
        if (got <= 0) break
        read += got
      }
      lines = buffer.subarray(0, read).toString('utf8').split('\n')
      // 只可能截断在首行（从窗口起点开始的那一行半截）：丢掉它，宁可少一行也不解析半截 JSON。
      if (start > 0) lines = lines.slice(1)
    } catch {
      return null
    } finally {
      if (fd >= 0) {
        try {
          closeSync(fd)
        } catch {
          /* 关不掉的 fd 不值得打断自检 */
        }
      }
    }
    if (auditTailCache.size > 32) auditTailCache.clear()
    auditTailCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, lines })
    return lines
  }

  /**
   * 审计日志 → 已完成行（只读重建）。
   *
   * 为什么需要：`runs` 是 `apply()` 里的内存 Map，`dsh web` 一重启就空，dock 卡
   * 随之整卡不渲染 —— 用户看到的是「卡片找不到了」。审计日志 `<logDir>/activity-*.log`
   * 本来就逐次工具调用记了 `ts/sid/tool/target/ok/latency`，足够把**已完成**的委派行
   * 重建出来（running 行无从重建，重启即空正是设计）。
   *
   * 严格只读：不改审计写入格式、不新增写入路径。读也只读**尾部**（readTailLines：
   * 单文件字节上限 + mtime 缓存），长会话里日志涨到 MB 级也不会让每次自检卡在同步读上。
   * 任何一步失败都降级为空列表（= 退回纯内存行为），绝不抛异常打断自检路由。
   */
  function auditRuns() {
    const rows = []
    try {
      const files = readdirSync(logDir)
        .filter((f) => f.startsWith('activity-') && f.endsWith('.log'))
      // 最近写过的日志文件排前面：行数封顶时优先看真正有活动的会话。
      const ranked = files
        .map((f) => {
          const full = join(logDir, f)
          let ms = 0
          try {
            ms = statSync(full).mtimeMs
          } catch {
            ms = 0
          }
          return { full, ms }
        })
        .sort((a, b) => b.ms - a.ms)

      for (const { full } of ranked) {
        if (rows.length >= AUDIT_LOOKBACK) break
        const lines = readTailLines(full)
        if (lines === null) continue
        // 只回看最近 AUDIT_LOOKBACK 行（尾部窗口之内，再用行数封一次顶）。
        const from = Math.max(0, lines.length - AUDIT_LOOKBACK)
        for (let i = lines.length - 1; i >= from; i -= 1) {
          if (rows.length >= AUDIT_LOOKBACK) break
          const line = lines[i].trim()
          if (line === '') continue
          let record = null
          try {
            record = JSON.parse(line)
          } catch {
            continue
          }
          if (record === null || typeof record !== 'object') continue
          const tool = typeof record.tool === 'string' ? record.tool : ''
          if (!ROLE_TOOLS.has(tool)) continue
          const endedAt = Date.parse(typeof record.ts === 'string' ? record.ts : '')
          if (!Number.isFinite(endedAt)) continue
          const latency = Number.isFinite(record.latency) && record.latency > 0 ? record.latency : 0
          const sid = typeof record.sid === 'string' && record.sid !== '' ? record.sid : 'unknown'
          const startedAt = endedAt - latency
          rows.push({
            // 合成 callId 防碰撞：审计行没有 callId，用 sid+ts+序号拼一个稳定键。
            callId: `audit-${sid}-${endedAt}-${rows.length}`,
            role: tool,
            sid,
            // 审计日志里没有路由信息（不改写入格式就拿不到）→ 留空，客户端显示「路由未知」。
            provider: '',
            model: '',
            reasoningEffort: '',
            routeSource: '',
            startedAt,
            aliveAt: endedAt,
            endedAt,
            running: false,
            stale: false,
            ok: record.ok === true,
            ms: latency,
            // 审计六字段里没有 token 列（不改写入格式就拿不到）→ 速率同样未知。
            rateTokens: null,
            rateDecodeMs: null,
            // 内部字段：重建行参与合并后即丢弃，projection 不输出。
            fromAudit: true,
          })
        }
      }
    } catch {
      /* 目录不存在/读不动 → 纯内存，什么都不加 */
    }
    return rows
  }

  /** 内存行 → projection 行（running/stale 按**当前时刻**重算）。 */
  function memoryRuns(now) {
    const list = []
    for (const record of runs.values()) {
      const running = record.endedAt === 0
      // 有在飞命令的子会话（无事件的静默长命令）＝ 正在干活：存活时间报当前时刻。
      // 必须报新值，不能只把 stale 标记压住 —— 客户端另按 aliveAt 自己算 stale（1 秒 tick），
      // 宿主只压标记的话卡片照样在 15 秒后置灰。
      const busy = running && childBusy(record)
      const aliveAt = busy ? now : record.aliveAt
      list.push({
        callId: record.callId,
        role: record.role,
        sid: record.sid,
        provider: record.provider,
        model: record.model,
        reasoningEffort: record.reasoningEffort,
        routeSource: record.routeSource,
        startedAt: record.startedAt,
        aliveAt,
        endedAt: record.endedAt,
        running,
        stale: running && !busy && now - aliveAt > RUN_STALE_MS,
        ok: running ? null : record.ok,
        ms: running ? now - record.startedAt : record.ms,
        // 速率：已 settled 步的 outputTokens / decodeMs 累加（null = 还没有可计步）。
        // 运行中只按已收口的步给数，所以在吐字过程中这两个数不会变（与官方同语义）。
        rateTokens: record.rateTokens,
        rateDecodeMs: record.rateDecodeMs,
        // 任务名：委派 prompt 前 120 字（老行回落用），审计行没有。
        task: record.promptHead,
        // 卡片标题：官方同源 description，审计行没有。
        title: record.description,
        // 子会话 id：跳转按钮的地址（认领成功后才有；审计行没有，无按钮）。
        childSid: record.childSid,
        fromAudit: false,
      })
    }
    return list
  }

  /**
   * 折叠成列表 projection。每次读取按**当前时刻**重算 running/stale（不起定时器）：
   * stale 看的是 aliveAt（最后一次存活信号），不是 startedAt —— 见 2b 区块顶部说明。
   *
   * 排序后与审计重建行合并再截 RUN_KEEP：内存行里已经有同一次委派的（重启前刚跑完、
   * 行还在 Map 里），就不再从日志重复补一遍。
   */
  function runsProjection() {
    const now = Date.now()
    const memory = memoryRuns(now)

    // 去重：审计行与内存里的**已结束**行，角色相同且结束时刻落在同一段（±RUN_STALE_MS）即同一行。
    const claimed = new Set()
    const reconstructed = []
    for (const row of auditRuns()) {
      let matched = false
      for (const mem of memory) {
        if (claimed.has(mem.callId) || mem.role !== row.role || mem.running) continue
        if (Math.abs(mem.endedAt - row.endedAt) > RUN_STALE_MS) continue
        claimed.add(mem.callId)
        matched = true
        break
      }
      if (!matched) reconstructed.push(row)
    }

    const list = [...memory, ...reconstructed]
    list.sort((a, b) => a.startedAt - b.startedAt)
    // 截断同样跳过在跑行：跑了半小时的前台委派不该被一串新行挤出列表
    // （内存 Map 的淘汰照同一条规则，见 noteRunStart，否则那一行连认领都认不回来）。
    const active = list.filter((row) => row.running || row.stale)
    const done = list.filter((row) => !(row.running || row.stale))
    const kept = list.length > RUN_KEEP
      ? [...done.slice(Math.max(0, done.length - Math.max(0, RUN_KEEP - active.length))), ...active]
      : list
    kept.sort((a, b) => a.startedAt - b.startedAt)
    // 内部字段不外泄（认领与流解析用的中间态）：projection 的字段与 2b 原有形状逐字一致，
    // 另加 rateTokens / rateDecodeMs 两个速率字段、task 任务名与 childSid 跳转地址。
    return kept.map(({ fromAudit, promptHead, description, openStep, ...row }) => row)
  }

  /**
   * 速率累积的事件源：`session/event` 火管。
   *
   * 为什么这条缝可用（2026-09-15 读 `@deepseek-ai/dsh-session` 与 `@deepseek-ai/dsh-scope` 实证）：
   * 会话服务的 `append()` 走 `ctx.events.dispatch('emit', [carrier, 'session/event', session, event])`，
   * 而 `ctx.events` 在**整棵 ctx 树上共用同一个实例**（子 ctx 是 `Object.create(parent)`，
   * 只有根 ctx 构造 `new EventsService()`），唯一的过滤是 scope carrier 的 filter：
   * `const tag = scopeOf(hook.ctx); if (tag === undefined) return true` —— 无 scope 标签的监听者
   * 收**所有**会话的事件。本插件挂在 Host 平面（root → dsh-base → dsh-web-app → 本 bundle），
   * 没有任何 `createScope` 包裹（那三处调用点在 dsh-agent-loop / dsh-agent-presets /
   * dsh-api-session-controller，都在会话自己的作用域里），因此子智能体会话的事件也会到这里。
   *
   * 认领与累积见 `claimRun` / `foldChildMetrics`；两个都只读，任何一步失败都只是让那一行
   * 速率保持未知，绝不影响工具链、审计写入与对话转录。
   */
  ctx.on('session/event', (session, event) => {
    if (runs.size === 0) return
    const record = claimRun(session, event)
    if (record === null) return
    foldChildMetrics(record, event)
  })

  /**
   * 存活信号之一：子会话每帧流式输出都会派发 `agent/assistant-stream`
   * （payload 由 `agentEvents` 融进了 `agent`）。这是「子智能体正在思考/正在吐字」
   * 唯一可用的细粒度信号 —— 一秒几十帧的热路径，所以先看 runs 是否为空、
   * 再读一次 parentSession，不做任何分配。
   */
  ctx.on('agent/assistant-stream', (payload) => {
    if (runs.size === 0) return
    touchChild(payload?.agent)
  })

  /* ---- 3. 改动前拦截 ---- */
  ctx.on('tools/pre-execute', async (exec, next) => {
    startedAt.set(exec.callId, Date.now())
    if (startedAt.size > 5000) startedAt.clear()
    noteRunStart(exec)

    if (!live.gate) return next()
    if (!WRITE_TOOLS.has(exec.name)) return next()

    const state = stateFor(exec.agent)
    if (state === null) return next()

    const args = exec.arguments
    const rawTarget = args !== null && typeof args === 'object' && typeof args.file_path === 'string' ? args.file_path : ''
    if (rawTarget.trim() === '') return next()

    const cwd = cwdOf(exec.agent)
    const target = normalizePath(rawTarget, cwd)
    if (isExcluded(target, homeNorm)) return next()

    state.seen.add(target)

    const briefs = collectBriefs(cwd, [target])
    const cache = new Map()
    if (isDeclared(target, briefs, cache)) return next()

    const undeclared = [...state.seen].filter((p) => !isDeclared(p, briefs, cache))
    if (undeclared.length < live.declarationThreshold) return next()

    return {
      kind: 'deny',
      reason:
        `FLOW_GATE: 本会话已改动 ${undeclared.length} 个没有任何任务简报声明的生产文件，本次 ${exec.name} 被拒绝。` +
        `未声明：${listNames(undeclared)} 。` +
        `按协作纪律，累计改动 ≥${live.declarationThreshold} 个文件必须走 B 类流程：` +
        `写 .work/task-<关键词>.md（并行会话各用各的文件）列出你要动的文件，再用 executor 执行、code-reviewer 审查。` +
        `把这些文件名登记进简报后即可继续。` +
        `[cwd=${cwd} briefs=${briefs.length} threshold=${live.declarationThreshold}]`,
    }
  })

  /* ---- 4. 审计：每次工具调用一行 ---- */
  ctx.on('tools/post-execute', async (exec, result, next) => {
    noteRunEnd(exec, result)
    // 子会话的工具跑完 = 一次新的存活信号：静默长命令结束后存活时间立刻回正，
    // 那一行不会停在「无响应」上等人（在飞命令也在这里摘掉）。
    noteChildToolEnd(exec)
    const started = startedAt.get(exec.callId)
    startedAt.delete(exec.callId)
    const latency = started === undefined ? 0 : Date.now() - started
    const sid = sessionIdOf(exec.agent) ?? 'unknown'
    const ok = result?.isError !== true

    appendAudit(sid, {
      ts: new Date().toISOString(),
      sid: safeSessionId(sid),
      tool: exec.name,
      target: targetOf(exec),
      ok,
      latency,
    })

    // 成功的写操作登记进「本会话已改动」，供轮次结束告警使用。
    if (ok && WRITE_TOOLS.has(exec.name)) {
      const state = stateFor(exec.agent)
      const args = exec.arguments
      const rawTarget =
        args !== null && typeof args === 'object' && typeof args.file_path === 'string' ? args.file_path : ''
      if (state !== null && rawTarget.trim() !== '') {
        const target = normalizePath(rawTarget, cwdOf(exec.agent))
        if (!isExcluded(target, homeNorm)) state.changed.add(target)
      }
    }

    return next()
  })

  /* ---- 5. 轮次结束告警 ---- */
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    if (!live.warnOnTurnEnd) return

    const state = existingState(agent)
    if (state === undefined || state.changed.size === 0) return

    const cwd = cwdOf(agent)
    const briefs = collectBriefs(cwd, state.changed)
    const cache = new Map()
    const undeclared = [...state.changed].filter((p) => !isDeclared(p, briefs, cache))
    if (undeclared.length < live.declarationThreshold) return

    // 同一组未声明文件只告警一次：状态没变化就不再重复，避免每轮结束都刷屏。
    const key = [...undeclared].sort().join('|')
    if (state.warnedKeys.has(key)) return
    state.warnedKeys.add(key)

    const text =
      `FLOW_DRIFT: 本会话已改动 ${undeclared.length} 个没有任何任务简报声明的生产文件，本轮结束前请先补简报。` +
      `未声明：${listNames(undeclared)} 。` +
      `把这些文件名登记进 .work/task-<关键词>.md（或 .work/current-task.md）后即可继续；` +
      `若这几个文件本来就该由 executor 执行，请走 B 类流程。` +
      `[turn=${turn} cwd=${cwd} briefs=${briefs.length}]`

    appendAudit(sessionIdOf(agent) ?? 'unknown', {
      ts: new Date().toISOString(),
      sid: safeSessionId(sessionIdOf(agent) ?? 'unknown'),
      tool: 'collab-mode:turn-warning',
      target: listNames(undeclared),
      ok: false,
      latency: 0,
    })

    // steer = 拦下这次收尾：驱动会重读收件箱，多走一步让模型处理这条告警。
    agent.steer(pluginMessage(text))
  })

  /* ---- 6. 自检桥（面板 C 区块的数据源） ---- */

  /* ---- 6b. 面板展示用的只读元数据（ZCode 子智能体页同款：描述/颜色/工具） ----
   *
   * 来源是仓库 `content/manifest.json` 的 zcode 块 —— 与 ZCode 生成器、ZCode 部署
   * 读的是同一份源，不是手写第二份。读不到就回退空值，面板隐藏对应展示、不报错。
   */
  let manifestRoles = null
  let manifestLoaded = false
  function roleMeta(key) {
    if (!manifestLoaded) {
      manifestLoaded = true
      try {
        const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'content', 'manifest.json'), 'utf8'))
        manifestRoles = Array.isArray(manifest?.roles) ? manifest.roles : null
      } catch {
        manifestRoles = null
      }
    }
    if (manifestRoles === null) return null
    const direct = manifestRoles.find((r) => r?.key === key)
    if (direct !== undefined) return direct?.zcode ?? null
    // advisor-A/B/C 三席共用 advisor 一条。
    const base = key.replace(/-[ABC]$/, '')
    return manifestRoles.find((r) => r?.key === base)?.zcode ?? null
  }

  /* ---- 6c. 可用模型目录（编辑页"模型"下拉的数据源，只读） ----
   *
   * 读 `llm` 服务的注册供应商 + 各自广告的模型（与 `list_subagent_models` 同一来源，
   * 但不过会话 policy 过滤：面板要的是全目录）。60 秒缓存；任何一步失败就整体
   * 回退 null，面板降级用单级下拉/文本输入，绝不让自检变红。
   */
  let catalogCache = { at: 0, llm: null, value: null }
  async function modelCatalog(serverCtx) {
    const now = Date.now()
    // llm 服务引用先解析：缓存按引用键化，不同引用（夹具里的桩）互不污染。
    let llm
    try {
      llm = serverCtx !== null && typeof serverCtx === 'object' && typeof serverCtx.get === 'function'
        ? serverCtx.get('llm')
        : undefined
    } catch {
      llm = undefined
    }
    const key = llm ?? null
    if (now - catalogCache.at < 60000 && catalogCache.llm === key) return catalogCache.value
    let value = null
    try {
      if (llm !== undefined && llm !== null && typeof llm.listProviders === 'function') {
        const providers = llm.listProviders()
        if (Array.isArray(providers) && providers.length > 0) {
          const rows = []
          for (const p of providers) {
            if (p === null || typeof p !== 'object' || typeof p.id !== 'string' || p.id === '') continue
            let models = []
            try {
              const listed = await llm.listModels(p.id)
              if (Array.isArray(listed)) {
                models = listed
                  .filter((m) => m !== null && typeof m === 'object' && typeof m.id === 'string' && m.id !== '')
                  .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id }))
              }
            } catch {
              models = []
            }
            rows.push({ id: p.id, name: typeof p.name === 'string' && p.name !== '' ? p.name : p.id, models })
          }
          if (rows.length > 0) value = { providers: rows }
        }
      }
    } catch {
      value = null
    }
    catalogCache = { at: now, llm: key, value }
    return value
  }

  /* ---- 6d. 模型档位目录（编辑页"推理强度"下拉的数据源，只读） ----
   *
   * 调 `llm.resolveModelInfo(provider, model)` 拿该模型的 advertised 档位——
   * 对话窗口的模型下拉就是这么渲染的（见 dsh-tool-subagent 的 list_subagent_models，
   * 读 `model.reasoning.efforts[]` + `defaultEffort`）。
   * 单条缓存 60 秒（按 llm 引用 + provider/model 键化）；查不到或模型无档位概念
   * 就回 null，面板回退静态全集，绝不让路由变红。
   */
  let effortsCache = { at: 0, llm: null, key: '', value: null }
  async function modelEfforts(serverCtx, provider, model) {
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return null
    let llm
    try {
      llm = serverCtx !== null && typeof serverCtx === 'object' && typeof serverCtx.get === 'function'
        ? serverCtx.get('llm')
        : undefined
    } catch {
      llm = undefined
    }
    const ref = llm ?? null
    const key = `${provider}\n${model}`
    const now = Date.now()
    if (now - effortsCache.at < 60000 && effortsCache.llm === ref && effortsCache.key === key) return effortsCache.value
    let value = null
    try {
      if (llm !== undefined && llm !== null && typeof llm.resolveModelInfo === 'function') {
        const info = await llm.resolveModelInfo(provider, model)
        const reasoning = info !== null && typeof info === 'object' ? info.reasoning : undefined
        const listed = reasoning !== null && typeof reasoning === 'object' && Array.isArray(reasoning.efforts)
          ? reasoning.efforts
          : []
        const rows = []
        for (const e of listed) {
          if (e === null || typeof e !== 'object' || typeof e.id !== 'string' || e.id === '') continue
          rows.push({ id: e.id, name: typeof e.name === 'string' && e.name !== '' ? e.name : e.id })
        }
        if (rows.length > 0) {
          const def = reasoning !== null && typeof reasoning === 'object' && typeof reasoning.defaultEffort === 'string'
            ? reasoning.defaultEffort
            : ''
          value = { provider, model, efforts: rows, defaultEffort: rows.some((r) => r.id === def) ? def : '' }
        }
      }
    } catch {
      value = null
    }
    effortsCache = { at: now, llm: ref, key, value }
    return value
  }

  /** 从 exact 路由的 req.url 里取 query 参数（取不到即 ''）。 */
  function queryParam(req, name) {
    try {
      const url = req !== null && typeof req === 'object' && typeof req.url === 'string' ? req.url : ''
      if (url === '') return ''
      return new URL(url, 'http://localhost').searchParams.get(name) ?? ''
    } catch {
      return ''
    }
  }

  /** 七个角色工具**实际**注册在哪、各自实际解析到的路由。 */
  function inspectRoles() {
    const loader = ctx.get('loader')
    const rows = []
    for (const role of ROLES) {
      const id = roleEntryId(role.key)
      const entry = loader === undefined ? undefined : resolveEntry(loader, id)
      const config = entry?.options?.config
      const agentOptions = config?.agentOptions
      // 面板列表/编辑页的只读展示字段（描述/色标/工具/人设全文均只读，不可编辑）。
      const meta = roleMeta(role.key)
      const denyList = Array.isArray(config?.toolFilter?.deny) ? [...config.toolFilter.deny] : []
      rows.push({
        key: role.key,
        tool: role.tool,
        entryId: id,
        // 「已注册」= 该工具真的在当前可见工具集里（不是只建了 loader 行）。
        registered: ctx.tools.get(role.tool) !== undefined,
        entryPresent: entry !== undefined,
        active: entry?.fiber !== undefined,
        readonly: role.readonly,
        // 实际生效值：loader 行上的 agentOptions（空 = 继承父会话路由）。
        provider: agentOptions?.provider ?? '',
        model: agentOptions?.model ?? '',
        reasoningEffort: agentOptions?.reasoningEffort ?? '',
        maxTokens: agentOptions?.maxTokens ?? 0,
        deniedTools: denyList.length,
        denied: denyList,
        personaChars: typeof config?.persona === 'string' ? config.persona.length : 0,
        persona: typeof config?.persona === 'string' ? config.persona : '',
        description: typeof meta?.description === 'string' ? meta.description : '',
        color: typeof meta?.color === 'string' ? meta.color : '',
        tools: Array.isArray(meta?.tools) ? [...meta.tools] : [],
      })
    }
    return rows
  }

  /**
   * 审计日志目录里最新的那一条记录（面板 C 区块「最近一条审计」）。
   * 同样只读尾部（readTailLines）：不因为要看最后一行就把整份日志读进来。
   */
  function lastAudit() {
    try {
      const files = readdirSync(logDir)
        .filter((f) => f.startsWith('activity-') && f.endsWith('.log'))
        .map((f) => join(logDir, f))
      if (files.length === 0) return null
      let newest = null
      let newestMs = -1
      for (const file of files) {
        const ms = statSync(file).mtimeMs
        if (ms > newestMs) {
          newestMs = ms
          newest = file
        }
      }
      if (newest === null) return null
      const lines = readTailLines(newest)
      if (lines === null) return null
      // 尾部窗口可能以换行收尾：从后往前找第一条非空行。
      let last = ''
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].trim() !== '') {
          last = lines[i].trim()
          break
        }
      }
      if (last === '') return null
      const record = JSON.parse(last)
      return {
        file: parse(newest).base,
        ts: record.ts ?? '',
        tool: record.tool ?? '',
        target: typeof record.target === 'string' ? record.target.slice(0, 120) : '',
        ok: record.ok === true,
        latency: typeof record.latency === 'number' ? record.latency : 0,
      }
    } catch {
      return null
    }
  }

  /**
   * 自检区快照：面板每次打开/刷新都会拉一次。
   *
   * `updateInfo` = 远端版本比对的只读结果（`{ local, remote|null, behind }`）；拿不到
   * 远端时 `remote` 为 null、`behind` 为 false —— 离线的正常态，不是错误。
   */
  async function selfCheck() {
    let version = ''
    try {
      version = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version ?? ''
    } catch {
      version = 'unknown'
    }
    // 冷缓存时等一次「预热抓取」（≤8 秒熔断）：面板第一次打开就能拿到 behind 判定。
    // 之后一律读缓存 —— 2 秒一次的轮询不会放大远端请求（TTL 1 小时）。
    if (updateCache.at === 0 && updateInflight !== null) {
      try {
        await updateInflight
      } catch {
        /* 失败静默：拿不到远端就是 remote null */
      }
    }
    const remote = cachedRemoteVersion()
    return {
      version,
      updateInfo: {
        local: version,
        remote,
        behind: remote !== null && versionIsBehind(version, remote),
      },
      namespace: NS,
      rulesSection: patchCfg.rulesSection,
      rulesChars: RULES_TEXT.length,
      logDir,
      live: {
        gate: live.gate,
        audit: live.audit,
        warnOnTurnEnd: live.warnOnTurnEnd,
        declarationThreshold: live.declarationThreshold,
        // 运行卡的显示形态（客户端 C 区块开关写的值；这里只回读给自检对照）。
        dockCardVisible: live.dockCardVisible,
        dockRows: live.dockRows,
        dockFold: live.dockFold,
        dockColumns: { ...live.dockColumns },
        // 角色标记色（编辑页写、三处显示面读；非法值已在这一层回落默认色）。
        roleColors: { ...live.roleColors },
      },
      roles: inspectRoles(),
      lastAudit: lastAudit(),
      // 2b 区块的运行列表：dock 卡的唯一数据源（只读新增字段，不影响既有字段）。
      runs: runsProjection(),
      runsStaleMs: RUN_STALE_MS,
      // 第 7 节探针：面板 C 区块不动 UI，JSON 里可见即可。
      opencodeFreeRelay: opencodeFreeRelayInstalled(),
    }
  }

  ctx.inject(['webServer', 'connection'], (serverCtx) => {
    const sendJson = (res, status, payload) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }
    /**
     * 走 composition 的信任栅栏。
     *
     * ⚠ 这一步不能省：`webServer.match()` 是「exact 表优先，未命中再比 prefix」，
     * 而 `dsh-client-connection` 的信任栅栏挂在 `/api` 的 **prefix** 路由上。
     * 本路由是 `/api/...` 下的 **exact** 路由，因此**优先级高于那道栅栏** ——
     * 不自己校验就会绕过 Host/Origin 栅栏与浏览器认证，任何本机进程都能读到
     * 日志目录、审计目标等运行时事实。实测过：不带 cookie 直接 200，
     * 而随便一个不存在的 `/api` 路径是 401。
     *
     * `requestRejection` 是官方栅栏入口（`dsh-host-open-in-app` 同样用法）。
     * 拿不到 connection 服务时**拒绝服务**，而不是放行。
     */
    const rejected = (req, res) => {
      // 已声明注入，因此按注入面取（官方 dsh-host-open-in-app 用 Reflect.get 取同一服务）。
      const connection = serverCtx.connection
      if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
        sendJson(res, 503, { ok: false, code: 'no-trust-fence', message: 'connection service unavailable' })
        return true
      }
      const rejection = connection.requestRejection(req)
      if (rejection === undefined) return false
      res.statusCode = rejection
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return true
    }
    serverCtx.effect(
      () => {
        const offSelfcheck = serverCtx.webServer.register({
          kind: 'exact',
          path: `/api/${NS}/selfcheck`,
          handler: async (req, res) => {
            if (rejected(req, res)) return
            if (req.method !== 'GET') {
              res.statusCode = 405
              res.setHeader('allow', 'GET')
              res.end()
              return
            }
            try {
              const value = await selfCheck()
              // 模型目录是 best-effort：拿不到就 null，面板降级，绝不 500。
              try {
                value.modelCatalog = await modelCatalog(serverCtx)
              } catch {
                value.modelCatalog = null
              }
              sendJson(res, 200, { ok: true, value })
            } catch (error) {
              sendJson(res, 500, { ok: false, code: 'selfcheck-failed', message: String(error && error.message) })
            }
          },
        })
        const offEfforts = serverCtx.webServer.register({
          kind: 'exact',
          path: `/api/${NS}/model-efforts`,
          handler: async (req, res) => {
            if (rejected(req, res)) return
            if (req.method !== 'GET') {
              res.statusCode = 405
              res.setHeader('allow', 'GET')
              res.end()
              return
            }
            const provider = queryParam(req, 'provider')
            const model = queryParam(req, 'model')
            if (provider === '' || model === '') {
              sendJson(res, 400, { ok: false, code: 'bad-request', message: 'query provider and model are required' })
              return
            }
            try {
              // 查不到就 efforts null：面板回退静态全集，绝不 500。
              const found = await modelEfforts(serverCtx, provider, model)
              sendJson(res, 200, {
                ok: true,
                value: found === null
                  ? { provider, model, efforts: null, defaultEffort: '' }
                  : found,
              })
            } catch (error) {
              sendJson(res, 500, { ok: false, code: 'efforts-failed', message: String(error && error.message) })
            }
          },
        })
        return () => {
          offSelfcheck()
          offEfforts()
        }
      },
      'collab-mode: self-check route',
    )
  })

  // ---- 7. opencode free 回传剥除：装全局 fetch 窄包装（仅 opencode.ai 域）----
  installOpencodeFreeRelay()
  // ---- 8. 远端版本预热：后台抓一次（不 await），只为让面板第一次打开时缓存已就绪 ----
  void refreshRemoteVersion()
  // fiber 停止时拆掉（HMR/重载不留残留）；夹具 ctx 没有 effect，守卫跳过。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => uninstallOpencodeFreeRelay())
  }
}
