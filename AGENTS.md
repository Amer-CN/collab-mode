# AGENTS.md —— 本仓库的维护说明

> **给谁看**：接手本仓库的 AI 会话（新窗口没有上下文历史，先读这份）。
> **给用户看的部分**：安装与使用见 [README.md](./README.md)，本文件只讲"怎么改、怎么验、怎么发"。

## 0. 三十秒认识这个仓库

**一个项目，两种 Agent 适配，共用一份内容。**

| 目录 | 是什么 | 给谁 |
|---|---|---|
| `content/` | **唯一事实源**：协作纪律 + 五个角色提示词 + 平台差异清单 | 不直接安装，被两边消费 |
| `zcode-collab/` | ZCode Skill（部署脚本 + 四个 PowerShell 钩子 + 双钢人决策） | ZCode、Claude Code、Codex 等 |
| `dsh-collab-mode/` | DeepSeek Harness 插件（五角色工具 + 提示段 + 三个代码级钩子 + 设置面板） | DeepSeek Harness |

**核心约定：改规则只改 `content/`，两边都是生成物。**

```
                      content/collab-rules.md（带平台占位符）
                            │
              build.mjs ────┴──── sync_from_manifest.py
              （平台=dsh）              （平台=zcode）
                            │
  ┌─→ dsh-collab-mode/lib/generated-content.js 的 RULES_TEXT
  │
  ├─→ zcode-collab/references/global-agents.md
  │
  └── 占位符取值来自 content/manifest.json 的 rules.placeholders

content/roles/*.md    ─┬─→ generated-content.js 的 ROLES[].persona（build.mjs）
                       └─→ zcode-collab/references/agent-*.md（sync_from_manifest.py）
content/manifest.json ─── 角色清单 + 平台差异（工具名/只读性/ZCode frontmatter/占位符）
```

**为什么必须这样**：v0.3.0 之前两边靠手工同步，结果插件丢了 10 条规则（"不要 git commit""有立场禁止和稀泥""说真话"等）——因为插件那份是手写搬运的，不是生成的。v0.4.0 之前规则文本也是两份各自维护，结果 ZCode 侧的圆桌规则引用了不存在的角色名 `advisor`（实际叫 `advisor-A/B/C`），**圆桌调用不到任何东西**。**任何"手工改生成物"的行为都会重演这类事故。**

### 角色数为什么两边不一样（5 vs 7）

| | 数量 | 组成 | 为什么 |
|---|---|---|---|
| `content/roles/` | **5 份源** | executor / code-reviewer / researcher / advisor / vision-reader | 唯一事实源，advisor 只有一份 |
| **DSH 侧** | **5 个工具** | 同上（一个 `advisor`） | advisor 是**一个工具**，模型可在设置面板随时改；要三家意见就调三次并各自指定模型 |
| **ZCode 侧** | **7 个文件** | 同上 + **advisor-A / advisor-B / advisor-C 三席** | ZCode 子智能体是**静态文件**，想同时问三家就得配三份、各绑一个模型 |

**这是设计差异，不是缺陷**——不要给 DSH 加三席，也不要以为 ZCode 多了两个角色。
manifest 里 advisor 条目的 `zcode.seatNote` / `dsh.seatNote` 有同样说明。

**规则文本里凡提到顾问角色，一律用 `{{ADVISOR}}` / `{{ADVISOR_CALL}}` 占位符**，
渲染时按平台换成 `advisor` 或 `advisor-A/B/C`——否则会出现"规则引用一个不存在的角色名"
（v0.4.0 之前 ZCode 侧的圆桌规则就是这样，导致圆桌调用不到任何东西）。

---

## 1. 我要改规则（最常见）

> **本文件里的命令一律从仓库根出发、用相对路径**。仓库根 = 含 `AGENTS.md` 的那个目录
> （本机是 `F:\AIXM\collab-mode`，别人机器上是他的克隆路径）。
> 这样任何机器照抄都能跑。

### 先装依赖（新克隆第一次必做）

```powershell
cd dsh-collab-mode
npm install        # 装 @deepseek-ai/schemastery（lib/index.js 的运行依赖）
cd ..
```

没装依赖时夹具会明确提示（`夹具无法加载 lib/index.js：缺少依赖。先装再跑：npm install`），
不会抛裸的 MODULE_NOT_FOUND。

### 改协作纪律 / 角色提示词（六步）

**改规则文本时**：`content/collab-rules.md` 里两侧措辞不同的地方用占位符
（`{{ADVISOR}}` 等，见第 1 节"平台占位符"），不要只写一侧的角色名。

```powershell
# 0. 站在仓库根（含 AGENTS.md 的目录）

# 1. 改 content/ 下的文件 —— 只有这里是源
#    content/collab-rules.md   协作纪律
#    content/roles/*.md        五个角色正文
#    content/manifest.json     角色清单与平台差异

# 2. 同步 DSH 侧（插件目录里的 content/ 是构建时拷贝的副本，这一步负责刷新它）
cd dsh-collab-mode
node build.mjs
node scripts/check-drift.mjs      # 必须全绿
cd ..

# 3. 同步 ZCode 侧（生成 references/agent-*.md）
cd zcode-collab
python scripts/sync_from_manifest.py ..          # 先预览：传仓库根
python scripts/sync_from_manifest.py .. --write  # 确认无误再写
cd ..

# 4. 跑夹具（全绿）
cd dsh-collab-mode
node tests/verify-plugin.mjs
cd ..

# 5. 同步到本机 ZCode 生效（否则改了源，ZCode 里跑的还是旧提示词）
cd zcode-collab
python scripts/sync-agents.py ..          # 先预览
python scripts/sync-agents.py .. --write  # 只换正文，frontmatter（model/color）一字不动
cd ..
# 然后重启 ZCode 或新开会话——子智能体在会话启动时发现

# 6. 改了规则文本时，同步本机全局规则文件（同样不会自动生效）
#    把 zcode-collab/references/global-agents.md 的全文替换进 ~/.zcode/AGENTS.md 的规则段，
#    保留文件末尾的「维护入口」节，然后重启 ZCode。
```

⚠️ **第 5 步不能省**。`~/.zcode/agents/*.md` 是**部署产物**：仓库源改了它不会自动更新。
2026-09-13 实测发现五个角色 + advisor 三席**全部落后于源**，v0.3.0 回补的 10 条规则
从未在 ZCode 里生效——就是当时只同步了仓库、漏了这一步。

⚠️ **生成器传仓库根**（`..`，即含 `content/` 的目录）。若误传插件目录，脚本会打印
`[提示] 传入的是插件目录…已自动改用仓库根` 并纠正——但**顺序不能反**：必须先 `build.mjs`
再跑生成器，否则读到的是插件目录里的旧拷贝（防呆只纠路径，不会替你重新构建）。

### 改了插件代码时（额外一步）

DSH 的 `link:` 指向 `dsh-collab-mode`，它加载磁盘文件；但**模块代码不能热更新**
（实测三种热加载手段全失败），所以改 `lib/` 后必须**重启 `dsh web`**。

### 改角色清单（增删角色、改工具权限）

改 `content/manifest.json`：
- `roles[].key` / `roles[].file` / `roles[].dsh.toolName` / `roles[].dsh.readonly` — DSH 侧用
- `roles[].zcode.description` / `.color` / `.tools` / `.injectAgentsMd` — ZCode 侧用
- `roles[].zcode.toolsNote` / `.nameNote` — frontmatter 里的注释（条件信息，别丢）

改完跑第 1 节的步骤。`check-drift.mjs` 会校验**四处角色数相等**（manifest / content/roles/*.md / 生成物 ROLES / 面板 ROLE_ROWS），少一处就报错。

### 平台占位符（v0.4.0，规则文本的两侧差异怎么表达）

`content/collab-rules.md` 是**一份源渲染两个平台**。两边措辞不同时不用改代码，用两种占位符：

1. **行内替换** `{{NAME}}` —— 取值放 `content/manifest.json` 的 `rules.placeholders`：
   ```json
   "placeholders": {
     "ADVISOR": { "dsh": "`advisor`", "zcode": "`advisor-A` / `advisor-B` / `advisor-C`" }
   }
   ```
2. **平台块** `{{#zcode}}…{{/zcode}}` —— 只有该平台才保留的内容（如引用 `decision-full.md`，
   那是 ZCode 独有的文件）；另一平台渲染时整块删除。

**铁律**：占位符的**取值**只放 manifest，渲染代码里不写死任何角色名或文案；
新增占位符必须 dsh、zcode 两侧都有取值（缺一 check-drift 会 FAIL）；
源里的平台块标记必须成对。改完照第 1 节流程跑，`check-drift` 会校验全部约定。

---

## 2. 我要改插件功能（DSH 侧代码）

| 文件 | 职责 | 注意 |
|---|---|---|
| `dsh-collab-mode/lib/index.js` | 宿主半侧：提示段、三个钩子、settings 命名空间、自检路由 | **不是生成物**，直接改 |
| `dsh-collab-mode/lib/client.js` | 浏览器半侧：设置面板卡片 | **不是生成物**，直接改 |
| `dsh-collab-mode/build.mjs` | 构建脚本 | 改它要同步改 `check-drift.mjs` 的断言 |
| `lib/generated-content.js`、`cordis.patch.yml` | **生成物，禁止手改** | 手改会在下次构建被覆盖 |

### 改完必须验的三件套

```powershell
cd dsh-collab-mode                  # 从仓库根出发
node build.mjs                    # 生成物
node scripts/check-drift.mjs      # 全绿：内容一致性
node tests/verify-plugin.mjs      # 全绿：行为（钩子/工具/面板/安全栅栏）
```

### 活体验证（改客户端或面板必做）

**模块代码无法热更新**——实测三种热加载手段全失败（改 package.json 入口、复制新文件、改 loader entry id）。改完 `lib/` 下的文件**必须重启 `dsh web`**。

重启后：
1. 设置 → 插件 → 插件配置 →「协作模式」卡片应可编辑（**不是红色降级提示**）
2. 面板改 executor 路由 → 保存 → C 区块「实际生效路由」应跟着变
3. 委派一次 executor，用 `llm/stream` 探针抓**真实** provider/model（子智能体自报不可信，实测它回答 `provider=deepseek / model=unknown`）

---

## 3. 我要改 skill 功能（ZCode 侧）

| 路径 | 是什么 | 注意 |
|---|---|---|
| `zcode-collab/SKILL.md` | 部署 6 步 + 日常答疑 + 双钢人决策 | 直接改 |
| `zcode-collab/hooks/*.ps1` | 四个 PowerShell 钩子 | 直接改；**改完要复制到 `~/.zcode/cli/hooks/`** |
| `zcode-collab/references/agent-*.md` | **生成物**（由 `content/roles/*.md` 生成） | 手改会被下次生成覆盖 |
| `zcode-collab/references/global-agents.md` | **生成物**（由 `content/collab-rules.md` 按 `zcode` 平台渲染） | 要改规则去改 `content/collab-rules.md`，手改此文件会被覆盖 |
| `zcode-collab/references/decision-full.md` | 双钢人完整版 12 段模板（**ZCode 独有**，故不是生成物） | 直接改 |
| `zcode-collab/scripts/version_check.py` | 版本自检 | 改仓库地址时**必须**同步 `REPO_URL` 与 `RAW_URL` |
| `zcode-collab/scripts/sync_from_manifest.py` | 生成器（产出 `agent-*.md` + `global-agents.md` + `VERSION`） | 见第 1 节 |
| `zcode-collab/scripts/sync-agents.py` | 把渲染好的 `agent-*.md` 推到本机 `~/.zcode/agents/` | 只换正文，保留各文件 `model:`/`color:` |

⚠️ **`~/.zcode/` 是用户配置树，不是仓库**。改仓库里的钩子后，用户本机不生效——要在 README 或部署步骤里说明"重新复制到 `~/.zcode/cli/hooks/`"。

---

## 4. 版本号怎么升

| 位置 | 谁对齐谁 |
|---|---|
| `content/manifest.json` 的 `version` | **源头** |
| `zcode-collab/VERSION` | 由 `sync_from_manifest.py` 自动同步 |
| `dsh-collab-mode/package.json` 的 `version` | **手工改**（插件版本，与 manifest 可不同步——插件有独立的功能迭代） |

**实践**：内容变更 → 升 manifest version（ZCode 侧跟涨）；纯插件功能变更 → 只升 package.json。

---

## 5. 目录归属（**先读这条，否则会改错地方**）

**项目根 = git 仓库根 = `F:\AIXM\collab-mode`**（远端 `Amer-CN/collab-mode`）。
仓库根含 `AGENTS.md`，所有改动都在这里提交。

```
F:\AIXM\collab-mode\          ← git 仓库根（唯一）
├── content/                  ← ★ 唯一事实源（规则 + 五角色 + manifest）
├── zcode-collab/             ← ZCode 侧 Skill
├── dsh-collab-mode/          ← DeepSeek Harness 侧插件（DSH 的 link 指向这里）
├── AGENTS.md                 ← 本文件
└── README.md                 ← 双适配安装入口
```

**只有一个插件目录**（`dsh-collab-mode/`），**只有一个 git 仓库**（项目根）。
`dsh-collab-mode/content/` 是 `build.mjs` 从仓库根 `content/` 拷贝出来的构建产物，
已在 `.gitignore` 里——**不要在插件目录里改 content**。

⚠️ **改完插件代码要重启 `dsh web`**：DSH 的 `link:` 指向 `dsh-collab-mode`，
它加载磁盘上的文件；但模块代码不能热更新（实测三种热加载手段全失败），
所以改 `lib/` 后必须重启才生效。

（2026-09-13 结构调整记录：此前 `zcode-collab-publish/` 是仓库根、插件被复制成两份，
造成"改了一边另一边不生效"的分叉风险。现已把仓库根上移到项目根，插件只留一份，
DSH 的 link 路径不变。）

## 6. 发布

```powershell
# 站在仓库根（唯一 git 仓库，含 .git）
git add -A
git commit -m "..."
git push origin main
```

**给用户的更新**：`version_check.py` 会读 GitHub raw 的 VERSION 比对，用户侧看到 `behind` 提示。所以**发布时必须让 `VERSION` 与 manifest 一致**，否则用户永远看到"有新版本"。

**改了规则内容时**，别忘了 ZCode 侧用户要重新部署才生效：钩子在 `~/.zcode/cli/hooks/`、
子智能体在 `~/.zcode/agents/`、规则在 `~/.zcode/AGENTS.md`——这些都在用户机器上，
仓库里的改动不会自动同步过去（用户按 README 重新走一遍部署，或手工覆盖对应文件）。

---

## 7. 已知边界与坑（都是实测踩过的）

| 坑 | 说明 |
|---|---|
| `subagent` 工具不可被 `toolFilter` 限制 | DSH 预设把它注册进每个 agent 自己的层，而 `restrict()` 只认继承层名字。放进 deny 名单会让每次委派抛错。后果：只读角色的**孙代**不受只读约束 |
| 模块代码不能热更新 | 改 `lib/` 必须重启 `dsh web` |
| `tools/pre-execute` 不能改写参数 | DSH 有意为之。所以"面板改路由"必须走 `loader.update` 改角色行，不能拦截改写 |
| `loader.update` 对补丁插入的行会回写合成树 | 会压平 bundle/profile/home 三层补丁。所以五个角色行由插件用 `ctx.loader.create()` 自己拥有（挂在 Loader root group，`write()` 是空实现） |
| 客户端 `inject` 必须声明 `settingsScope` | 用 `ctx.get()` 一次性读取会在服务晚到时永久降级（v0.2.0 的真实缺陷） |
| 自检路由必须走认证栅栏 | `webServer.match()` 是 exact 优先，`/api/xxx` exact 路由会**绕过** `/api` prefix 上的认证。必须调 `connection.requestRejection(req)` |
| `~/.zcode` 配置树在钩子里豁免 | 改协作系统自身的配置不被计数（v1.1.4 起）。代价：治理工具自身改动无机器门禁 |
| 夹具与真实运行时有差异 | 离线夹具的 `inject` 是同步回调，掩盖了真实 Cordis 的异步依赖语义。**依赖注入时机的行为，夹具验不出来，必须活体验证** |

---

## 8. 验收清单（改动后照做）

站在仓库根，逐条：

```
[ ] cd dsh-collab-mode && npm install（首次） && cd ..
[ ] cd dsh-collab-mode && node build.mjs && node scripts/check-drift.mjs    全绿
[ ] cd dsh-collab-mode && node tests/verify-plugin.mjs                      全绿
[ ] cd zcode-collab && python scripts/sync_from_manifest.py ..              0 差异（或已 --write）
[ ] cd zcode-collab && python scripts/sync-agents.py .. --write             同步到本机 agents（漏了则 ZCode 不生效）
[ ] 改了 lib/ → 重启 dsh web → 设置→插件→插件配置 里「协作模式」可编辑 + 面板改路由后生效
[ ] 改了 hooks/ → 复制到 ~/.zcode/cli/hooks/（本机用户才需要）
[ ] 改了规则文本 → 更新本机 ~/.zcode/AGENTS.md 规则段（保留维护入口节）→ 重启 ZCode
[ ] 改了 zcode-collab/（SKILL.md / scripts / references）→ 复制覆盖本机 ~/.zcode/skills/zcode-collab/ → 重启 ZCode
[ ] 内容变更 → content/manifest.json 的 version 已升（VERSION 由生成器跟涨）
[ ] git add -A && git commit && git push origin main
```

---

## 9. 这个仓库的历史教训（别重蹈）

1. **手工同步两份文本必丢规则**——v0.3.0 回补了插件丢失的 10 条规则。→ 所以有 `content/` 单一来源。
2. **夹具通过 ≠ 真实可用**——v0.2.0 的 61 项断言全绿，但面板在真实浏览器里是空壳（`inject` 缺声明）。→ 所以活体验证不可省。
3. **验证方法本身可能是错的**——曾用字符串匹配检测"规则漂移"，把"改写了措辞"全判成"丢失"（报 55 条，实际 10 条）；也曾因 JSON 转义误报 2 条规则缺失。→ 所以验证要先解析再判定，别直接 grep 转义内容。
4. **统计方法要正确**——档位实测曾因内联的 p 值公式有 bug（恒返回 1.0000）差点得出错误结论。→ 统计脚本单独写、单独验。
5. **规则文本两份各自维护必出事**——v0.4.0 之前 `collab-rules.md`（DSH）与 `global-agents.md`（ZCode）各写各的，ZCode 侧圆桌规则引用了不存在的角色名 `advisor`，圆桌调用不到任何东西。→ 所以规则文本也进单一来源（平台占位符），check-drift 有回归断言。
6. **改了源不等于生效**——`~/.zcode/agents/*.md` 是部署产物，2026-09-13 实测五个角色全部落后于源，v0.3.0 回补的 10 条规则从未在 ZCode 里跑过。→ 所以有第 5 步 `sync-agents.py`。

---

## 10. 改完怎么确认没漏（推荐动作）

**派一个零上下文子智能体，只给它一句模糊的任务，看它能不能自己找到维护路径。**

```text
（新开一个会话或派 researcher 子智能体）
任务：「帮我改一下协作模式里 advisor 角色的规则，让它回答更简短些。」
要求：只做调研，不要修改任何文件。回答：
  1. 源文件在哪个目录？
  2. 哪些地方不该改？为什么？
  3. 改完要跑哪些命令？
  4. 有什么坑必须知道？
```

**判据**：它能否独立说出「改 `content/`」「不要改生成物和 `~/.zcode/agents/`」
「跑 build + 两个生成器 + sync-agents」「改完重启」。说得出 = 入口有效；说不出 = 入口有洞。

**为什么值得做**：2026-09-13 用这个方法实测，挖出了"本机 agents 落后于源"这个
反复几轮都没发现的漏洞。**文档是给 AI 看的，只有让 AI 自己走一遍才算验证。**

⚠️ 注意：派子智能体做这个测试时，它可能**真的去改文件**——prompt 里必须写明
"只做调研，不要修改任何文件"。
