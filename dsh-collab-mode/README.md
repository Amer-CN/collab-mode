# dsh-collab-mode

DeepSeek Harness 插件：把 ZCode 侧那套「协作模式」搬到 DSH 上。

> ### 🤖 给要改这个插件的 AI
>
> **动手前先读仓库根的 [`AGENTS.md`](../AGENTS.md)** —— 改哪个文件、哪些是生成物、
> 跑哪几条验证、实测踩过的坑，全在里面。
>
> 三条最容易踩的：
> 1. **规则内容不在本目录**：五角色提示词与协作纪律的源在**上一级** `../content/`。
>    本目录的 `content/` 是 `build.mjs` 拷贝出来的构建产物，已 gitignore——改它没用。
> 2. **改完必须重启 `dsh web`**：模块代码不能热更新（实测三种热加载手段全失败）。
> 3. **验证三件套**：`node build.mjs` → `node scripts/check-drift.mjs`（全绿）→
>    `node tests/verify-plugin.mjs`（全绿）。首次跑夹具前先 `npm install`。

它注册五类东西：

| # | 内容 | 实现落点 |
|---|---|---|
| 1 | 七个角色子智能体工具 | 插件用 `ctx.loader.create()` 自己拥有的七行 `@deepseek-ai/dsh-tool-subagent`（advisor 一份源展开成 advisor-A/B/C 三席） |
| 2 | 协作纪律系统提示段 | `ctx.systemPrompt.section` |
| 3 | 改动前拦截 + 工具调用审计 | `tools/pre-execute` / `tools/post-execute` |
| 4 | 轮次结束告警 | `agent/turn-stopping` |
| 5 | 设置面板（v0.2.0；v0.6.0 移植到 0.2.0-rc.2 API） | 宿主条目 config 的 `.volatile()` 字段（客户端经 `ctx.configForms.get('collab-mode')` 读写）+ `settings.section` 独立导航（id collab-mode，order 79，使用统计上方） |

钩子走 DSH 的**代码级事件**，不依赖 `@deepseek-ai/dsh-hooks-claude-code` 适配器，也不复用 ZCode 的 PowerShell 脚本。

## 安装

GitHub 分发（2026-09-13 决策：**不发布 npm**），克隆仓库后 `link:` 安装：

```powershell
git clone https://github.com/Amer-CN/collab-mode.git
dsh plugin --profile web add link:<克隆到的父目录>/collab-mode/dsh-collab-mode
```

- 仓库根没有 package.json，pnpm 12 实测不支持从子目录安装（`#path=` 解析报错；git URL 整仓直装会装成无入口伪包），所以是克隆 + `link:` 两步。npm 包名安装（`dsh plugin --profile web add dsh-collab-mode`）仅当未来改变决策、正式发包后才可用。
- 本地开发（作者机器）：`dsh plugin --profile web add link:F:/AIXM/collab-mode/dsh-collab-mode`

`dsh plugin` 转发给 pnpm 之后会把包名补进 profile 的 `dsh.profile.bundles`。**重启 `dsh web` 生效**（bundle 层在进程启动时合成；已挂载的旧进程看不到新 bundle）。

⚠ **改本插件的模块代码也需要重启**：cordis 的 HMR 只监听补丁文件（`cordis-plugin-hmr` 的 `root: []` 不监听模块文件），loader 又复用已解析包的 ESM 模块缓存 —— 实测改 `main` / `exports` / 换 entry id 都无法在运行中的进程里换掉已加载的模块。改 `content/` 之类只影响生成物的改动同样要重启才生效。

卸载：

```powershell
dsh plugin --profile web remove dsh-collab-mode
```

## 设置面板（v0.2.0 建，v0.4.0 改为 ZCode 子智能体页同款两视图）

设置左侧导航里的「协作模式」栏（紧贴「使用统计」上方）。页内分列表 / 编辑两视图，
外观照抄 ZCode `Settings → Subagents`，语义按 DSH（用户决策：外观复刻、语义适配——
新建/删除/启用开关/persona 可编辑/工具勾选一律不做）：

| 视图 | 内容 | 落点 |
|---|---|---|
| 列表 | 7 行（色点 + 名称 + 模型 chip + 工具计数 + 描述，一行截断）＋搜索框，点行进编辑；行上无可写/只读 tag，未注册才红字提示；B/C/D 原样排在列表下方 | 自检 roles[] 的描述/颜色/路由/工具清单（只读展示） |
| 编辑 | 面包屑（协作模式 ＞ 角色名）＋名称（只读）/颜色标记（8 色点选，当前行单独保存）/供应商→模型两级下拉/推理强度（跟随选中模型的 advertised 档位，默认档有标记；未选模型或查不到时回退静态全集 off…xhigh）/maxTokens/描述（只读）/可用工具（只读）/系统提示词（只读）＋保存/放弃/返回列表 | 下拉选项来自自检 `modelCatalog`（`llm` 服务全目录）与只读路由 `GET /api/collab-mode/model-efforts`；拿不到就降级，绝不白屏。供应商一切换自动清空模型＋档位（防幽灵组合）；目录里没有的旧值标红字"失效，目录无此项"且不可提交 |

| 区块 | 内容 | 落点 |
|---|---|---|
| B 纪律开关 | `gate` / `audit` / `warnOnTurnEnd` + 未声明文件阈值 + 审计目录 | 宿主条目 `collab-mode` 的 config（`.volatile()` 字段） |
| C 自检 | 运行卡显示（总开关/行数/折叠数/列勾选，草稿制）＋运行状态折叠组（插件版本、提示段字符数、七个角色工具是否已注册、生效路由四列表、审计目录、最近一条审计记录、刷新与探测按钮） | 宿主只读路由 `GET /api/collab-mode/selfcheck`（另带 `modelCatalog`，best-effort，失败回 null） |
| D 角色定义 | 已移除（v1.3.0，面板嫌长；看角色定义直接读仓库 `content/roles/*.md`） | — |

A/B 的读写走**客户端的配置表单服务**（0.2.0-rc.2 起是 `ctx.configForms.get('collab-mode')`，取代了被删除的 `settingsScope.bind`），不经过自建 HTTP bridge；写入落到 profile 的 `cordis.patch.yml` 里该条目的 config。`unset` 用于「留空」，因此清空字段是退回组合层默认值，而不是写一个空串进用户层。

### 客户端半侧的依赖声明（v0.6.0：移植到 DSH 0.2.0-rc.2）

```js
const inject = ['slots', 'configForms']
```

⚠ **两个名字都必须列在 `inject` 里，不能靠 `ctx.get()` 一次性读取。**
Cordis 的 `ctx.get(name)` **不参与依赖等待**：`ServiceRegistry.notify` 只对出现在
`fiber.inject` 里的名字重评估 fiber。服务若晚于本插件就绪，一次性读取就永远拿到
`undefined`，卡片会**永久锁死在降级态** —— v0.2.0 的面板不可编辑（A/B 区块全灰 +
红色降级提示）就是这个原因，v0.2.1 用 `settingsScope` 修掉；而 `settingsScope`
在 0.2.0-rc.2 里被整体删除（改名成 `configForms`），v0.6.0 跟着改名。

**代价与取舍**：硬依赖意味着 `configForms` 缺席时**整个客户端插件不加载**、面板不出现
——而且在**桌面端**这不只是「面板不出现」：客户端条目永久 `pending` 会被启动审计判定为
**致命**，应用直接拒绝启动，并触发「禁用第三方插件、备份 profile patch 并重启」的恢复
动作（那会重置 profile 的 `dsh.profiles.bundles`）。所以这两个名字必须真的存在：
`slots` 由 `dsh-client-ui-renderer` 提供、`configForms` 由 `dsh-client-ui-settings` 提供，
两者都在 `dsh-base + dsh-web-app` 组合里。

**⚠ 不要用 `ctx.inject([...], cb)` 去等这两个服务**：`ctx.inject` 的语义是「等不到就整段
不跑」，用在硬依赖上会把「不可用」变成「静默少一块」。同理，面板用到的那几个**可选**
服务（`sidebarRightTabs` / `sessions` / `uiWorkspace`）继续走 `ctx.inject` 或调用时
`ctx.get()` 取值 —— 它们是软依赖，服务不在时对应功能整段不注册，客户端条目照样激活。

- 条目级降级（宿主未服务该条目、memory 模式不可写）**不受影响**，仍由卡片内
  `status !== 'ready'` 分支给出可读原因（面板顶部那句「宿主侧没有提供 collab-mode
  设置命名空间…」就是它）。

夹具对这条有专门的回归断言（`tests/verify-plugin.mjs` 的 T13）：`inject` 恰好是
`slots + configForms`、`client.js` 里不再出现 `settingsScope`（含注释）、导航注册包在
`ctx.configForms.whileServed([NS], …)` 里，并用 0.2.0 形态的 ctx 断言
`configForms.get` 收到的实参就是条目 id `collab-mode`。

**宿主侧的对应形态**（v0.6.0）：`settings.installSection` 已从 0.2.0 删除，插件改为在
自己的 Config schema 里把可编辑字段标 `.volatile()`（面板按条目 id 读写它们），并在
`ctx.inject(['settings'], …)` 的**可选**子级里 `configure({ auto: false }, ctx.fiber)`
声明「我自己有面板页，别按 schema 生成表单」；配置变更经宿主事件
`settings/document-updated`（载荷含条目 id）通知，插件重读 volatile 引用并重建七个
角色行 —— volatile 字段是**就地更新的稳定引用**（`config.<字段>.get()` 永远给最新值），
所以面板保存后角色行立刻跟着变，不需要重启 fiber。

### 角色路由怎么真正下发（机制 1：Loader 改写）

面板保存 → settings 值变化 → 插件把每行角色的 `agentOptions` 热写进对应 loader entry 的
`config` → `loader.update(id, { config })` 重启那一行 → `dsh-tool-subagent` 用新路由重建工具。
**不落盘、不动 `cordis.patch.yml`**，因此不需要重述七个角色约 10KB 的 persona。

⚠ **为什么七个角色行由插件 `ctx.loader.create()` 拥有，而不是 `cordis.patch.yml` 的 `insert`：**

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


## 1. 七个角色工具

| 工具名 | 职责 | 权限 |
|---|---|---|
| `executor` | 按简报执行改动 | 可写 |
| `code-reviewer` | 独立审查：只看简报与仓库实际改动，不看执行者自述 | 只读 |
| `researcher` | 只读调研：本地代码库、互联网、GitHub | 只读 |
| `advisor-A` / `advisor-B` / `advisor-C` | 圆桌三席：只给判断与理由，不写代码（三席共用 `content/roles/advisor.md` 一份 persona，面板上各配一个厂商） | 只读 |
| `vision-reader` | 识图：只返回客观描述，不做分析建议 | 只读 |

- 工具名与 ZCode 侧完全一致，同一份规则文本在两个 harness 上指同一角色。
- **advisor 一份源拆三席**：`content/manifest.json` 的 `dsh.seats` 驱动 `build.mjs` 展开成三条 loader 行，因此两侧部署后都是 7 个。
- **权限由 DSH 的工具注册表强制**：只读角色在**子会话作用域**调用 `ctx.tools.restrict({ deny })`
  摘掉写操作工具（DSH 0.2.1 起 `dsh-tool-subagent` 不再接受 `toolFilter`，见「版本」），
  不是写在提示词里求模型自觉。
- 每个角色的 persona 与默认模型通过插件配置项暴露（见下文「配置」）。persona 正文同样在
  **子会话作用域**覆盖 `deployment:persona-prefix` 段（行配置里已无人设字段）。
- 子智能体继承父会话预设，因此 `maxDepth: 1` 关掉递归：角色子智能体不能再往下派。

`restrict()` 的工具名必须是子会话可见的真实名字，未知名字会整单抛错。名单在 `build.mjs` 的
`MUTATING_TOOLS` 里，按本机 DSH 实测的已知工具表确定（0.2.0 的 base 层把 `ralph` 标成
`disabled: true`，留着它会让每次只读角色委派都抛错，故已移除；不含 Windows 上被 `disabled`
的 `bash`）。0.7.0 起插件先按子会话可见性过滤名单；过滤后仍有缺口就退化为执行期
`tools.guard()`（名单里的工具照样调不动，只是不再从 schema 里藏掉），不会再因为名单漂移
让只读角色静默变成可写。

## 2. 协作纪律系统提示段

正文单一来源：`content/collab-rules.md`，构建时内联成 `lib/generated-content.js` 的 `RULES_TEXT`，由插件注册为一个系统提示段（默认名 `collab-mode:rules`，排序位 400 —— 在 persona 之后、PLAN_POLICY 之前）。用户全局 `~/.dsh/AGENTS.md` 自 2026-09-13 起只放指针与环境说明，**不存规则正文**——2026-09-10 遗留的手抄副本曾与规则段双源打架（圆桌指向 DSH 不存在的工具），已退役为指针；谁往里回填规则，谁就造出下一份漂移副本。

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

角色行（`collab-executor` / `collab-code-reviewer` / `collab-researcher` / `collab-advisor-A` / `collab-advisor-B` / `collab-advisor-C` / `collab-vision-reader`）只暴露 `provider`（`collab-spawn-<角色>`，插件自动注册的专属 spawn provider）、`toolName`、`maxDepth`、`agentOptions{provider,model}`。**人设与只读限制不再写在行配置里**：DSH 0.2.1 的 `dsh-tool-subagent` 删除了 `persona` / `toolFilter`（带这两个字段会让角色行加载失败），插件改为在子会话作用域自动装配（同名 `deployment:persona-prefix` 段 + `tools.restrict()`）。默认不写 `agentOptions`，即子智能体继承父会话的模型路由；要分角色指定模型时：

```yaml
- id: collab-researcher
  config:
    provider: collab-spawn-researcher
    toolName: researcher
    maxDepth: 1
    agentOptions:
      provider: <供应商>
      model: <模型 id>
```

每个角色行还对应一条 `collab-provider-<角色>` 行（`@deepseek-ai/dsh-subagent-spawn-in-process`，`providerName: collab-spawn-<角色>`），由插件自动创建，不要手改。方向是让 `subagent/start` 的 `provider` 字段成为可靠的「子会话 → 角色」标识 —— 0.2.1 的角色工具是 parallel-safe，不能靠调用顺序认领。

配置不合法会在 mount 时抛错，不回退默认值 —— 静默降级比启动失败更难查。

## 单一来源与构建

```
content/manifest.json     ── 角色清单 + 平台差异（唯一事实源）
content/collab-rules.md   ─┐
content/roles/*.md        ─┴─ node build.mjs ─┬─ lib/generated-content.js （提示段正文 + 七角色的 persona/deny 名单）
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

⚠ 七个角色行**不在** `cordis.patch.yml` 里（v0.2.0 起由插件用 `ctx.loader.create()` 拥有，
原因见上文「角色路由怎么真正下发」）。因此 `dsh --profile web --dump-config` 只能看到
`collab-mode` 一行 —— 角色行的存在性要看自检区（C 区块）或
`GET /api/collab-mode/selfcheck` 的 `roles[].entryPresent / active`。

## opencode free 端点回传剥除（v0.5.0）

DSH 走 zen 渠道（openai-responses 协议）的 free 模型，在多轮 agent 会话里报
`reasoning encrypted_content was not issued to this caller`。已实锤的机制：pi-ai 发推理档位
必带 `include:["reasoning.encrypted_content"]`，响应里的加密推理块经 replay 状态在下一轮
原样回传，而上游对回传的加密内容做 caller 校验 —— 真正的坑就是「回传了加密内容」本身
（实测：换新 UUID 回传旧加密内容仍 200，说明上游不认 `x-opencode-session` 的值），
上游重排路由/池子时必炸。短会话测不出，长 agent 会话必现。

修法：插件给宿主进程的 `globalThis.fetch` 装窄包装，两个动作，**仅 opencode.ai 域**：

- **动作 A（主修法）剥除加密回传**：只打 free 端点（POST + 路径含 `/zen/v1/` + JSON body），
  从 `input` 数组剔除所有 `type === "reasoning"` 的项再转发（上游接受剥除后的历史，回答正确）。
- **动作 B（辅修法）会话头镜像**：把 pi-ai 每次请求自带的 `x-client-request-id`（= DSH 会话 id）
  覆盖写进 `x-opencode-session`（覆盖 profile 里写死的静态旧值正是目的）；没有该头的请求
  （如模型目录发现）用进程级懒生成一次的 UUID v4。付费 `go` 端点同样镜像（语义与 ZCode 一致、无害）。

其他域名零接触（连 body 都不 parse）。fiber 停止时自动拆掉，重复安装不叠层；
解析失败/不命中一律原样透传（fail-open），绝不报错。
自检 JSON 带 `opencodeFreeRelay: true/false`（C 区块不加 UI）。

## 已知边界

- **free 端点跨轮推理连续性被剥除**：动作 A 剔掉回传的加密推理块，模型从**可见历史**重新推理，
  拿不到上一轮的原生推理链。这是修 caller 校验崩溃的代价，只影响 free 端点（`/zen/v1/`）；
  付费 go 通道（`/zen/go/v1/`）body 逐字节不动，推理连续性完整保留。
  若上游未来对剥除后的请求改变行为（例如拒绝缺 reasoning 项的历史），**回退 = 卸载包装**：
  删掉 `apply()` 末尾的 `installOpencodeFreeRelay()` 调用（或让 `ctx.effect` 的 dispose 跑一次），
  fetch 即还原为原实现，无需改其他文件。
- **只读名单依赖工具名**：`restrict()` 遇到子会话可见面里没有的名字会整单拒绝；插件会先按子会话 scope 过滤，名单有缺口时退化为执行期 `guard()`（工具调不动，但不再从 schema 里藏掉），并打一行 warning。
- **`subagent` 无法被只读过滤器摘掉**：0.2.1 的预设把 `tool-subagent` 配成 `modelSelectionSettings: true`，该工具会注册进**每个 agent 自己的层**；而 `@deepseek-ai/dsh-tools` 的 `restrict()` 只认继承来的名字（global + 祖先层），明确拒绝 scope-local 名字。所以它不在 `deny` 名单里。
  影响面：只读角色自己确实没有写工具，但它仍能用 `subagent` 往下再派一层；`maxDepth: 1` 与宿主默认 `maxDepth`（默认 1）会在**角色工具的下一层**拒绝继续委派。若部署把宿主 `maxDepth` 调大，孙代是否继承角色作用域的只读限制**未在本机实测**——不要把角色子会话当安全边界。
- **状态是进程内的**：`seen` / `changed` 按 sessionId 存在内存里，进程重启或会话恢复后从空开始（与 `@deepseek-ai/dsh-repeat-tool-reminder` 的取舍一致）。审计日志是落盘的，可追。
- **改代码后无法在运行中的进程里热更新**：cordis 的 HMR（`root: []`）只监听补丁文件，不监听模块文件，且 loader 复用已解析包的 ESM 模块缓存。改完插件代码要重启 `dsh web` 才生效。
- **不含 `/roundtable` 命令**：任务书第 4 项标为「建议，可选」，本次未实现。多方意见靠同时调用 `advisor-A` / `advisor-B` / `advisor-C` 实现，规则文本已如此描述。
- **opencode free 端点修复只保证「不回传加密内容」+「每会话稳定身份」**：上游账号池重排/限流导致的偶发失败若仍出现，下一步在出口侧做请求级粘性，不在本插件（fetch 包装只管剥回传与定身份，不管重试与路由）。
- **不修改任何出厂预设**：插件走 profile bundle 层（Host 平面），与 agent preset 无关。

## 版本

当前 `0.8.1`，针对 DSH **`0.2.2-rc.3`** 开发与实测（`0.8.0`/`0.7.0` 分别针对 `0.2.2-rc.1`、`0.2.1-rc.2`，`0.6.0` 针对 `0.2.0-rc.2`，`0.5.1` 及以前针对 `0.1.x`）。

运行时依赖只有 `@deepseek-ai/schemastery`（`^3.18.4` —— `.volatile()` 需要 ≥ 3.18.2，缺了它设置页里不会出现本插件的可编辑项）；其余一律只用 `node:` 内置模块，因此 `link:` 安装下也能正常解析。

**0.8.x（DSH 0.2.2）不需要改代码**：逐项核对过本插件依赖的每一个接口，均未破坏 ——
`dsh-tool-subagent` 的 `provider` / `toolName` / `maxDepth` / `agentOptions`（它删掉的是本插件没用的 `modelSelectionSettings`，换成 `modelSelection` + `modelDiscovery`）、
`dsh-tools` 的 `restrict()` / `guard()` / `get(name, scope)`（`get` 现在多一个可选 `toolSet`，前两个参数不变；模块拆分成 `contracts.ts`）、
`systemPrompt.section({name,order,text})`、`webServer.register({kind,path,handler})`、
`connection.requestRejection(req)`、`subagent/start|end` 的 `{provider,id,stopReason}`、
`agent/created` / `agent/assistant-stream` / `agent/turn-stopping` / `agent.steer` / `settings/document-updated`、
`agents.get(sessionId)`（子会话作用域装配靠它取 Agent）、
客户端的 `configForms.{get,whileServed}` 与 `slots.{inject,register}` / `sidebarRightTabs`、
以及 `window.__ModuleLoader__.load({id,factory})` 客户端模块契约。

`0.2.2-rc.3` 相对 `0.2.2-rc.1` 唯一沾到插件的是升级指南 `v0.2.2-rc.1/subagent-interrupt-default`：
base 与 Web presets 现在把 `interrupt_agent` 默认关掉。本插件的只读 deny 名单里仍有它，但装配时会先按
`tools.get(name, agent)` 过滤可见性、对缺口再叠一层执行期 `guard`，所以少一个名字只会让该项被跳过，
**不会放宽只读限制**；将来把 `interrupt` 改回 `true` 时名单也依然正确，故不删除。

**0.8.1 修的两个小问题**（不改运行逻辑）：
① `engines.dsh` 之前嵌在 `dsh` 对象里，而 `evaluatePluginCompatibility()` 只读**顶层** `engines.dsh`
（见升级指南 `v0.2.1-alpha.3/plugin-engines-dsh`），等于声明从没生效、只是被 `peerDependencies` 兜住；
现已移到顶层并收紧为 `>=0.2.1-rc.1 <0.3.0-0`（`<0.3.0` 会放进未来的 `0.3.0-rc.1`，故用 `-0` 排除）。
② provider 行全部因同一原因失败时（典型：spawn 包没装），原来会刷 7 条一模一样的 warning，现已合并成一条并带角色数；
原因不同时仍逐行打印。

⚠ **装回 profile 时别忘了 `dsh.profile.bundles`**：插件在 `dependencies` 里、`cordis.patch.yml` 里也有 `- id: collab-mode`，但如果 `bundles` 数组里没有 `dsh-collab-mode`，**整个插件不会被加载** —— 表现为七个角色工具、审计日志、自检路由一起消失，而桌面端照常启动、不报错（因为那个 `- id:` 补丁找不到行时只会被跳过）。排查顺序：先看 `bundles`，再看版本兼容，最后才怀疑代码。

**0.7.0 是兼容性断点**：DSH 0.2.1 删除了 `dsh-tool-subagent` 的 `persona` / `toolFilter` / `backgroundMode`（带这些字段的角色行在加载时直接抛错，七个角色工具会**全部消失**），并把委派改成异步 activation（工具调用立即返回 `started subagent <id>`，完成由 `subagent/end` 通知）。本插件的对应改法：角色行只留 `provider` / `toolName` / `maxDepth` / `agentOptions`；人设改在子会话作用域注册同名 `deployment:persona-prefix` 段；只读限制改在子会话作用域调 `tools.restrict()`（名单里有本机不存在的工具时退化为 `tools.guard()`，仍保证调不动）；运行列表改由 `subagent/end` 收口。peer 范围收到 `^0.2.1-rc.1`。DSH `0.2.0-rc.2` 请用 `0.6.0`。

**0.6.0 的断点**（保留说明）：DSH 0.2.0 删除了客户端的 `settingsScope` 服务、`@deepseek-ai/dsh-client-runtime` 包与宿主的 `settings.installSection`，本插件跟着换成 `ctx.configForms` / 条目 Config 的 `.volatile()` 字段。老 DSH（`0.1.6` 及以前）请用 `0.5.1`。

⚠ **兼容性到底看哪个字段**：`dsh-app-boot` 的 `evaluatePluginCompatibility()` 会先看**顶层** `engines.dsh`；
一旦声明了它，范围**单独决定结果、peer 被忽略**。没有该字段时才回落到 peer 里
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的名字去比对运行时版本（**不看 `peerDependenciesMeta`**，
所以标了 `optional: true` 也照拦）。两条路径都用 `includePrerelease: true`，因此 `0.2.2-rc.3` 能落在
`^0.2.1-rc.1` 里。不兼容时的表现是该 bundle 层被**静默跳过**（记入 `skippedBundles` 并打一行 warning），
不是报错退出 —— 这正是「插件整体消失但桌面照常启动」的另一个来源。

`dsh.compatibility.dshReleases` 仍是**纯文档性声明**（没有代码消费），它只是记录「哪些版本实际验证过」。
