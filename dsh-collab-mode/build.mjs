#!/usr/bin/env node
/**
 * 构建脚本：把 `content/` 下的单一来源内容内联成两份产物。
 *
 *   content/manifest.json      -> 角色清单与平台差异（唯一事实源）
 *   content/collab-rules.md    -> 按 dsh 平台渲染后进 lib/generated-content.js 的 RULES_TEXT
 *   content/roles/<角色>.md     -> lib/generated-content.js 的 ROLES[].persona
 *   cordis.patch.yml           -> 只插入 `collab-mode` 一行
 *
 * 改完 `content/` 必须重新运行 `node build.mjs`（等价于 `npm run build`），
 * 并用 `node scripts/check-drift.mjs` 校验角色数一致（源 5 份 → 两侧部署各 7 个）。
 * 两份产物都是生成物，禁止手改 —— 手改会在下一次构建时被覆盖，并让 ZCode 侧的
 * 同步失去意义（任务书设计决策 3：内容单一来源）。
 *
 * ⚠ v0.2.0 起，角色行**不再**由 cordis.patch.yml 插入，改由插件在运行时用
 * `ctx.loader.create()` 自己拥有。原因见 cordis.patch.yml 顶部注释与 README
 * 「设置面板」一节：对补丁插入的行调 `loader.update` 会走 `Include.write()`，
 * 把整棵合成树回写进 profile 的 `cordis.yml`；插件自己 create 的行挂在 Loader 的
 * root group 上，而 `Loader.write()` 是空实现，因此不会落盘。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

/* ---------- 第 0 步：从仓库根 content/ 构建时拷贝（合仓约定） ----------
 * 唯一事实源在仓库根 `../content/`。Windows 上 git symlink 不稳，
 * 所以每次构建先全量拷贝到本地 `content/` 再走原有生成逻辑。
 * 本地 `content/` 是构建中间产物，已进 .gitignore，不提交。 */
function syncContent() {
  const src = join(root, '..', 'content')
  const dst = join(root, 'content')
  if (!existsSync(src)) throw new Error(`仓库根 content/ 不存在：${src}`)
  rmSync(dst, { recursive: true, force: true })
  cpSync(src, dst, { recursive: true })
}

/** 读一份内容文件，统一换行并保证结尾恰好一个换行。 */
function readContent(rel) {
  const text = readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n').trimEnd()
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * 只读角色要从子智能体工具集里摘掉的写操作工具名。
 *
 * ⚠ 这些名字必须真实存在：`@deepseek-ai/dsh-tools` 的 `restrict()` 遇到未知工具名
 * 会直接抛错，子智能体就起不来。名单按本机 DSH 0.1.5-rc.1（web profile）实测的
 * 可见工具集确定，不含 Windows 上被 disabled 的 `bash`。
 *
 * ⚠ `subagent` 刻意不在名单里：本机预设把那一行配成 `modelSelectionSettings: true`，
 * 该工具会被注册进**每个 agent 自己的层**，而 `restrict()` 只认继承来的名字、
 * 明确拒绝「scope-local 名字」（见 dsh-tools 的 view()：restrictableNames 只收
 * global + 祖先层）。实测把 `subagent` 放进去会让每次委派都抛
 * `tools.restrict() names unknown global tool "subagent"`。
 * 后果：只读角色**自己**没有写工具，但**孙代**若由该子智能体经预设的 `subagent`
 * 工具派出，不会继承这里的 toolFilter，因此不受只读约束。详见 README「已知边界」。
 */
const MUTATING_TOOLS = [
  'write',
  'edit',
  'pwsh',
  'job_kill',
  'create_goal',
  'update_goal',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
  'exit_plan_mode',
  'send_message',
  'interrupt_agent',
  'workflow',
  'ralph',
  'subagent_fork',
  'todo_write',
]

/**
 * 角色（`readonly: true` 的）通过 `toolFilter.deny` 摘掉全部写操作工具，
 * 权限由 DSH 的工具注册表强制（不是写在提示词里求模型自觉）。
 *
 * `maxDepth: 1`：角色子智能体自己不能再往下派子智能体（子智能体继承父会话预设，
 * 不设上限就会递归）。
 *
 * `backgroundMode: one-shot`：默认前台等待并直接返回结果 —— 走流程时主智能体
 * 需要拿到执行/审查结论才能裁决。
 */

/**
 * 读 `content/manifest.json`。
 *
 * ⚠ v0.3.0 起，**角色清单与平台差异都由 manifest 拥有**，本文件不再自带 ROLES 表。
 * 原因：v0.2.x 时角色表写在这里、正文写在 `content/roles/*.md`，
 * ZCode skill 侧另有一份手写搬运的副本 —— 手工同步两份文本导致丢过规则。
 * 现在 `content/` 是唯一事实源，`manifest.json` 描述它，ZCode 侧从同一份渲染。
 *
 * `MUTATING_TOOLS` 仍留在本文件：那是 **DSH 侧机制**（`tools.restrict()` 的
 * 工具名白名单），不属于两平台共用的内容，skill 侧不需要它。
 */
function readManifest() {
  const manifest = JSON.parse(readFileSync(join(root, 'content', 'manifest.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null) throw new Error('content/manifest.json must be an object')
  if (!Array.isArray(manifest.roles) || manifest.roles.length === 0) {
    throw new Error('content/manifest.json must declare a non-empty roles array')
  }
  return manifest
}

/**
 * 按平台渲染 `content/collab-rules.md`（规则文本单一来源）。
 *
 * 占位符语法约定（ZCode 侧 `zcode-collab/scripts/sync_from_manifest.py`
 * 的 `render_rules()` 必须与此处逐字一致地实现同一语义）：
 *
 *   `{{NAME}}`            行内替换：取 `manifest.rules.placeholders[NAME][platform]`，
 *                         取值一律来自 manifest，本文件不写死任何角色名或文案。
 *   `{{#platform}}` 块    平台块：起始行与结束行各占一整行（行内无其他内容）。
 *                         当前平台命中 → 去掉两行标记、保留块内内容；
 *                         未命中 → 整块删除，并连同块前的一个空行一起删掉
 *                         （源里用「空行 + 块」表示该块独占一段）。
 *
 * 渲染后若仍残留 `{{` 一律抛错（占位符名拼错、块未闭合都会在这里暴露）。
 */
function renderRules(text, platform, placeholders) {
  const lines = text.split('\n')
  const out = []
  let skipping = null
  for (const line of lines) {
    const open = /^\{\{#([A-Za-z0-9_-]+)\}\}$/.exec(line)
    if (open !== null && skipping === null) {
      if (open[1] === platform) continue
      skipping = open[1]
      if (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
      continue
    }
    const close = /^\{\{\/([A-Za-z0-9_-]+)\}\}$/.exec(line)
    if (close !== null) {
      if (skipping !== null) {
        if (close[1] !== skipping) throw new Error(`平台块 {{#${skipping}}} 被 {{/${close[1]}}} 关闭，标签不匹配`)
        skipping = null
        continue
      }
      if (close[1] === platform) continue
      throw new Error(`出现孤立的平台块结束标记 {{/${close[1]}}}（没有对应的 {{#${close[1]}}}）`)
    }
    if (skipping !== null) continue
    out.push(line)
  }
  if (skipping !== null) throw new Error(`平台块 {{#${skipping}}} 没有闭合的 {{/${skipping}}}`)

  const rendered = out.join('\n').replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (raw, name) => {
    const value = placeholders?.[name]?.[platform]
    if (typeof value !== 'string' || value === '') {
      throw new Error(`占位符 ${raw} 在 manifest.rules.placeholders 里没有 ${platform} 取值`)
    }
    return value
  })
  const left = /\{\{[^}]*\}\}/.exec(rendered)
  if (left !== null) throw new Error(`渲染 ${platform} 规则文本后仍有占位符残留：${left[0]}`)
  return rendered
}

/**
 * 一个角色在 DSH 侧展开成几行。
 *
 * 默认一行（`dsh.toolName`）。`dsh.seats` 非空时按席位展开：每个席位一行，
 * `key` 与工具名都用席位名（advisor → advisor-A / advisor-B / advisor-C），
 * persona 同文（三席共用 `content/roles/advisor.md` 一份源）。
 * 面板的 ROLE_ROWS 与 loader 行 id 都按展开后的 key 走，因此两侧数量必须相等。
 */
function dshSeats(role) {
  const seats = role.dsh.seats
  if (seats === undefined) return [{ key: role.key, tool: role.dsh.toolName }]
  if (!Array.isArray(seats) || seats.length === 0) {
    throw new Error(`manifest role "${role.key}" 的 dsh.seats 必须是非空数组`)
  }
  return seats.map((seat) => {
    if (typeof seat !== 'string' || seat === '') {
      throw new Error(`manifest role "${role.key}" 的 dsh.seats 里有空席位名`)
    }
    return { key: seat, tool: seat }
  })
}

/** 展开全部角色（manifest 5 条源 → DSH 侧 7 行）。 */
function expandRoles(manifest) {
  return manifest.roles.flatMap((role) => {
    if (typeof role.key !== 'string' || role.key === '') throw new Error('manifest role is missing "key"')
    if (typeof role.file !== 'string' || role.file === '') throw new Error(`manifest role "${role.key}" is missing "file"`)
    if (typeof role.dsh !== 'object' || role.dsh === null) throw new Error(`manifest role "${role.key}" is missing "dsh"`)
    if (typeof role.dsh.toolName !== 'string' || role.dsh.toolName === '') {
      throw new Error(`manifest role "${role.key}" is missing "dsh.toolName"`)
    }
    if (typeof role.dsh.readonly !== 'boolean') throw new Error(`manifest role "${role.key}" is missing "dsh.readonly"`)
    const persona = readContent(join('content', role.file))
    return dshSeats(role).map((seat) => ({
      key: seat.key,
      tool: seat.tool,
      readonly: role.dsh.readonly,
      persona,
      deny: role.dsh.readonly ? MUTATING_TOOLS : null,
    }))
  })
}

syncContent()
const manifest = readManifest()

/* ---------- 产物一：lib/generated-content.js ---------- */

const rules = renderRules(
  readContent(join('content', manifest.rules.file)),
  'dsh',
  manifest.rules.placeholders,
)
const roles = expandRoles(manifest)

const generatedJs = `// 本文件由 build.mjs 从 content/ 生成，请勿手改。
// 重新生成：node build.mjs
export const RULES_TEXT = ${JSON.stringify(rules)}
export const ROLES = ${JSON.stringify(roles, null, 2)}
`
writeFileSync(join(root, 'lib/generated-content.js'), generatedJs, 'utf8')

/* ---------- 产物二：cordis.patch.yml ---------- */

const patch = `# dsh-collab-mode bundle patch —— 本文件由 build.mjs 生成，请勿手改。
# 重新生成：node build.mjs
#
# 这一层挂在 Host 平面（profile root → dsh-base → dsh-web-app → 本 bundle →
# profile 自己的 cordis.patch.yml → home 补丁 → --patch 覆盖层），因此协作模式对
# 每个会话可见，不依赖会话选了哪个 agent preset。
#
# ⚠ 这里只插入插件自己一行。七个角色行（collab-executor / collab-code-reviewer /
# collab-researcher / collab-advisor-A / collab-advisor-B / collab-advisor-C /
# collab-vision-reader）改由插件在运行时用
# ctx.loader.create() 创建，因为设置面板要按角色热改它们的 agentOptions：
#
#   补丁 insert 出来的行挂在文件后端 Include 的 root group 上，
#   对它调 loader.update 会走 EntryTree.update 结尾的 source.tree.write()
#   → Include.write() → 把整棵**合成树**回写进 ~/.dsh/profiles/web/cordis.yml，
#   压平 bundle / profile / home 三层补丁。
#
#   插件自己 create 的行挂在 Loader 自己的 root group 上，而 Loader.write() 是
#   空实现（no-op），所以 loader.update 不落盘、只热重启那一行。
#
# 想覆盖插件自身的配置（钩子开关、阈值、日志目录）时，在更靠后的层按 id 覆盖即可；
# 注意 DSH 的 patch 语义是「整行替换 config」，被覆盖的行要重述它拥有的每一个键。

- insert:
    - id: collab-mode
      name: 'dsh-collab-mode'
`

writeFileSync(join(root, 'cordis.patch.yml'), patch, 'utf8')

console.log(
  `dsh-collab-mode: generated lib/generated-content.js (${rules.length} chars of rules, ` +
    `${roles.length} roles, ${MUTATING_TOOLS.length} denied tools per read-only role) ` +
    `and cordis.patch.yml (1 host row; role rows are plugin-owned)`,
)
