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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

/** 面板的全部可编辑项。A 区块 = routes，B 区块 = 三个开关 + 阈值。 */
const PANEL_SCHEMA = z.object({
  routes: z
    .object(Object.fromEntries(ROLES.map((role) => [role.key, RoleRoute])))
    .default({}),
  gate: z.boolean().default(true),
  audit: z.boolean().default(true),
  warnOnTurnEnd: z.boolean().default(true),
  declarationThreshold: z.number().default(3),
  logDir: z.string().default(''),
})

/** 角色行的 loader entry id（与 v0.1.0 的 id 保持一致，便于识别）。 */
const roleEntryId = (key) => `collab-${key}`

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

  /* ---- 3. 改动前拦截 ---- */
  ctx.on('tools/pre-execute', async (exec, next) => {
    startedAt.set(exec.callId, Date.now())
    if (startedAt.size > 5000) startedAt.clear()

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

  /** 七个角色工具**实际**注册在哪、各自实际解析到的路由。 */
  function inspectRoles() {
    const loader = ctx.get('loader')
    const rows = []
    for (const role of ROLES) {
      const id = roleEntryId(role.key)
      const entry = loader === undefined ? undefined : resolveEntry(loader, id)
      const config = entry?.options?.config
      const agentOptions = config?.agentOptions
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
        deniedTools: Array.isArray(config?.toolFilter?.deny) ? config.toolFilter.deny.length : 0,
        personaChars: typeof config?.persona === 'string' ? config.persona.length : 0,
      })
    }
    return rows
  }

  /** 审计日志目录里最新的那一条记录（面板 C 区块「最近一条审计」）。 */
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
      const lines = readFileSync(newest, 'utf8').trim().split('\n')
      const last = lines[lines.length - 1]
      if (last === undefined || last === '') return null
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

  /** 自检区快照：面板每次打开/刷新都会拉一次。 */
  function selfCheck() {
    let version = ''
    try {
      version = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version ?? ''
    } catch {
      version = 'unknown'
    }
    return {
      version,
      namespace: NS,
      rulesSection: patchCfg.rulesSection,
      rulesChars: RULES_TEXT.length,
      logDir,
      live: {
        gate: live.gate,
        audit: live.audit,
        warnOnTurnEnd: live.warnOnTurnEnd,
        declarationThreshold: live.declarationThreshold,
      },
      roles: inspectRoles(),
      lastAudit: lastAudit(),
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
      () =>
        serverCtx.webServer.register({
          kind: 'exact',
          path: `/api/${NS}/selfcheck`,
          handler: (req, res) => {
            if (rejected(req, res)) return
            if (req.method !== 'GET') {
              res.statusCode = 405
              res.setHeader('allow', 'GET')
              res.end()
              return
            }
            try {
              sendJson(res, 200, { ok: true, value: selfCheck() })
            } catch (error) {
              sendJson(res, 500, { ok: false, code: 'selfcheck-failed', message: String(error && error.message) })
            }
          },
        }),
      'collab-mode: self-check route',
    )
  })
}
