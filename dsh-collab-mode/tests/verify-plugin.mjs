#!/usr/bin/env node
/**
 * 离线验收夹具：在**全新 Node 进程**里加载交付的那份 `lib/index.js`，
 * 用假的 ctx / agent 驱动三个钩子与 v0.2.0 的 loader 行管理，
 * 逐条断言验收标准与面板下发机制。
 *
 * 为什么需要它：cordis 的 HMR 只监听补丁文件（`cordis-plugin-hmr` 的 `root: []`），
 * 不监听模块文件，且 loader 对已解析过的包复用 ESM 模块缓存，因此**改完代码无法在
 * 运行中的进程里热更新**。本夹具用新进程加载当前磁盘上的那份代码，补上这块证据。
 *
 * ⚠ 夹具只覆盖 Host 半侧（`lib/index.js`）。客户端 `lib/client.js` 需要 React + DOM，
 * 不在覆盖范围内——凡是依赖注入时机的客户端行为，必须活体验证（重启 dsh web 看面板）。
 *
 * 运行：npm test   （或 node tests/verify-plugin.mjs）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `lib/index.js` 依赖 @deepseek-ai/schemastery；未安装依赖时给可操作提示而非裸抛。 */
let apply
try {
  ;({ apply } = await import('../lib/index.js'))
} catch (error) {
  if (String(error?.code) === 'ERR_MODULE_NOT_FOUND') {
    console.error('夹具无法加载 lib/index.js：缺少依赖。先装再跑：')
    console.error('  npm install')
    console.error('（或 dsh plugin --profile web add <本目录>，让它一并装依赖）')
    console.error('\n原始错误：' + error.message)
    process.exit(2)
  }
  throw error
}

// 第 7 节导出的修复函数（与 apply 同一模块实例，标记位共享）。
const { installOpencodeFreeRelay, uninstallOpencodeFreeRelay, opencodeFreeRelayInstalled } = await import('../lib/index.js')

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * 假的 loader：只实现插件真正用到的那几件（resolve / create / update），
 * 并把每次 update 记下来，供断言「面板保存后角色行确实被改写」。
 */
function makeFakeLoader() {
  const entries = new Map()
  const calls = { create: [], update: [], write: 0 }
  return {
    entries,
    calls,
    service: {
      resolve(id) {
        const entry = entries.get(id)
        if (entry === undefined) throw new Error(`cannot resolve entry ${id}`)
        return entry
      },
      async create(options) {
        calls.create.push(options.id)
        entries.set(options.id, { id: options.id, options, fiber: {} })
        return options.id
      },
      async update(id, options) {
        calls.update.push({ id, options })
        const entry = entries.get(id)
        if (entry === undefined) throw new Error(`cannot resolve entry ${id}`)
        entry.options = { ...entry.options, ...options }
        return undefined
      },
      // Loader.write() 在真实实现里是空实现；夹具断言插件从不让它落盘。
      write() {
        calls.write += 1
      },
    },
  }
}

/** 假的 settings 服务：installSection 记下 hooks，测试用它模拟「用户在面板里保存」。 */
function makeFakeSettings() {
  const sections = []
  return {
    sections,
    service: {
      installSection(owner, ns, schema, entry, hooks) {
        sections.push({ ns, schema, entry, hooks })
      },
    },
  }
}

/** 假的 webServer：只记路由，供断言自检路由的注册与栅栏行为。 */
function makeFakeWebServer() {
  const routes = []
  return {
    routes,
    service: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
}

/** 假的 connection 信任栅栏：`rejection` 决定 requestRejection 的返回值。 */
function makeFakeTrustFence() {
  // 用一个稳定对象承载状态：夹具每次注入都会新建注入面对象，若把 rejection 存在
  // 服务对象自身上，测试改了 fence.rejection 也影响不到插件拿到的那份引用。
  const state = { rejection: undefined }
  return {
    fence: state,
    service: {
      requestRejection() {
        return state.rejection
      },
    },
  }
}

function makeCtx(services = {}) {
  const handlers = new Map()
  const sections = []
  const loggerLines = []
  const injected = new Set()
  return {
    sections,
    loggerLines,
    injected,
    handler(name) {
      const list = handlers.get(name)
      return list === undefined ? undefined : list[0]
    },
    ctx: {
      logger: { info: (message) => loggerLines.push(String(message)), warn: () => {} },
      systemPrompt: {
        section: (section) => {
          sections.push(section)
          return () => {}
        },
      },
      on: (name, handler) => {
        const list = handlers.get(name)
        if (list === undefined) handlers.set(name, [handler])
        else list.push(handler)
        return () => {}
      },
      // 夹具只驱动三个钩子与 loader 行管理；缺的服务保持缺席，插件必须能正常装载。
      inject: (names, callback) => {
        injected.add(names.join(','))
        const available = {}
        let ready = true
        for (const name of names) {
          if (services[name] === undefined) ready = false
          else available[name] = services[name]
        }
        if (ready) {
          // 注入面同时带 get：宿主代码在请求时用 serverCtx.get('llm') 读模型目录，
          // 与真实 Cordis 注入面一致；缺席时返回 undefined，插件必须降级而非抛错。
          const injectedCtx = { ...available, effect: (fn) => fn(), settings: available.settings, webServer: available.webServer, get: (name) => services[name] }
          // cordis 注入面同时是 ctx 属性：声明 inject 的服务按属性访问（官方 open-in-app 亦如此）。
          if (available.connection !== undefined) injectedCtx.connection = available.connection
          callback(injectedCtx)
        }
        return () => {}
      },
      get: (name) => services[name],
      // 自检区用 ctx.tools.get(name) 判断「工具是否真的注册了」。夹具给一个可配置的桩，
      // 默认「七个角色工具都已注册」。
      tools: services.tools ?? { get: (toolName) => (toolName === undefined ? undefined : { name: toolName }) },
    },
    injected,
  }
}

const root = mkdtempSync(join(tmpdir(), 'collab-verify-'))
const project = join(root, 'proj')
const logDir = join(root, 'logs')
mkdirSync(project, { recursive: true })

const harness = makeCtx()
apply(harness.ctx, { logDir })

const pre = harness.handler('tools/pre-execute')
const post = harness.handler('tools/post-execute')
const stopping = harness.handler('agent/turn-stopping')

const signal = new AbortController().signal
let callSeq = 0
const steered = []

function makeAgent(id) {
  return {
    id,
    session: { header: { id, cwd: project } },
    steer: (message) => steered.push(message),
  }
}

const agent = makeAgent('session-offline-verify')

function exec(name, filePath) {
  callSeq += 1
  return { callId: `call-${callSeq}`, name, arguments: { file_path: filePath }, agent, signal }
}

async function gate(name, filePath) {
  const target = exec(name, filePath)
  const decision = await pre(target, async () => ({ kind: 'allow' }))
  return { target, decision }
}

async function audit(target, isError) {
  return post(target, { isError, content: [] }, async () => ({ kind: 'accept' }))
}

console.log('collab-mode 离线夹具（加载 lib/index.js，全新进程）\n')

/* ---- T1：本次实测抓到的 bug 回归 —— 没有状态的 agent 走 turn-stopping 必须无害 ---- */
console.log('T1 状态缺失的 agent 走 turn-stopping')
{
  let threw
  try {
    await stopping({ agent: makeAgent('session-no-state'), turn: 1, signal })
  } catch (error) {
    threw = error
  }
  check('不抛异常', threw === undefined, threw === undefined ? '' : String(threw && threw.message))
  check('不产生 steering', steered.length === 0, `steered=${steered.length}`)
}

/* ---- T2：连续 3 个未声明文件，第 3 次被 deny 且列出文件名 ---- */
console.log('\nT2 连续 3 个未声明文件 → 第 3 次 deny 且列出文件名')
const files = ['alpha.txt', 'beta.txt', 'gamma.txt', 'delta.txt'].map((n) => join(project, n))
{
  const first = await gate('write', files[0])
  const second = await gate('write', files[1])
  const third = await gate('write', files[2])
  check('第 1 次放行', first.decision.kind === 'allow', first.decision.kind)
  check('第 2 次放行', second.decision.kind === 'allow', second.decision.kind)
  check('第 3 次 deny', third.decision.kind === 'deny', third.decision.kind)
  const reason = third.decision.reason ?? ''
  check('拒绝信息列出 alpha.txt', reason.includes('alpha.txt'), reason)
  check('拒绝信息列出 beta.txt', reason.includes('beta.txt'), reason)
  check('拒绝信息列出 gamma.txt', reason.includes('gamma.txt'), reason)
  console.log(`        拒绝原文: ${reason}`)
}

/* ---- T3：登记进 .work/task-*.md 后放行 ---- */
console.log('\nT3 登记进 .work/task-*.md 后放行')
{
  mkdirSync(join(project, '.work'), { recursive: true })
  writeFileSync(
    join(project, '.work', 'task-offline.md'),
    ['# 离线夹具简报', 'alpha.txt', 'beta.txt', 'gamma.txt', 'delta.txt'].join('\n'),
    'utf8',
  )
  const fourth = await gate('write', files[3])
  check('第 4 次放行', fourth.decision.kind === 'allow', fourth.decision.kind)
}

/* ---- T4：豁免路径不计数 ---- */
console.log('\nT4 豁免路径不计数（.work/ 与 DSH_HOME）')
{
  const before = (await gate('write', join(project, '.work', 'note.md'))).decision.kind
  const home = process.env.DSH_HOME ?? ''
  const homeProbe = home === '' ? null : (await gate('write', join(home, 'probe-note.txt'))).decision.kind
  check('.work/ 下的写入放行', before === 'allow', before)
  check(home === '' ? 'DSH_HOME 未设置（跳过）' : 'DSH_HOME 下的写入放行', home === '' || homeProbe === 'allow', String(homeProbe))
}

/* ---- T5：审计日志每次一行、字段齐全 ---- */
console.log('\nT5 审计日志')
{
  const a = exec('write', files[0])
  await pre(a, async () => ({ kind: 'allow' }))
  await audit(a, false)
  const denied = exec('edit', 'F:/nowhere/undeclared-1.txt')
  await pre(denied, async () => ({ kind: 'allow' }))
  await audit(denied, true)

  const logFile = join(logDir, `activity-${agent.id}.log`)
  check('日志文件已创建', existsSync(logFile), logFile)
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  check('至少写入 2 行', lines.length >= 2, `lines=${lines.length}`)
  const last = lines[lines.length - 1]
  for (const field of ['ts', 'sid', 'tool', 'target', 'ok', 'latency']) {
    check(`末行含字段 ${field}`, Object.hasOwn(last, field), JSON.stringify(last))
  }
  check('被拒调用记为 ok=false', last.ok === false, JSON.stringify(last))
  check('成功调用记为 ok=true', lines[lines.length - 2].ok === true, JSON.stringify(lines[lines.length - 2]))
}

/* ---- T6：轮次结束告警 ---- */
console.log('\nT6 轮次结束告警')
{
  // 让 alpha/beta/delta（已成功写入）成为「已改动」：走一遍 post-execute
  for (const file of [files[0], files[1], files[3]]) {
    const e = exec('write', file)
    await pre(e, async () => ({ kind: 'allow' }))
    await audit(e, false)
  }
  // 撤掉声明（简报删掉），这几个文件才回到「未声明」状态
  rmSync(join(project, '.work', 'task-offline.md'), { force: true })
  steered.length = 0
  await stopping({ agent, turn: 7, signal })
  check('产生一次 steering', steered.length === 1, `steered=${steered.length}`)
  const text = steered[0]?.content?.map((b) => b.text).join('') ?? ''
  check('告警列出文件名', text.includes('alpha.txt') && text.includes('beta.txt'), text)
  check('消息来源标记为插件', steered[0]?.source?.kind === 'plugin' && steered[0]?.source?.plugin === 'collab-mode', JSON.stringify(steered[0]?.source))

  await stopping({ agent, turn: 8, signal })
  check('同一组未声明文件不重复告警', steered.length === 1, `steered=${steered.length}`)

  // 补上声明 → 静默
  writeFileSync(join(project, '.work', 'task-offline.md'), 'alpha.txt beta.txt gamma.txt delta.txt', 'utf8')
  steered.length = 0
  const silentAgent = makeAgent('session-offline-silent')
  await stopping({ agent: silentAgent, turn: 1, signal })
  check('无状态会话静默', steered.length === 0, `steered=${steered.length}`)
}

/* ---- T7：非法配置抛错 ---- */
console.log('\nT7 非法配置抛错')
{
  const cases = [
    ['declarationThreshold: 0', { declarationThreshold: 0 }],
    ['gate 非布尔', { gate: 'yes' }],
    ['config 不是映射', [1, 2, 3]],
  ]
  for (const [label, config] of cases) {
    let threw = false
    try {
      apply(makeCtx().ctx, config)
    } catch {
      threw = true
    }
    check(`${label} 抛错`, threw)
  }
}

/* ---- T8：系统提示段已注册 ---- */
console.log('\nT8 系统提示段')
{
  check('注册了一个 section', harness.sections.length === 1, `sections=${harness.sections.length}`)
  check('section 名为 collab-mode:rules', harness.sections[0]?.name === 'collab-mode:rules', harness.sections[0]?.name)
  check('正文非空且含模式判断', typeof harness.sections[0]?.text === 'string' && harness.sections[0].text.includes('模式判断'))
}

/* ---- T9~T11：v0.2.0 面板下发机制（loader 拥有角色行 + settings 驱动改写） ---- */
console.log('\nT9~T11 面板下发机制')

/** 单独装一个带 loader + settings 的实例，专门验证机制 1。 */
async function verifyPanelMechanism() {
  const loader = makeFakeLoader()
  const settings = makeFakeSettings()
  const webServer = makeFakeWebServer()
  const trustFence = makeFakeTrustFence()
  const serverRoutes = webServer.routes
  const panelCtx = makeCtx({
    loader: loader.service,
    settings: settings.service,
    webServer: webServer.service,
    connection: trustFence.service,
  })
  apply(panelCtx.ctx, { logDir: join(root, 'logs2') })
  // installSection 是在 inject 回调里注册的；夹具的 inject 会同步回调，因此这里已就绪。
  await new Promise((resolve) => setTimeout(resolve, 0))

  check('注册了 collab-mode 设置命名空间', settings.sections.length === 1 && settings.sections[0].ns === 'collab-mode', JSON.stringify(settings.sections.map((s) => s.ns)))

  // T9：七个角色行由插件用 loader.create 创建（不是补丁 insert）。
  // advisor 一份源拆三席（advisor-A/B/C），因此行 id 是 collab-advisor-A/B/C。
  const ids = loader.calls.create.slice().sort()
  check('用 loader.create 建了 7 行', ids.length === 7, JSON.stringify(ids))
  check(
    '行 id 与展开后的角色 key 同名',
    ids.join(',') ===
      'collab-advisor-A,collab-advisor-B,collab-advisor-C,collab-code-reviewer,collab-executor,collab-researcher,collab-vision-reader',
    ids.join(','),
  )
  const executorRow = loader.entries.get('collab-executor')
  check('executor 行 name 是 dsh-tool-subagent', executorRow?.options?.name === '@deepseek-ai/dsh-tool-subagent', executorRow?.options?.name)
  check('executor 行 toolName 是 executor', executorRow?.options?.config?.toolName === 'executor', executorRow?.options?.config?.toolName)
  check('executor 行无 toolFilter（可写）', executorRow?.options?.config?.toolFilter === undefined, JSON.stringify(executorRow?.options?.config?.toolFilter))
  check('executor 行带 persona', typeof executorRow?.options?.config?.persona === 'string' && executorRow.options.config.persona.length > 50)
  const reviewerRow = loader.entries.get('collab-code-reviewer')
  check('只读行带 toolFilter.deny', Array.isArray(reviewerRow?.options?.config?.toolFilter?.deny) && reviewerRow.options.config.toolFilter.deny.length === 17, JSON.stringify(reviewerRow?.options?.config?.toolFilter))
  check('默认不写 agentOptions（留空 = 继承会话）', executorRow?.options?.config?.agentOptions === undefined, JSON.stringify(executorRow?.options?.config?.agentOptions))

  // T10：面板保存 → setSource/onChange → 角色行被 loader.update 改写。
  const hooks = settings.sections[0].hooks
  const panelValue = {
    routes: {
      executor: { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high', maxTokens: 4096 },
      'code-reviewer': { provider: '', model: '', reasoningEffort: '', maxTokens: 0 },
      researcher: { provider: '', model: '', reasoningEffort: '', maxTokens: 0 },
      'advisor-A': { provider: '', model: '', reasoningEffort: '', maxTokens: 0 },
      'advisor-B': { provider: '', model: '', reasoningEffort: '', maxTokens: 0 },
      'advisor-C': { provider: '', model: '', reasoningEffort: '', maxTokens: 0 },
      'vision-reader': { provider: '', model: '', reasoningEffort: '', maxTokens: 0 },
    },
    gate: false,
    audit: true,
    warnOnTurnEnd: true,
    declarationThreshold: 5,
    logDir: '',
  }
  hooks.setSource(() => panelValue)
  await new Promise((resolve) => setTimeout(resolve, 0))

  const executorUpdate = loader.calls.update.filter((c) => c.id === 'collab-executor').pop()
  check('executor 行被 loader.update 改写', executorUpdate !== undefined, JSON.stringify(loader.calls.update.map((c) => c.id)))
  check('改写后的 agentOptions.provider 正确', executorUpdate?.options?.config?.agentOptions?.provider === 'openai', JSON.stringify(executorUpdate?.options?.config?.agentOptions))
  check('改写后的 agentOptions.model 正确', executorUpdate?.options?.config?.agentOptions?.model === 'gpt-5')
  check('改写后的 agentOptions.reasoningEffort 正确', executorUpdate?.options?.config?.agentOptions?.reasoningEffort === 'high')
  check('改写后的 agentOptions.maxTokens 正确', executorUpdate?.options?.config?.agentOptions?.maxTokens === 4096)
  check('改写后仍保留 persona', typeof executorUpdate?.options?.config?.persona === 'string' && executorUpdate.options.config.persona.length > 50)
  check('留空的角色行不被改写', loader.calls.update.filter((c) => c.id.startsWith('collab-advisor-')).length === 0, JSON.stringify(loader.calls.update.map((c) => c.id)))

  // 面板关掉 gate → 拦截不再发生。
  const prePanel = panelCtx.handler('tools/pre-execute')
  const panelAgent = makeAgent('session-panel-gate')
  const probeFile = join(root, 'panel-probe.txt')
  let denied = 0
  for (let i = 0; i < 4; i += 1) {
    const decision = await prePanel(
      { callId: `panel-${i}`, name: 'write', arguments: { file_path: `${probeFile}-${i}` }, agent: panelAgent, signal },
      async () => ({ kind: 'allow' }),
    )
    if (decision.kind === 'deny') denied += 1
  }
  check('gate=false 时连改 4 个未声明文件都不 deny', denied === 0, `denied=${denied}`)

  // 再打开 gate（并把阈值调回 3）→ 第 3 次改回被 deny。
  hooks.onChange()
  panelValue.gate = true
  panelValue.declarationThreshold = 3
  hooks.setSource(() => panelValue)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const gateAgent = makeAgent('session-panel-gate-on')
  let deniedOn = 0
  let denyReason = ''
  for (let i = 0; i < 3; i += 1) {
    const decision = await prePanel(
      { callId: `gateon-${i}`, name: 'write', arguments: { file_path: join(root, `gateon-${i}.txt`) }, agent: gateAgent, signal },
      async () => ({ kind: 'allow' }),
    )
    if (decision.kind === 'deny') {
      deniedOn += 1
      denyReason = decision.reason ?? ''
    }
  }
  check('gate=true 且阈值 3 时第 3 次被 deny', deniedOn === 1, `denied=${deniedOn}`)
  check('拒绝信息里阈值来自面板值', denyReason.includes('threshold=3'), denyReason)

  // T11：全程不让 Loader 落盘（真实实现里 Loader.write 是空实现，这里断言插件不主动调）。
  check('插件从不调用 loader.write()', loader.calls.write === 0, `write=${loader.calls.write}`)

  // T12：自检路由必须走 composition 的信任栅栏。
  //   webServer.match() 是「exact 表优先，未命中再比 prefix」，而信任栅栏挂在
  //   /api 的 prefix 路由上 —— 本路由是 /api 下的 exact，优先级高于栅栏。
  //   因此必须自己调 connection.requestRejection，否则任何本机进程都能读到
  //   日志目录、审计目标这些运行时事实。
  const route = serverRoutes.find((r) => r.path === '/api/collab-mode/selfcheck')
  check('注册了自检 exact 路由', route !== undefined, JSON.stringify(serverRoutes.map((r) => r.path)))

  const makeRes = () => {
    const state = { statusCode: 0, headers: {}, body: undefined }
    return {
      state,
      // statusCode 是直接赋值的普通属性，必须代理回 state，否则断言看不到。
      get statusCode() {
        return state.statusCode
      },
      set statusCode(value) {
        state.statusCode = value
      },
      setHeader: (k, v) => {
        state.headers[k] = v
      },
      end: (body) => {
        state.body = body
      },
    }
  }
  const req = (method) => ({ method, url: '/api/collab-mode/selfcheck', headers: {} })

  // 无 connection 服务 → cordis 的硬依赖语义：该 fiber 等待，路由**不注册**。
  // （代码里的 503 分支是防御性兜底，正常路径到不了；这里断言真实语义。）
  {
    const bare = makeFakeWebServer()
    const bareSettings = makeFakeSettings()
    const bareCtx = makeCtx({ settings: bareSettings.service, webServer: bare.service })
    apply(bareCtx.ctx, { logDir: join(root, 'logs3') })
    const bareRoute = bare.routes.find((r) => r.path === '/api/collab-mode/selfcheck')
    check('缺 connection 时路由不注册（硬依赖等待）', bareRoute === undefined, JSON.stringify(bare.routes.map((r) => r.path)))
    check('缺 connection 时仍注册了设置命名空间', bareSettings.sections.length === 1, String(bareSettings.sections.length))
  }

  // 栅栏返回 401 → 必须 401，且不泄漏自检数据。
  // （handler 现为 async：模型目录 best-effort 拉取；此处 await 等自检写完再断言。）
  trustFence.fence.rejection = 401
  {
    const res = makeRes()
    await route.handler(req('GET'), res)
    check('栅栏拒绝时返回 401', res.state.statusCode === 401, `status=${res.state.statusCode}`)
    check('被拒时不泄漏自检数据', !String(res.state.body ?? '').includes('collab-mode:rules'), String(res.state.body))
  }

  // 栅栏放行 → 200 且带数据。
  trustFence.fence.rejection = undefined
  {
    const res = makeRes()
    await route.handler(req('GET'), res)
    check('栅栏放行时返回 200', res.state.statusCode === 200, `status=${res.state.statusCode}`)
    const parsed = JSON.parse(String(res.state.body))
    check('自检数据含七个角色', Array.isArray(parsed.value?.roles) && parsed.value.roles.length === 7, String(parsed.value?.roles?.length))
    check('自检数据带版本', typeof parsed.value?.version === 'string' && parsed.value.version !== '', parsed.value?.version)
    // 两视图的只读展示字段（描述/色标/工具/人设全文，来自 manifest + loader 行）。
    const roles = parsed.value?.roles ?? []
    check('自检角色带描述', roles.every((r) => typeof r.description === 'string' && r.description !== ''), JSON.stringify(roles.map((r) => r.description)))
    check('自检角色带色标', roles.every((r) => typeof r.color === 'string' && r.color !== ''), JSON.stringify(roles.map((r) => r.color)))
    check('自检角色带工具清单', roles.every((r) => Array.isArray(r.tools) && r.tools.length > 0), JSON.stringify(roles.map((r) => (r.tools ?? []).length)))
    check('自检角色带拒绝清单', roles.every((r) => Array.isArray(r.denied)), 'not array')
    check('自检角色带人设全文', roles.every((r) => typeof r.persona === 'string' && r.persona.length > 50), JSON.stringify(roles.map((r) => (r.persona ?? '').length)))
    // 夹具 ctx 里没有 llm 服务 → 模型目录必须为 null，面板走降级路径。
    check('无 llm 服务时模型目录为 null', parsed.value.modelCatalog === null, JSON.stringify(parsed.value?.modelCatalog))
  }

  // 非 GET → 405。
  {
    const res = makeRes()
    await route.handler(req('POST'), res)
    check('非 GET 返回 405', res.state.statusCode === 405, `status=${res.state.statusCode}`)
  }
}

await verifyPanelMechanism()

/* ---- T12b：模型目录（编辑页"模型"下拉的数据源，best-effort 只读） ---- */
console.log('\nT12b 模型目录')
async function verifyModelCatalog() {
  const loader = makeFakeLoader()
  const settings = makeFakeSettings()
  const webServer = makeFakeWebServer()
  const trustFence = makeFakeTrustFence()
  const llm = {
    listProviders() {
      return [
        { id: 'p1', name: 'P One' },
        { id: 'p2', name: '' },
        { id: '', name: 'NoId' },
      ]
    },
    async listModels(id) {
      if (id === 'p1') return [{ id: 'm1', name: 'M One' }, { id: 'm2', name: '' }, { id: '', name: 'NoId' }, null]
      throw new Error('adapter down')
    },
  }
  const figured = makeCtx({ loader: loader.service, settings: settings.service, webServer: webServer.service, connection: trustFence.service, llm })
  apply(figured.ctx, { logDir: join(root, 'logs4') })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const route = webServer.routes.find((r) => r.path === '/api/collab-mode/selfcheck')
  check('带 llm 时路由已注册', route !== undefined, JSON.stringify(webServer.routes.map((r) => r.path)))
  const state = { statusCode: 0, body: undefined }
  const res = {
    get statusCode() { return state.statusCode },
    set statusCode(value) { state.statusCode = value },
    setHeader: () => {},
    end: (body) => { state.body = body },
  }
  await route.handler({ method: 'GET', url: '/api/collab-mode/selfcheck', headers: {} }, res)
  check('模型目录 200', state.statusCode === 200, `status=${state.statusCode}`)
  const parsed = JSON.parse(String(state.body))
  const providers = parsed.value?.modelCatalog?.providers ?? []
  check('目录列出两个合法供应商', providers.map((p) => p.id).join(',') === 'p1,p2', JSON.stringify(providers.map((p) => p.id)))
  check('供应商回退名称', providers.find((p) => p.id === 'p2')?.name === 'p2', JSON.stringify(providers.find((p) => p.id === 'p2')))
  check('模型枚举正确', JSON.stringify((providers.find((p) => p.id === 'p1')?.models ?? []).map((m) => m.id)) === JSON.stringify(['m1', 'm2']), JSON.stringify(providers.find((p) => p.id === 'p1')?.models))
  check('模型回退名称', (providers.find((p) => p.id === 'p1')?.models ?? []).find((m) => m.id === 'm2')?.name === 'm2', JSON.stringify((providers.find((p) => p.id === 'p1')?.models ?? []).find((m) => m.id === 'm2')))
  check('坏供应商被容忍（models 空）', JSON.stringify(providers.find((p) => p.id === 'p2')?.models ?? null) === JSON.stringify([]), JSON.stringify(providers.find((p) => p.id === 'p2')?.models))
  // 第 7 节自检暴露：包装装着时字段为 true。
  check('自检暴露 opencodeFreeRelay', parsed.value?.opencodeFreeRelay === true, String(parsed.value?.opencodeFreeRelay))
}

await verifyModelCatalog()

/* ---- T12c：模型档位（编辑页"推理强度"下拉的数据源，跟随模型） ---- */
console.log('\nT12c 模型档位')
async function verifyModelEfforts() {
  const loader = makeFakeLoader()
  const settings = makeFakeSettings()
  const webServer = makeFakeWebServer()
  const trustFence = makeFakeTrustFence()
  const llm = {
    async resolveModelInfo(provider, model) {
      if (provider === 'zen' && model === 'muse-spark') {
        return {
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: '' },
              { id: '', name: 'NoId' },
              null,
            ],
            defaultEffort: 'high',
          },
        }
      }
      if (provider === 'zen' && model === 'plain') return {}
      throw new Error('unknown route')
    },
  }
  const figured = makeCtx({ loader: loader.service, settings: settings.service, webServer: webServer.service, connection: trustFence.service, llm })
  apply(figured.ctx, { logDir: join(root, 'logs5') })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const paths = webServer.routes.map((r) => r.path)
  check('档位路由已注册', paths.includes('/api/collab-mode/model-efforts'), JSON.stringify(paths))
  check('自检路由仍在（双注册不断）', paths.includes('/api/collab-mode/selfcheck'), JSON.stringify(paths))
  const route = webServer.routes.find((r) => r.path === '/api/collab-mode/model-efforts')
  const call = async (url, method = 'GET') => {
    const state = { statusCode: 0, headers: {}, body: undefined }
    await route.handler({ method, url, headers: {} }, {
      get statusCode() { return state.statusCode },
      set statusCode(value) { state.statusCode = value },
      setHeader: (k, v) => { state.headers[k] = v },
      end: (body) => { state.body = body },
    })
    return state
  }
  {
    const state = await call('/api/collab-mode/model-efforts?provider=zen&model=muse-spark')
    check('档位查询 200', state.statusCode === 200, `status=${state.statusCode}`)
    const parsed = JSON.parse(String(state.body))
    check('档位列出合法项', JSON.stringify((parsed.value?.efforts ?? []).map((e) => e.id)) === JSON.stringify(['low', 'high']), String(state.body))
    check('档位名称回退 id', (parsed.value?.efforts ?? []).find((e) => e.id === 'high')?.name === 'high', String(state.body))
    check('默认档位透出', parsed.value?.defaultEffort === 'high', String(state.body))
  }
  {
    const state = await call('/api/collab-mode/model-efforts?provider=zen')
    check('缺参数 400', state.statusCode === 400, `status=${state.statusCode}`)
  }
  {
    const state = await call('/api/collab-mode/model-efforts?provider=zen&model=nope')
    const parsed = JSON.parse(String(state.body))
    check('未知模型 200 且 efforts null', state.statusCode === 200 && parsed.value?.efforts === null, `${state.statusCode} ${state.body}`)
  }
  {
    const state = await call('/api/collab-mode/model-efforts?provider=zen&model=plain')
    const parsed = JSON.parse(String(state.body))
    check('无档位概念回 null', state.statusCode === 200 && parsed.value?.efforts === null, `${state.statusCode} ${state.body}`)
  }
  {
    const state = await call('/api/collab-mode/model-efforts?provider=zen&model=muse-spark', 'POST')
    check('非 GET 返回 405', state.statusCode === 405, `status=${state.statusCode}`)
  }
  {
    trustFence.fence.rejection = 401
    const state = await call('/api/collab-mode/model-efforts?provider=zen&model=muse-spark')
    check('栅栏拒绝时返回 401', state.statusCode === 401, `status=${state.statusCode}`)
    trustFence.fence.rejection = undefined
  }
}

await verifyModelEfforts()

/* ---- T13：客户端半侧防线（v0.2.1 补） ---- */
console.log('\nT13 客户端半侧：settingsScope 必须是声明依赖')

/**
 * 加载 `lib/client.js`。
 *
 * 它是客户端模块系统要求的 lazy-CJS factory 格式：`window.__ModuleLoader__.load({id, factory})`，
 * factory 拿一个 `require` 去取平台基座模块。这里给最小 `window` 桩 + `require` 桩，
 * 只为拿到它 `exports` 出来的 `apply` / `inject` —— 卡片本体要 React + DOM，
 * 不在夹具范围内（README「已知边界」已写明）。
 */
async function loadClientModule() {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        captured = entry
      },
    },
  }
  // client.js 顶部有 CSS 注入：需要 document.querySelector / createElement / head.appendChild
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, set textContent(v) {}, }),
    head: { appendChild: () => {} },
  }
  try {
    // 每次都重新 import：加 query 串绕开 ESM 模块缓存，保证读的是磁盘上的当前代码。
    await import(`../lib/client.js?t=${Date.now()}`)
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
  if (captured === undefined) throw new Error('client.js did not call window.__ModuleLoader__.load')
  const require = (name) => {
    if (name === 'react') return { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f() }
    throw new Error(`unexpected client module request: ${name}`)
  }
  return captured.factory(require)
}

async function verifyClientHalf() {
  const client = await loadClientModule()
  const names = Array.isArray(client.inject) ? client.inject : []

  check('客户端 inject 是数组', Array.isArray(client.inject), JSON.stringify(client.inject))
  check('客户端 inject 含 slots', names.includes('slots'), JSON.stringify(names))
  // 这条就是 v0.2.0 面板不可编辑的回归断言：
  // settingsScope 必须出现在 inject 里，否则服务晚于本插件就绪时 Cordis 不会重评估 fiber。
  check('客户端 inject 含 settingsScope（v0.2.0 缺陷回归）', names.includes('settingsScope'), JSON.stringify(names))

  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  check("apply 不再用 ctx.get('settingsScope') 一次性读取", !source.includes("ctx.get('settingsScope')"), 'still present')
  check('apply 直接使用注入的 ctx.settingsScope', source.includes('ctx.settingsScope.bind('), 'not found')

  // 行为断言：给一个含 settingsScope 的 ctx，卡片必须拿到绑定的 scope 而不是 null。
  const slotsRegistrations = []
  let bound = null
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    settingsScope: {
      bind(spec) {
        bound = spec
        return { getSnapshot: () => ({ status: 'ready', value: {}, writable: true, revision: 1 }), subscribe: () => () => {}, mutate: async () => {}, set: async () => {}, unset: async () => {} }
      },
    },
    slots: {
      inject: (name, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        slotsRegistrations.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)

  check('bind 用命名空间 collab-mode', bound !== null && bound.namespace === 'collab-mode', JSON.stringify(bound))
  check('注册了 settings.section 独立导航', slotsRegistrations.length === 1 && slotsRegistrations[0]?.options?.name === 'settings.section', JSON.stringify(slotsRegistrations.map((r) => r.options?.name)))
  const card = slotsRegistrations[0]
  check('section id 是 collab-mode', card.options.id === 'collab-mode', String(card.options.id))
  check('section order 是 79', card.options.order === 79, String(card.options.order))
  check('section label 是协作模式', card.options.label === '协作模式', String(card.options.label))
  check('不再注册 settings.plugin.item', slotsRegistrations.every((r) => r.options?.name !== 'settings.plugin.item'), JSON.stringify(slotsRegistrations.map((r) => r.options?.name)))

  const injected = card.options.inject()
  check('卡片拿到的 scope 不是 null（v0.2.0 缺陷回归）', injected.scope !== null && injected.scope !== undefined, String(injected.scope))
  check('卡片拿到的 scope 可用', injected.scope.getSnapshot().status === 'ready', JSON.stringify(injected.scope.getSnapshot()))
  check('注册时标记 section 视图', injected.asSection === true, JSON.stringify(injected.asSection))

  // 两视图静态标记（ZCode 子智能体页同款结构；行为要 React + DOM，走活体验证）。
  check('编辑视图有返回列表', source.includes('‹ 返回列表'), 'not found')
  check('模型下拉有继承默认首项', source.includes('继承默认'), 'not found')
  check('客户端读取模型目录', source.includes('modelCatalog'), 'not found')
  check('客户端有列表/编辑视图状态', source.includes('setSelected'), 'not found')
  check('无新建入口', !source.includes('+ 新建'), 'found')
  check('无删除入口', !source.includes('删除角色') && !source.includes('删除该'), 'found')
  check('无 AGENTS.md 注入开关', !source.includes('注入 AGENTS.md'), 'found')
  check('列表行无可写只读 tag', !source.includes("row.writable ? '可写' : '只读'"), 'found')
  check('列表行尾用工具计数', source.includes('toolsSide'), 'not found')
  check('推理强度无 max 档', source.includes("const EFFORTS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']"), 'EFFORTS mismatch')
  check('推理强度旧值粘滞', source.includes('effortOptions'), 'not found')
  check('推理强度跟随模型', source.includes('model-efforts') && source.includes('fetchEfforts') && source.includes('effortSelect'), 'not found')
  check('档位默认有标记', source.includes('（默认）'), 'not found')
}

await verifyClientHalf()

/* ---- T14：opencode free 回传剥除（第 7 节） ---- */
console.log('\nT14 opencode free 回传剥除')
{
  // apply() 在夹具启动时已经装过一次包装。
  check('apply 后包装已安装', opencodeFreeRelayInstalled() === true, String(opencodeFreeRelayInstalled()))
  uninstallOpencodeFreeRelay()
  check('卸载后标记为 false', opencodeFreeRelayInstalled() === false, String(opencodeFreeRelayInstalled()))

  const realFetch = globalThis.fetch
  const calls = []
  const stubFetch = async (input, init) => {
    calls.push({ input, init })
    return { ok: true, stubbed: true }
  }
  const headOf = (call) => {
    if (call.init?.headers !== undefined) return new Headers(call.init.headers)
    if (typeof Request === 'function' && call.input instanceof Request) return new Headers(call.input.headers)
    return new Headers()
  }
  /** 取转发体文本：init.body 优先，Request 形态读 clone（不消耗原件）。 */
  const bodyOf = async (call) => {
    if (typeof call.init?.body === 'string') return call.init.body
    if (typeof Request === 'function' && call.input instanceof Request) return call.input.clone().text()
    return ''
  }
  globalThis.fetch = stubFetch
  try {
    const unwrap1 = installOpencodeFreeRelay()
    check('安装后标记为 true', opencodeFreeRelayInstalled() === true, String(opencodeFreeRelayInstalled()))

    /* ---- 验收 1a：free 端点 POST 剥除 reasoning 项，其余项原样 ---- */
    {
      const body = JSON.stringify({
        model: 'muse-spark-1.3-contributor-free',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC-BLOB', summary: [] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
          { type: 'reasoning', id: 'rs_2', encrypted_content: 'ENC-BLOB-2', summary: [] },
          { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
        ],
        include: ['reasoning.encrypted_content'],
      })
      calls.length = 0
      await globalThis.fetch('https://opencode.ai/zen/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-request-id': 'sess-abc' },
        body,
      })
      const sent = await bodyOf(calls[0])
      const parsed = JSON.parse(sent)
      check('1a free 端点 reasoning 项被剔除', parsed.input.filter((i) => i.type === 'reasoning').length === 0, JSON.stringify(parsed.input.map((i) => i.type)))
      check('1a 其余项原样保留（顺序与类型）', JSON.stringify(parsed.input.map((i) => i.type)) === JSON.stringify(['message', 'message', 'function_call']), JSON.stringify(parsed.input.map((i) => i.type)))
      check('1a 其余项内容逐字段不变', JSON.stringify(parsed.input[2]) === JSON.stringify({ type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' }), JSON.stringify(parsed.input[2]))
      check('1a 顶层其他字段保留', parsed.model === 'muse-spark-1.3-contributor-free' && JSON.stringify(parsed.include) === JSON.stringify(['reasoning.encrypted_content']), JSON.stringify(Object.keys(parsed)))
    }

    /* ---- 验收 1b：付费 go 端点 body 逐字节不变 ---- */
    {
      const body = JSON.stringify({
        model: 'paid-model',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC-BLOB', summary: [] },
        ],
        include: ['reasoning.encrypted_content'],
      })
      calls.length = 0
      await globalThis.fetch('https://opencode.ai/zen/go/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-request-id': 'sess-go' },
        body,
      })
      const sent = await bodyOf(calls[0])
      check('1b 付费 go 端点 body 逐字节不变', sent === body, `${sent.length} vs ${body.length}`)
      check('1b 付费端点仍做会话头镜像', headOf(calls[0]).get('x-opencode-session') === 'sess-go', String(headOf(calls[0]).get('x-opencode-session')))
    }

    /* ---- 验收 1c：会话头镜像（带 x-client-request-id / 不带时进程级稳定） ---- */
    calls.length = 0
    await globalThis.fetch('https://opencode.ai/zen/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-request-id': 'sess-abc', 'x-opencode-session': 'old-static-uuid' },
      body: JSON.stringify({ input: [] }),
    })
    check('1c 会话头被镜像覆盖', headOf(calls[0]).get('x-opencode-session') === 'sess-abc', String(headOf(calls[0]).get('x-opencode-session')))
    check('1c 原请求头保留', headOf(calls[0]).get('x-client-request-id') === 'sess-abc', String(headOf(calls[0]).get('x-client-request-id')))

    // Request 对象形态也照镜像。
    calls.length = 0
    await globalThis.fetch(new Request('https://opencode.ai/zen/v1/models', { headers: { 'x-client-request-id': 'sess-r' } }))
    check('1c Request 形态同样镜像', headOf(calls[0]).get('x-opencode-session') === 'sess-r', String(headOf(calls[0]).get('x-opencode-session')))

    // 不带 x-client-request-id → 进程级稳定 UUID，两次同值。
    calls.length = 0
    await globalThis.fetch('https://opencode.ai/zen/v1/models')
    const u1 = headOf(calls[0]).get('x-opencode-session')
    await globalThis.fetch('https://opencode.ai/zen/v1/models')
    const u2 = headOf(calls[1]).get('x-opencode-session')
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    check('1c 兜底是 UUID v4', uuidV4.test(u1 ?? ''), String(u1))
    check('1c 兜底两次同值（进程级稳定）', u1 !== null && u1 === u2, `${u1} vs ${u2}`)

    /* ---- 验收 1d：非 opencode 域零接触（headers 与 body 均零改动） ---- */
    {
      const body = JSON.stringify({ input: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' }] })
      calls.length = 0
      await globalThis.fetch('https://example.com/anything', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-request-id': 'sess-x' },
        body,
      })
      check('1d 他域不加会话头', headOf(calls[0]).get('x-opencode-session') === null, String(headOf(calls[0]).get('x-opencode-session')))
      check('1d 他域原头不动', headOf(calls[0]).get('x-client-request-id') === 'sess-x', String(headOf(calls[0]).get('x-client-request-id')))
      check('1d 他域 body 逐字节不变', (await bodyOf(calls[0])) === body, 'body changed')
      check('1d 他域 init 对象原样透传', calls[0].init.body === body, 'init replaced')
    }

    /* ---- 验收 1e：非法 JSON body 原样透传；unwrap 还原；重复 install 不叠层 ---- */
    {
      const body = '{"input": [ this is not json '
      calls.length = 0
      await globalThis.fetch('https://opencode.ai/zen/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      check('1e 非法 JSON body 原样透传', (await bodyOf(calls[0])) === body, 'body changed')
      check('1e 非法 JSON 仍做会话头镜像', headOf(calls[0]).get('x-opencode-session') !== null, 'no session header')
    }

    // 无 reasoning 项时也不改写字节。
    {
      const body = JSON.stringify({ input: [{ type: 'message', role: 'user', content: [] }] })
      calls.length = 0
      await globalThis.fetch('https://opencode.ai/zen/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      check('1e 无 reasoning 项时 body 原样', (await bodyOf(calls[0])) === body, 'body changed')
    }

    // 非 JSON content-type 不做剥除。
    {
      const body = JSON.stringify({ input: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'E' }] })
      calls.length = 0
      await globalThis.fetch('https://opencode.ai/zen/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body,
      })
      check('1e 非 JSON content-type 不剥除', (await bodyOf(calls[0])) === body, 'body changed')
    }

    // 重复安装不叠层。
    const f1 = globalThis.fetch
    const unwrap2 = installOpencodeFreeRelay()
    check('1e 重复安装返回同一 unwrap', unwrap1 === unwrap2, '')
    check('1e 重复安装不换包装', globalThis.fetch === f1, '')

    // unwrap 恢复原 fetch。
    unwrap1()
    check('1e 卸载后标记为 false', opencodeFreeRelayInstalled() === false, String(opencodeFreeRelayInstalled()))
    check('1e 卸载后 fetch 恢复', globalThis.fetch === stubFetch, '')
  } finally {
    globalThis.fetch = realFetch
  }
  // 恢复初始条件（apply 装过的状态），不影响进程后续。
  installOpencodeFreeRelay()
  check('恢复安装后标记为 true', opencodeFreeRelayInstalled() === true, String(opencodeFreeRelayInstalled()))
}

rmSync(root, { recursive: true, force: true })

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' / ')}`)
  process.exitCode = 1
}
