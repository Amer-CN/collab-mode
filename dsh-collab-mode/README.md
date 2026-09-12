# dsh-collab-mode

DeepSeek Harness 插件：把 ZCode 侧那套「协作模式」搬到 DSH 上。

> ### 🤖 给要改这个插件的 AI
>
> **动手前先读仓库根的 [`AGENTS.md`](../AGENTS.md)** —— 改哪个文件、哪些是生成物、
> 跑哪三条验证、九个实测坑，全在里面。
>
> 三条最容易踩的：
> 1. **规则内容不在本目录**：五角色提示词与协作纪律的源在**上一级** `../content/`。
>    本目录的 `content/` 是 `build.mjs` 拷贝出来的构建产物，已 gitignore——改它没用。
> 2. **改完必须重启 `dsh web`**：模块代码不能热更新（实测三种热加载手段全失败）。
> 3. **验证三件套**：`node build.mjs` → `node scripts/check-drift.mjs`（49/49）→
>    `node tests/verify-plugin.mjs`（72/72）。首次跑夹具前先 `npm install`。

它注册五类东西：

| # | 内容 | 实现落点 |
|---|---|---|
| 1 | 五个角色子智能体工具 | 插件用 `ctx.loader.create()` 自己拥有的五行 `@deepseek-ai/dsh-tool-subagent` |
| 2 | 协作纪律系统提示段 | `ctx.systemPrompt.section` |
| 3 | 改动前拦截 + 工具调用审计 | `tools/pre-execute` / `tools/post-execute` |
| 4 | 轮次结束告警 | `agent/turn-stopping` |
| 5 | 设置面板（v0.2.0） | settings 命名空间 `collab-mode` + 客户端卡片 `settings.plugin.item` |

钩子走 DSH 的**代码级事件**，不依赖 `@deepseek-ai/dsh-hooks-claude-code` 适配器，也不复用 ZCode 的 PowerShell 脚本。

## 安装

```powershell
dsh plugin --profile web add link:F:/AIXM/collab-mode/dsh-collab-mode
# 发布到 npm 之后：
# dsh plugin --profile web add dsh-collab-mode
```

`dsh plugin` 转发给 pnpm 之后会把包名补进 profile 的 `dsh.profile.bundles`。**重启 `dsh web` 生效**（bundle 层在进程启动时合成；已挂载的旧进程看不到新 bundle）。

⚠ **改本插件的模块代码也需要重启**：cordis 的 HMR 只监听补丁文件（`cordis-plugin-hmr` 的 `root: []` 不监听模块文件），loader 又复用已解析包的 ESM 模块缓存 —— 实测改 `main` / `exports` / 换 entry id 都无法在运行中的进程里换掉已加载的模块。改 `content/` 之类只影响生成物的改动同样要重启才生效。

卸载：

```powershell
dsh plugin --profile web remove dsh-collab-mode
```

## 设置面板（v0.2.0）

「设置 → 插件 → 插件配置」里的**协作模式**卡片，排在 Free Search 之后，四个区块：

| 区块 | 内容 | 落点 |
|---|---|---|
| A 角色路由 | 五行 × 供应商 / 模型 / 推理强度 / maxTokens，**留空 = 继承当前会话模型** | settings 命名空间 `collab-mode` |
| B 纪律开关 | `gate` / `audit` / `warnOnTurnEnd` + 未声明文件阈值 + 审计目录 | 同上；`cordis.patch.yml` 里的值降级为默认值 |
| C 自检 | 插件版本、提示段字符数、五个角色工具**是否已注册**、各自**实际生效路由**、审计目录、最近一条审计记录、刷新与探测按钮 | 宿主只读路由 `GET /api/collab-mode/selfcheck` |
| D 角色定义 | 每行的 loader 行 id / 是否运行 / toolFilter 条数 / persona 字符数（只读） | 同一自检路由 |

A/B 的读写走**原生 client settings scope**（`ctx.settingsScope.bind`），不经过自建 HTTP bridge；`unset` 用于「留空」，因此清空字段是退回组合层默认值，而不是写一个空串进用户层。

### 客户端半侧的依赖声明（v0.2.1 修复）

```js
const inject = ['slots', 'settingsScope']
```

⚠ **`settingsScope` 必须列在 `inject` 里，不能靠 `ctx.get()` 一次性读取。**
Cordis 的 `ctx.get(name)` **不参与依赖等待**：`ServiceRegistry.notify` 只对出现在
`fiber.inject` 里的名字重评估 fiber。服务若晚于本插件就绪，一次性读取就永远拿到
`undefined`，卡片会**永久锁死在降级态** —— v0.2.0 的面板不可编辑（A/B 区块全灰 +
红色降级提示）就是这个原因，v0.2.1 修掉。

**代价与取舍**：硬依赖意味着 `settingsScope` 缺席时**整个客户端插件不加载**、卡片不出现，
失去「服务未就绪」那一档的可读降级文案。这个损失经核实是空的：

- `settings.plugin.item` 插槽本身由 `dsh-client-ui-settings-plugins` 的
  `ConfigurablePluginsTab` 声明，而它的 `inject` 也含 `settingsScope` ——
  服务缺席时插槽根本不存在，卡片本来也无处注册。
- **命名空间级**降级（宿主未服务该 ns、memory 模式不可写）**不受影响**，仍由卡片内
  `status !== 'ready'` 分支给出可读原因。

夹具对这条有专门的回归断言（`.work/verify-plugin.mjs` 的 T13），且已验证「把
`settingsScope` 从 `inject` 删掉时断言必须失败」。

### 角色路由怎么真正下发（机制 1：Loader 改写）

面板保存 → settings 值变化 → 插件把每行角色的 `agentOptions` 热写进对应 loader entry 的
`config` → `loader.update(id, { config })` 重启那一行 → `dsh-tool-subagent` 用新路由重建工具。
**不落盘、不动 `cordis.patch.yml`**，因此不需要重述五个角色约 10KB 的 persona。

⚠ **为什么五个角色行由插件 `ctx.loader.create()` 拥有，而不是 `cordis.patch.yml` 的 `insert`：**

`EntryTree.update()`（也就是 `loader.update`）结尾会无条件调 `source.tree.write()`
（`cordis-plugin-loader/src/config/tree.ts`）。而 `tree` 是谁取决于 entry 挂在哪个 group：

- **补丁 `insert` 出来的行**落在文件后端 `Include`（`dsh-app-boot` 的 EntryTree 子类，
  `.yml` 在它的 `writable` 映射里）的 root group 上 → `entry.parent.tree === Include`
  → `Include.write()` → `writeFile(this.root.data)` → **把整棵合成树回写进
  `~/.dsh/profiles/web/cordis.yml`**，压平 bundle / profile / home 三层补丁。
- **插件 `ctx.loader.create()` 创建的行**落在 `Loader` 自己的 root group 上
  → `entry.parent.tree === Loader` → `Loader.write()` 是**空实现**（同文件 `write() {}`）
  → 不落盘。

离线夹具（`.work/verify-plugin.mjs`）断言插件全程不调用 `loader.write()`；交付前后也比对过
`~/.dsh/profiles/web/cordis.yml` 的内容哈希与 mtime。

### 自检路由为什么存在

A/B 能走原生 scope，但「工具到底注册没有 / 实际生效什么路由 / 最近一条审计是什么」是**运行时事实**，
不在 settings 值里，所以 C 区块由宿主侧一条只读路由提供（`ctx.webServer.register`，`kind: 'exact'`）。
卡片在命名空间未被服务、自检路由不可用、条目缺失时都给出可读原因，不白屏。

⚠ **这条路由必须自己走信任栅栏**（v0.2.0 修复）：

`webServer.match()` 是「**exact 表优先**，未命中再比 prefix」（`dsh-host-webserver` 的 `match()`），
而 composition 的信任栅栏（Host/Origin 检查 + 浏览器认证 cookie）挂在 `dsh-client-connection`
的 `/api` **prefix** 路由上。自检路由是 `/api/...` 下的 **exact** 路由，**优先级高于那道栅栏** ——
不自己校验就会绕过认证，任何本机进程都能读到日志目录、审计目标这些运行时事实。

因此 `apply` 注入 `connection`，在 handler 开头调 `connection.requestRejection(req)`
（与官方 `@deepseek-ai/dsh-host-open-in-app` 同一做法），拒绝即返回 401/403；
拿不到 connection 时该 fiber 等待、路由不注册（硬依赖），而不是放行。
客户端侧对应地用 `credentials: 'same-origin'` 带上 cookie。

实测证据：修复前命令行**不带 cookie** 请求该路由返回 **200**（而随便一个不存在的 `/api` 路径返回 401）；
离线夹具对「401 拒绝 / 放行 200 / 非 GET 405 / 缺 connection 时不注册」四条都有断言。


## 1. 五个角色工具

| 工具名 | 职责 | 权限 |
|---|---|---|
| `executor` | 按简报执行改动 | 可写 |
| `code-reviewer` | 独立审查：只看简报与仓库实际改动，不看执行者自述 | 只读 |
| `researcher` | 只读调研：本地代码库、互联网、GitHub | 只读 |
| `advisor` | 只给判断与理由，不写代码 | 只读 |
| `vision-reader` | 识图：只返回客观描述，不做分析建议 | 只读 |

- 工具名与 ZCode 侧完全一致，同一份规则文本在两个 harness 上指同一角色。
- **权限由 DSH 的工具注册表强制**：只读角色通过 `@deepseek-ai/dsh-tool-subagent` 的 `toolFilter.deny` 摘掉写操作工具，不是写在提示词里求模型自觉。
- 每个角色的 persona 与默认模型通过插件配置项暴露（见下文「配置」）。
- 子智能体继承父会话预设，因此 `maxDepth: 1` 关掉递归：角色子智能体不能再往下派。

`toolFilter` 的工具名必须是真实存在的名字 —— `@deepseek-ai/dsh-tools` 的 `restrict()` 遇到未知名字会直接抛错。名单在 `build.mjs` 的 `MUTATING_TOOLS` 里，按本机 DSH 0.1.5-rc.1（web profile）实测的可见工具集确定，不含 Windows 上被 `disabled` 的 `bash`。换预设后若有名字消失，需要同步这份名单。

## 2. 协作纪律系统提示段

正文单一来源：`content/collab-rules.md`，构建时内联成 `lib/generated-content.js` 的 `RULES_TEXT`，由插件注册为一个系统提示段（默认名 `collab-mode:rules`，排序位 400 —— 在 persona 之后、PLAN_POLICY 之前）。

段落保真的语义：范围铁律、A/B/C/D 模式判断、用户纠偏词、改动自检、走流程四步、汇报纪律、决策前置（双钢人）、子智能体选择规则。

## 3. 改动前拦截（`tools/pre-execute`）

只对 `edit` / `write` 生效，判定逻辑与 ZCode 侧 `enforce-flow.ps1` 同语义：

- 维护「本会话已改动且未被简报声明的生产文件」集合；累计到 `declarationThreshold`（默认 3）→ **deny**，拒绝信息里**列出未声明的文件名**（最多 8 个，其余折成 `(+N more)`）。
- 不计入统计的路径：`$DSH_HOME` 治理树、任何 `.work/` 下的文件、`.git/` 内部文件。
- 覆盖判定：取文件**名**（leaf），在简报全文里做子串匹配（大小写不敏感），命中即视为已声明。
- 简报 = 「会话工作目录树」向上找到的第一个含 `current-task.md` 或 `task-*.md` 的 `.work/`，并上「目标文件自己所在目录树」的同样结果 —— 文件可能合法地活在会话项目之外，两棵树都查才不会误拦。

## 4. 审计（`tools/post-execute`）

每次工具调用追加一行 JSON 到 `<logDir>/activity-<sessionId>.log`（默认 `$DSH_HOME/hooks/`）：

```json
{"ts":"2026-09-11T23:10:04.512Z","sid":"session-xxxx","tool":"write","target":"F:\\path\\file.js","ok":true,"latency":37}
```

字段名与 ZCode 侧 `post-tool-audit.ps1` 一致（`ts` / `sid` / `tool` / `target` / `ok` / `latency`），便于两边用同一套下游工具解析。被 `tools/pre-execute` 拒绝的调用同样会留一行（`ok: false`）。

轮次结束告警也会留一行 `tool: "collab-mode:turn-warning"` 的记录，作为机器可查的凭据。

## 5. 轮次结束告警（`agent/turn-stopping`）

本会话已有 ≥`declarationThreshold` 个未声明改动 → 通过 `agent.steer` 告警并列出文件名，驱动会重读收件箱多走一步；否则静默。

两点刻意的取舍：

- **阈值与拦截阈值一致（≥3）**。规则文本本身规定 D 类（≤2 个文件）不需要简报，若字面按「有任何未声明改动就告警」实现，会和同一份规则自相矛盾，并且每轮结束都刷屏。
- **同一组未声明文件只告警一次**（按文件名排序后做键）。状态没变化就不重复告警，避免死循环式噪音。

## 配置

配置写在 bundle patch 的那一行上；覆盖时在更靠后的层（例如 `~/.dsh/profiles/web/cordis.patch.yml`）按 id 覆盖。⚠ DSH 的 patch 语义是**整行替换 config**，被覆盖的行要重述它拥有的每一个键。

钩子行（`collab-mode`）：

```yaml
- id: collab-mode
  config:
    gate: true                  # 改动前拦截总开关
    audit: true                 # 审计总开关
    warnOnTurnEnd: true         # 轮次结束告警总开关
    declarationThreshold: 3     # 未声明生产文件的累计阈值
    rulesSection: collab-mode:rules
    rulesOrder: 400             # 400 = persona 之后、PLAN_POLICY(500) 之前
    logDir: C:/Users/Admin/.dsh/hooks
```

角色行（`collab-executor` / `collab-code-reviewer` / `collab-researcher` / `collab-advisor` / `collab-vision-reader`）暴露 `provider`、`toolName`、`backgroundMode`、`maxDepth`、`agentOptions{provider,model}`、`toolFilter{allow,deny}`、`persona`。默认不写 `agentOptions`，即子智能体继承父会话的模型路由；要分角色指定模型时：

```yaml
- id: collab-researcher
  config:
    provider: spawn
    toolName: researcher
    backgroundMode: one-shot
    maxDepth: 1
    agentOptions:
      provider: <供应商>
      model: <模型 id>
    toolFilter:
      deny: [write, edit, pwsh, ...]   # 只读角色
    persona: |-
      ...                              # 把本包 cordis.patch.yml 对应块原样抄回来
```

配置不合法会在 mount 时抛错，不回退默认值 —— 静默降级比启动失败更难查。

## 单一来源与构建

```
content/manifest.json     ── 角色清单 + 平台差异（唯一事实源）
content/collab-rules.md   ─┐
content/roles/*.md        ─┴─ node build.mjs ─┬─ lib/generated-content.js （提示段正文 + 五角色的 persona/deny 名单）
                                              └─ cordis.patch.yml          （只插入 collab-mode 一行）
```

改完 `content/` 必须依次运行：

```powershell
node build.mjs              # 重新生成两份产物（等价 npm run build）
node scripts/check-drift.mjs # 防漂移自检（等价 npm run check）
```

两份产物都是生成物，**不要手改** —— 下一次构建会覆盖，并让 ZCode 侧的同步失去意义。

### `content/` 是唯一事实源（v0.3.0 起的约定）

| 文件 | 拥有什么 |
|---|---|
| `content/manifest.json` | 角色清单（key / file）、DSH 侧平台信息（`dsh.toolName` / `dsh.readonly`）、ZCode 侧平台信息（`zcode.description` / `color` / `tools` / `injectAgentsMd`）、内容版本号 |
| `content/roles/*.md` | 每个角色的**正文**（persona），两平台共用 |
| `content/collab-rules.md` | 协作纪律提示段正文 |
| `build.mjs` 的 `MUTATING_TOOLS` | DSH 侧机制（`tools.restrict()` 的工具名白名单）—— **不属于内容**，skill 侧不需要 |

**为什么要有这套约定**：v0.2.x 时角色清单写在 `build.mjs`、正文写在 `content/roles/*.md`，
ZCode skill 侧另有一份**手写搬运**的副本。手工同步两份文本的结果是丢了 10 条实质规则，
而且没人发现 —— 自动字符串比对也救不了，因为改写会把「丢失」伪装成「不同」。

现在 ZCode skill 的 `references/agent-*.md` **由 `content/` + `manifest.json` 渲染**，
不再手写。**改内容的唯一正确做法是改 `content/`，然后 `build.mjs` + `check-drift.mjs`。**

### `scripts/check-drift.mjs` 断言什么

1. `manifest.json` 可解析、字段齐备，每个 `roles[].file` 存在且非空；
2. **四处角色数必须相等**：`manifest.roles` == `content/roles/*.md` == 生成的 `ROLES` == 面板 `ROLE_ROWS`（`lib/client.js`）；
3. 生成物与 `content/` **同步**：重新构建后两个生成物的 SHA256 不变（即没人手工编辑过生成物）；
4. 两个生成物文件头都带「请勿手改」告示；
5. 每个角色的 `zcode` 块字段齐备（`description` / `color` / `tools` / `injectAgentsMd`）。

⚠ 五个角色行**不在** `cordis.patch.yml` 里（v0.2.0 起由插件用 `ctx.loader.create()` 拥有，
原因见上文「角色路由怎么真正下发」）。因此 `dsh --profile web --dump-config` 只能看到
`collab-mode` 一行 —— 角色行的存在性要看自检区（C 区块）或
`GET /api/collab-mode/selfcheck` 的 `roles[].entryPresent / active`。

## 已知边界

- **只读名单依赖工具名**：`toolFilter.deny` 里的名字必须真实存在，见上文。
- **`subagent` 无法被只读过滤器摘掉**：本机预设把 `tool-subagent` 那行配成 `modelSelectionSettings: true`，该工具会注册进**每个 agent 自己的层**；而 `@deepseek-ai/dsh-tools` 的 `restrict()` 只认继承来的名字（global + 祖先层），明确拒绝 scope-local 名字。实测把它放进 `deny` 会让每次委派都抛 `tools.restrict() names unknown global tool "subagent"`。
  影响面：只读角色**自己**确实没有写工具（实测子智能体列出的工具集里没有 `write`/`edit`/`pwsh`），但它若主动去用预设那个 `subagent` 工具往下再派一层，**孙代不会继承这里的 `toolFilter`**（`dsh-subagent` 的委派只延续 sandbox/approval 两项策略，不延续 persona/toolFilter），那一层就不受只读约束了。`maxDepth: 1` 只管住本插件这五个工具自身的递归深度。
  要彻底关掉这条路径，需要在预设平面把 `tool-subagent` 的 `maxDepth` 一起收紧，或改用不接受 `modelSelectionSettings` 的注册方式 —— 都属于改预设组合，不在本插件范围内。
- **状态是进程内的**：`seen` / `changed` 按 sessionId 存在内存里，进程重启或会话恢复后从空开始（与 `@deepseek-ai/dsh-repeat-tool-reminder` 的取舍一致）。审计日志是落盘的，可追。
- **改代码后无法在运行中的进程里热更新**：cordis 的 HMR（`root: []`）只监听补丁文件，不监听模块文件，且 loader 复用已解析包的 ESM 模块缓存。改完插件代码要重启 `dsh web` 才生效。
- **不含 `/roundtable` 命令**：任务书第 4 项标为「建议，可选」，本次未实现。多方意见目前靠重复调用 `advisor` 实现，规则文本已如此描述。
- **不修改任何出厂预设**：插件走 profile bundle 层（Host 平面），与 agent preset 无关。

## 版本

针对 DSH `0.1.5-rc.1` 开发与实测。零运行时依赖（只用 `node:` 内置模块），因此 `link:` 安装下也能正常解析。
