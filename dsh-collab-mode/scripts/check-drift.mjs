#!/usr/bin/env node
/**
 * 防漂移自检：断言「内容单一来源」在机制上成立。
 *
 * 为什么需要它：v0.3.0 之前，角色清单在 `build.mjs`、正文在 `content/roles/*.md`、
 * ZCode skill 侧另有一份手写搬运的副本 —— 手工同步两份文本，丢了规则也没人发现。
 * 本脚本把「角色数：源 5 份、两侧部署各 7 个」「manifest 声明的文件必须存在且非空」
 * 「生成物不得被手工编辑」「规则文本占位符取值齐全、两侧产物无残留」
 * 变成可执行的断言。
 *
 * 运行：node scripts/check-drift.mjs      （退出码非 0 表示有漂移）
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

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

console.log('dsh-collab-mode 防漂移自检\n')

/* ---- 1. manifest 本身 ---- */

const manifestPath = join(root, 'content', 'manifest.json')
check('content/manifest.json 存在', existsSync(manifestPath), manifestPath)

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  check('content/manifest.json 可解析', false, String(error && error.message))
  console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`)
  console.log(`失败项：${failures.join(' / ')}`)
  process.exitCode = 1
  process.exit(1)
}
check('content/manifest.json 可解析', true)
check('manifest.version 非空', typeof manifest.version === 'string' && manifest.version !== '', String(manifest.version))
check('manifest.rules.file 已声明', typeof manifest.rules?.file === 'string' && manifest.rules.file !== '')
check('manifest.roles 是非空数组', Array.isArray(manifest.roles) && manifest.roles.length > 0, String(manifest.roles?.length))

/* ---- 2. 每个 roles[].file 存在且非空 ---- */

console.log('\n[1] manifest 声明的文件存在且非空')
const roleFiles = []
for (const role of manifest.roles) {
  const abs = join(root, 'content', role.file)
  const exists = existsSync(abs)
  check(`roles[${role.key}].file 存在（${role.file}）`, exists, abs)
  if (!exists) continue
  const size = statSync(abs).size
  check(`roles[${role.key}].file 非空（${size} 字节）`, size > 0, `${size} 字节`)
  roleFiles.push(abs)
}
{
  const rulesAbs = join(root, 'content', manifest.rules.file)
  check(`rules.file 存在（${manifest.rules.file}）`, existsSync(rulesAbs), rulesAbs)
  if (existsSync(rulesAbs)) {
    const size = statSync(rulesAbs).size
    check(`rules.file 非空（${size} 字节）`, size > 0, `${size} 字节`)
  }
}

/* ---- 3. 角色数：源 5 份，两侧部署各 7 个 ---- */

console.log('\n[2] 角色数：content/roles/*.md 源 5 份 → DSH 生成物 ROLES / 面板 ROLE_ROWS / ZCode agent-*.md 各 7 个')

const manifestKeys = manifest.roles.map((r) => r.key).sort()

/**
 * DSH 侧展开后的角色 key：`dsh.seats` 非空时按席位展开（advisor 一份源出三席），
 * 否则就是角色 key 本身。与 build.mjs 的 dshSeats() 同语义。
 */
function dshExpandedKeys() {
  const keys = []
  for (const role of manifest.roles) {
    const seats = role.dsh?.seats
    if (seats === undefined) keys.push(role.key)
    else if (Array.isArray(seats) && seats.length > 0) keys.push(...seats)
    else keys.push(role.key)
  }
  return keys.sort()
}
const expandedKeys = dshExpandedKeys()

// content/roles/ 目录里实际存在的 .md 文件数
const { readdirSync } = await import('node:fs')
const onDisk = readdirSync(join(root, 'content', 'roles'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .sort()
check('content/roles/*.md 数量 == manifest.roles 数量（源 5 份）', onDisk.length === manifestKeys.length, `磁盘 ${onDisk.length} vs manifest ${manifestKeys.length}`)
check('源角色数 == 5', manifestKeys.length === 5, String(manifestKeys.length))
check('content/roles/*.md 文件名集合 == manifest keys', JSON.stringify(onDisk) === JSON.stringify(manifestKeys), `磁盘 ${onDisk.join(',')} vs manifest ${manifestKeys.join(',')}`)

// 生成物 lib/generated-content.js 的 ROLES（= DSH 侧部署数）
const generated = await import(new URL('../lib/generated-content.js', import.meta.url).href)
const generatedKeys = generated.ROLES.map((r) => r.key).sort()
check('生成物 ROLES 数量 == 展开后的角色数', generatedKeys.length === expandedKeys.length, `生成物 ${generatedKeys.length} vs 展开 ${expandedKeys.length}`)
check('生成物 ROLES keys == 展开后的角色 keys', JSON.stringify(generatedKeys) === JSON.stringify(expandedKeys), `生成物 ${generatedKeys.join(',')}`)
check('DSH 侧部署数 == 7', generatedKeys.length === 7, String(generatedKeys.length))
check('生成物含 advisor 三席', ['advisor-A', 'advisor-B', 'advisor-C'].every((s) => generatedKeys.includes(s)), generatedKeys.join(','))
{
  // 三席 persona 必须同文（共用 content/roles/advisor.md 一份源）
  const personaOf = (key) => generated.ROLES.find((r) => r.key === key)?.persona
  const seats = ['advisor-A', 'advisor-B', 'advisor-C'].map(personaOf)
  check('advisor 三席 persona 同文', seats[0] !== undefined && seats[0] === seats[1] && seats[1] === seats[2], `长度 ${seats.map((p) => (typeof p === 'string' ? p.length : 'n/a')).join('/')}`)
}

// 面板 ROLE_ROWS（lib/client.js 里那张表）
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const roleRowsBlock = clientSource.match(/const ROLE_ROWS = \[([\s\S]*?)\n\s*\]/)
check('lib/client.js 里能找到 ROLE_ROWS 表', roleRowsBlock !== null, 'not found')
if (roleRowsBlock !== null) {
  const clientKeys = [...roleRowsBlock[1].matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]).sort()
  check('ROLES 数 == ROLE_ROWS 数', clientKeys.length === generatedKeys.length, `面板 ${clientKeys.length} vs 生成物 ${generatedKeys.length}`)
  check('面板 ROLE_ROWS keys == 生成物 ROLES keys', JSON.stringify(clientKeys) === JSON.stringify(generatedKeys), `面板 ${clientKeys.join(',')}`)
}

// ZCode 侧部署数：references/agent-*.md（advisor 模板出三席，席位名由
// sync_from_manifest.py 的 ADVISOR_SEATS 声明 —— 按那份声明数，不写死）
{
  const refDir = join(root, '..', 'zcode-collab', 'references')
  const refFiles = readdirSync(refDir).filter((f) => /^agent-.*\.md$/.test(f))
  const seatsScript = join(root, '..', 'zcode-collab', 'scripts', 'sync_from_manifest.py')
  const seatCount = existsSync(seatsScript)
    ? [...readFileSync(seatsScript, 'utf8').matchAll(/^\s*"[^"]+":\s*"advisor-[A-Za-z0-9_-]+",\s*$/gm)].length
    : 0
  // 模板文件 agent-advisor.md 本身算一席，另两席由部署步骤拆分
  const deployed = refFiles.length + Math.max(0, seatCount - 1)
  check('ZCode 侧部署数 == 7', deployed === 7, `references ${refFiles.length} 个模板 + 席位声明 ${seatCount} → ${deployed}`)
}

/* ---- 4. 生成物不得被手工编辑（用「重新构建后字节一致」判定） ---- */

console.log('\n[3] 生成物与 content/ 同步（重新构建后字节一致）')

const generatedPath = join(root, 'lib', 'generated-content.js')
const patchPath = join(root, 'cordis.patch.yml')
const before = {
  generated: createHash('sha256').update(readFileSync(generatedPath)).digest('hex'),
  patch: createHash('sha256').update(readFileSync(patchPath)).digest('hex'),
}

// 用一个子进程跑构建，避免本进程的模块缓存影响判定
const { spawnSync } = await import('node:child_process')
const built = spawnSync(process.execPath, [join(root, 'build.mjs')], { cwd: root, encoding: 'utf8' })
check('node build.mjs 退出码为 0', built.status === 0, `status=${built.status} ${built.stderr ?? ''}`)

const after = {
  generated: createHash('sha256').update(readFileSync(generatedPath)).digest('hex'),
  patch: createHash('sha256').update(readFileSync(patchPath)).digest('hex'),
}
check('lib/generated-content.js 与 content/ 一致（未被手工编辑）', before.generated === after.generated, `${before.generated.slice(0, 16)} -> ${after.generated.slice(0, 16)}`)
check('cordis.patch.yml 与 content/ 一致（未被手工编辑）', before.patch === after.patch, `${before.patch.slice(0, 16)} -> ${after.patch.slice(0, 16)}`)

/* ---- 5. 生成物文件头必须带「请勿手改」告示 ---- */

console.log('\n[4] 生成物文件头带告示')
for (const [label, path] of [
  ['lib/generated-content.js', generatedPath],
  ['cordis.patch.yml', patchPath],
]) {
  const head = readFileSync(path, 'utf8').split('\n').slice(0, 3).join('\n')
  check(`${label} 文件头含「请勿手改」`, head.includes('请勿手改'), head.split('\n')[0])
}

/* ---- 6. ZCode 侧平台信息齐备 ---- */

console.log('\n[5] 每个角色的 zcode 块字段齐备')
for (const role of manifest.roles) {
  const z = role.zcode
  check(`roles[${role.key}].zcode.description 非空`, typeof z?.description === 'string' && z.description !== '')
  check(`roles[${role.key}].zcode.color 非空`, typeof z?.color === 'string' && z.color !== '')
  check(`roles[${role.key}].zcode.tools 是非空数组`, Array.isArray(z?.tools) && z.tools.length > 0, String(z?.tools?.length))
  check(`roles[${role.key}].zcode.injectAgentsMd 是布尔`, typeof z?.injectAgentsMd === 'boolean', String(z?.injectAgentsMd))
}

/* ---- 7. 规则文本单一来源：占位符取值齐全 + 两侧产物无残留 + 圆桌条目渲染出真名 ----
 *
 * 背景：v0.4.0 起 `content/collab-rules.md` 是两侧规则文本的唯一来源，用
 * `{{NAME}}` 行内占位符和 `{{#平台}}…{{/平台}}` 平台块表达差异。
 * 渲染器有两份实现，语义必须一致：
 *   DSH  侧 dsh-collab-mode/build.mjs 的 renderRules()，平台取 `dsh`
 *   ZCode 侧 zcode-collab/scripts/sync_from_manifest.py 的 render_rules()，平台取 `zcode`
 * 本段断言三件事：源里的占位符都有两个平台的取值、两份产物都不残留 `{{`、
 * 圆桌条目在两侧都渲染出**真实存在**的角色名（v0.4.0 之前 DSH 那份写的
 * `advisor` 在 ZCode 侧不存在，圆桌调用不到任何东西）。 */

console.log('\n[6] 规则文本单一来源（占位符 + 两侧渲染产物）')

const placeholders = manifest.rules?.placeholders ?? {}
const rulesSource = readFileSync(join(root, 'content', manifest.rules.file), 'utf8')

// 7.1 源里的每个 `{{NAME}}` 都能在 manifest 找到 dsh + zcode 两个取值
const inlineNames = new Set()
for (const m of rulesSource.matchAll(/\{\{(?![#/])([A-Za-z0-9_-]+)\}\}/g)) inlineNames.add(m[1])
check('源里至少声明了一个行内占位符', inlineNames.size > 0, String(inlineNames.size))
for (const name of [...inlineNames].sort()) {
  const entry = placeholders[name]
  check(`占位符 {{${name}}} 有 dsh 取值`, typeof entry?.dsh === 'string' && entry.dsh !== '', JSON.stringify(entry?.dsh))
  check(`占位符 {{${name}}} 有 zcode 取值`, typeof entry?.zcode === 'string' && entry.zcode !== '', JSON.stringify(entry?.zcode))
}
// 平台块标记必须成对，且块名是 manifest 里真有取值的平台（否则渲染器会静默漏掉一段）
const openBlocks = [...rulesSource.matchAll(/^\{\{#([A-Za-z0-9_-]+)\}\}$/gm)].map((m) => m[1])
const closeBlocks = [...rulesSource.matchAll(/^\{\{\/([A-Za-z0-9_-]+)\}\}$/gm)].map((m) => m[1])
check('源里平台块开闭标记数量相等', openBlocks.length === closeBlocks.length, `开 ${openBlocks.length} vs 闭 ${closeBlocks.length}`)
for (const block of new Set(openBlocks)) {
  check(`平台块 {{#${block}}} 是 manifest 里有取值的平台`, Object.values(placeholders).some((v) => typeof v?.[block] === 'string'), block)
}

// 7.1b v1.4.0 起顾问角色两侧同名（advisor-A/B/C），不再需要 ADVISOR /
// ADVISOR_CALL 两个占位符 —— manifest 里不许留，规则源里也不许再引用
// （否则渲染时 check 会抛「没有 dsh 取值」，这条断言把事故提前到自检阶段）。
for (const dead of ['ADVISOR', 'ADVISOR_CALL']) {
  check(`manifest.rules.placeholders 无 ${dead}`, placeholders[dead] === undefined, JSON.stringify(placeholders[dead]))
  check(`规则源无 {{${dead}}} 引用`, !rulesSource.includes(`{{${dead}}}`), rulesSource.match(new RegExp(`\\{\\{${dead}\\}\\}`))?.[0])
}

// 7.2 两份渲染产物均无 `{{` 残留
const freshGenerated = await import(`${new URL('../lib/generated-content.js', import.meta.url).href}?drift=${Date.now()}`)
const dshRules = freshGenerated.RULES_TEXT
check('DSH 产物 RULES_TEXT 无 {{ 残留', !dshRules.includes('{{'), dshRules.match(/\{\{[^}]*\}\}/)?.[0])

const zcodeRulesPath = join(root, '..', 'zcode-collab', 'references', 'global-agents.md')
const zcodeRulesExists = existsSync(zcodeRulesPath)
check('ZCode 产物 references/global-agents.md 存在', zcodeRulesExists, zcodeRulesPath)
const zcodeRules = zcodeRulesExists ? readFileSync(zcodeRulesPath, 'utf8') : ''
check('ZCode 产物无 {{ 残留', zcodeRulesExists && !zcodeRules.includes('{{'), zcodeRules.match(/\{\{[^}]*\}\}/)?.[0])

// 7.2b ZCode 专属语义内容回归（v0.4.0 合并时曾丢掉这两处，主智能体拿
// ~/.zcode/AGENTS.md.bak-before-v040 逐行 diff 才发现）：
//   - 「汇报纪律」段末的 PostToolUse 钩子说明（平台块）
//   - 「个人抉择类」行尾指向 ~/.zcode/snippets/two-way-steelman.md 的指引（{{STEELMAN_TAIL}}）
// 两侧必须各自只出现在自己那侧 —— DSH 那份渲染出这些 ZCode 路径就是串味。
for (const [label, text, shouldHave] of [
  ['ZCode', zcodeRules, true],
  ['DSH', dshRules, false],
]) {
  for (const needle of ['two-way-steelman.md', 'PostToolUse']) {
    const hit = text.includes(needle)
    check(`${label} 产物${shouldHave ? '含' : '不含'} ${needle}`, zcodeRulesExists && hit === shouldHave, hit ? '命中' : '未命中')
  }
}

// 7.3 圆桌条目在两侧都渲染出真实存在的角色名，且两侧该行逐字一致
const roundTableLine = (text) => text.split('\n').find((line) => line.includes('用户想听多方意见'))
const backticked = (line) => [...line.matchAll(/`([A-Za-z0-9_-]+)`/g)].map((m) => m[1])

// DSH 侧的真实角色名 = 展开后的工具名（dsh.seats 非空时按席位展开，与 build.mjs 同语义）
const dshNames = new Set()
for (const role of manifest.roles) {
  const seats = role.dsh?.seats
  if (seats === undefined) dshNames.add(role.dsh.toolName)
  else for (const seat of seats) dshNames.add(seat)
}
// ZCode 侧的真实角色名 = references/agent-*.md 的 frontmatter name；advisor 模板在
// 部署时拆成三席，席位名（advisor-A/B/C）由 sync_from_manifest.py 的 ADVISOR_SEATS
// 声明 —— 按那份声明解析，不把席位名写死在断言里。
const zcodeNames = new Set()
if (zcodeRulesExists) {
  const refDir = join(root, '..', 'zcode-collab', 'references')
  for (const f of readdirSync(refDir).filter((f) => /^agent-.*\.md$/.test(f))) {
    const nameLine = readFileSync(join(refDir, f), 'utf8').match(/^name:\s*"([^"]+)"/m)
    if (nameLine !== null) zcodeNames.add(nameLine[1])
  }
  const seatsScript = join(root, '..', 'zcode-collab', 'scripts', 'sync_from_manifest.py')
  if (existsSync(seatsScript)) {
    for (const m of readFileSync(seatsScript, 'utf8').matchAll(/^\s*"[^"]+":\s*"(advisor-[A-Za-z0-9_-]+)",\s*$/gm)) {
      zcodeNames.add(m[1])
    }
  }
  check('ZCode 侧解析出 advisor 三席名', zcodeNames.has('advisor-A') && zcodeNames.has('advisor-B') && zcodeNames.has('advisor-C'), [...zcodeNames].join(','))
}
// 圆桌行两侧必须逐字节一致（v1.4.0 起两侧同体验：都直书 advisor-A/B/C，
// 不再有 {{ADVISOR_CALL}} 这类分叉取值）
{
  const dshLine = roundTableLine(dshRules)
  const zcodeLine = roundTableLine(zcodeRules)
  check('圆桌行两侧逐字一致', dshLine !== undefined && dshLine === zcodeLine, dshLine === zcodeLine ? '' : `DSH=${JSON.stringify(dshLine)} ZCode=${JSON.stringify(zcodeLine)}`)
  for (const needle of ['同时调用 `advisor-A`、`advisor-B` 和 `advisor-C`', '三席必须配置为不同厂商']) {
    check(`圆桌行含「${needle}」`, typeof dshLine === 'string' && dshLine.includes(needle), dshLine === undefined ? 'no line' : dshLine)
  }
}
for (const [label, text, names] of [
  ['DSH', dshRules, dshNames],
  ['ZCode', zcodeRules, zcodeNames],
]) {
  const line = roundTableLine(text)
  check(`${label} 产物能找到圆桌条目（含「用户想听多方意见」的行）`, line !== undefined)
  const cited = line === undefined ? [] : backticked(line)
  check(`${label} 圆桌条目引用了至少一个角色名`, cited.length > 0, String(cited.length))
  for (const name of cited) {
    check(`${label} 圆桌条目引用的 ${name} 是真实角色名`, names.has(name), `可选：${[...names].join(',')}`)
  }
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' / ')}`)
  process.exitCode = 1
}
