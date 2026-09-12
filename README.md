<p align="center"><img src="https://capsule-render.vercel.app/api?type=waving&color=0:1F4E79,100:0D2137&height=170&section=header&text=collab-mode&fontSize=64&fontColor=ffffff&animation=fadeIn" width="100%"></p>

<div align="center">

#### 协作模式：一套规则，两种 Agent 适配

**ZCode 装 Skill · DeepSeek Harness 装插件 · 内容同源，AI 自动识别**

[![Version](https://img.shields.io/badge/Version-v1.2.0-1F4E79?style=for-the-badge)](#-版本历史)
[![Subagents](https://img.shields.io/badge/子智能体-7个-3B82F6?style=for-the-badge)](#-能力矩阵)
[![License](https://img.shields.io/badge/License-MIT-10B981?style=for-the-badge)](./zcode-collab/LICENSE)
[![AgentSkills](https://img.shields.io/badge/AgentSkills-Standard-8B5CF6?style=for-the-badge)](https://agentskills.io)

</div>

---

## 🤖 一条提示词，AI 自己选对的装法

**不用管你的 AI 是哪种。** 把下面这段话连同仓库链接一起发给它：

> 帮我安装协作模式：https://github.com/Amer-CN/collab-mode
>
> 请先判断你自己是什么 Agent，只装对应那一种，不要两个都装：
> - 如果你运行在 **ZCode** 上（或支持 Agent Skills 标准的工具）→ 按 README「ZCode 侧」章节安装 Skill
> - 如果你运行在 **DeepSeek Harness** 上 → 按 README「DeepSeek Harness 侧」章节安装插件
>
> 装完按该章节的校验步骤自检，并告诉我校验结果。

AI 一定知道自己跑在什么环境里，所以不会选错。

## 📦 这个仓库里有什么

| 目录 | 给谁用 | 装法 |
|---|---|---|
| `zcode-collab/` | ZCode（及 Claude Code、Codex 等 Agent Skills 工具） | 复制到 `~/.zcode/skills/` 后按 SKILL.md 部署 |
| `dsh-collab-mode/` | DeepSeek Harness | `dsh plugin --profile web add <仓库地址>` |
| `content/` | **两边共用的唯一事实源** | 不用装；规则改动只改这里，两边重新构建即同步 |

**为什么共用一份内容**：五个角色的提示词和协作纪律是同一套东西，只是两边的机制不同（ZCode 用 Skill + hooks，DSH 用插件 + 代码级事件）。内容放一处，避免"改了一边忘了另一边"——这个坑我们踩过：插件曾丢过 10 条规则。

---

## 🔷 ZCode 侧：装 Skill

### 小白三分钟上手

**你不需要会编程。** 只需要一个支持 Agent Skills 的 AI 工具（ZCode、Claude Code、Codex 等 40+ 都行）。

**第一步：装。** 把这句话发给你的 AI：

> 帮我安装这个 skill：https://github.com/Amer-CN/collab-mode

**第二步：等 AI 干完。** 它会自动：备份老配置 → 读你本机有哪些模型 → 统一填一个能用的 → 写规则文件和 7 个子智能体 → 读回校验 → 告诉你怎么换模型。

**第三步：重启生效。** 重启 ZCode（或新开会话），说人话就能用：

> 帮我看看这个项目的 README 写了什么

就完了。不需要懂原理，不需要碰设置界面，不需要选模型。

详细部署步骤见 [`zcode-collab/SKILL.md`](./zcode-collab/SKILL.md)。

---

## 🟦 DeepSeek Harness 侧：装插件

### 装法

```powershell
dsh plugin --profile web add https://github.com/Amer-CN/collab-mode
```

本地开发时用 link 安装：`dsh plugin --profile web add link:F:/AIXM/collab-mode/dsh-collab-mode`

装完**必须重启 `dsh web`**——模块代码无法热更新（实测三种热加载手段全部失败）。

### 它给 DSH 带来什么

| 能力 | 说明 |
|---|---|
| 🔨 **五个角色工具** | `executor`（可写）/ `code-reviewer` / `researcher` / `advisor` / `vision-reader`（只读），名字与 ZCode 侧完全一致 |
| 📋 **协作纪律提示段** | 与 ZCode 侧同一份规则文本，注入系统提示 |
| 🚧 **改动前拦截** | 本会话改动 ≥3 个无简报声明的生产文件 → 拒绝该次写操作并列出文件名 |
| 📝 **工具调用审计** | 每次调用追加一行 JSON（时间/工具/目标/成功/耗时）到 `~/.dsh/hooks/` |
| ⚠️ **轮次结束告警** | 有未声明改动 → 告警并列出文件名；无 → 静默 |
| ⚙️ **设置面板** | 设置 → 插件 → 插件配置 →「协作模式」：按角色指定模型与推理强度、三个开关、运行时自检 |

### 校验装对没有

```powershell
# 组合树里有 collab-mode 行
dsh --profile web --dump-config | Select-String collab-mode

# 离线自检（插件仓库目录内）
cd dsh-collab-mode; node build.mjs; node scripts/check-drift.mjs
```

重启后在「设置 → 插件 → 插件配置」应看到「协作模式」卡片且可编辑；「插件列表」页应显示 `collab-mode` 已启用/运行中。

---

## ✨ 能力矩阵

| 能力 | 说明 | 对应文件 |
|------|------|----------|
| 🧭 **模式判断** | A 外部方案 / B 完整四步 / C 直接答疑 / D 小改直做，自动分类 | content/ + zcode-collab/references/global-agents.md |
| 📋 **简报制度** | 基线哈希 + 允许/禁止文件 + 可验证验收标准，跑砸随时回滚 | 同上 |
| 🔨 **executor** | 施工队：照简报干活，禁顺手镀金，不做设计不审查 | content/roles/executor.md |
| 🔍 **code-reviewer** | 监理：只认仓库实际改动，只判"够不够"，驳回须证据 | content/roles/code-reviewer.md |
| 📚 **researcher** | 只读调研：本地代码库 + 互联网 + GitHub（有 MCP 就带） | content/roles/researcher.md |
| 👁️ **vision-reader** | 识图员：主模型不支持看图时给它当眼睛（可选） | content/roles/vision-reader.md |
| 🗣️ **advisor** | 独立顾问：只给判断和理由，禁止和稀泥（ZCode 侧三席圆桌） | content/roles/advisor.md |
| ⚖️ **双钢人决策** | "该不该做/选哪个"先走简版论证（crux + 反转条件 + 承诺窗口，≤300 字） | zcode-collab/SKILL.md + references/decision-full.md |

## 🚀 它怎么工作

```
你说需求 ── 主模型判断 A/B/C/D 模式
   │
   ├─ B 完整流程：出方案（3 行白话）→ 写简报（基线+范围+验收）
   │              → executor 施工 → code-reviewer 查仓库实际改动
   │              → 主模型裁决（驳回最多 2 轮）
   ├─ A 现成方案：跳过规划，执行完提交推送，审查交给给你方案的 AI
   ├─ C/D 讨论、小改：主模型直接做
   └─ 决策类问题：双钢人简版（≤300 字：crux/反转条件/承诺窗口）
```

**命脉只有一条**：干活的模型不参与验收，验收的模型和它不同厂商——
盲区不重合，错误互相抓住。其余所有搭配都随你。

## 📦 安装方式

### 方式一：Agent Skills 环境（ZCode / C​laude Code / C​odex）

```bash
git clone https://github.com/Amer-CN/collab-mode.git
# 复制到你的技能目录：
cp -r collab-mode/zcode-collab/ ~/.agents/skills/zcode-collab/
# 或 C​laude Code: ~/.claude/skills/
```

然后对你的 AI 说：**「用 zcode-collab Skill，把多模型协作模式给我装上。」**
装完重启 ZCode（或新开会话）即生效。

### 方式二：任意 LLM 作为系统知识

把 `zcode-collab/SKILL.md` + `references/global-agents.md` 全文塞进 system
prompt，agent 提示词按需取用。

### 方式三：DeepSeek Harness（装插件，不是 Skill）

见上方「DeepSeek Harness 侧」章节。

## 🗂️ 仓库结构

<details>
<summary><b>目录树</b>（点击展开）</summary>

```
collab-mode/
├── README.md                     # 本文件：双适配入口 + AI 自识别安装提示词
├── content/                      # ★ 唯一事实源：两边共用的规则与角色提示词
│   ├── manifest.json             #   角色清单 + 平台差异（工具名/只读性/ZCode frontmatter）
│   ├── collab-rules.md           #   协作纪律全文
│   └── roles/*.md                #   五个角色正文
├── zcode-collab/                 # ZCode 侧 Skill
│   ├── SKILL.md                  #   AI 自助安装 6 步 + 日常答疑 + 双钢人决策
│   ├── VERSION                   #   版本号（与 content/manifest.json 对齐）
│   ├── LICENSE                   #   MIT
│   ├── hooks/                    #   四个 PowerShell 钩子
│   ├── references/               #   agent-*.md（由 content/ 生成）+ global-agents.md
│   └── scripts/                  #   version_check.py + sync_from_manifest.py（生成器）
└── dsh-collab-mode/              # DeepSeek Harness 侧插件
    ├── package.json
    ├── build.mjs                 #   构建时从 ../content 拷贝并生成产物
    ├── lib/                      #   index.js（宿主）+ client.js（面板）+ 生成物
    ├── scripts/check-drift.mjs   #   防漂移自检（角色数三处必须相等）
    └── cordis.patch.yml          #   生成物
```

**改规则的唯一入口是 `content/`**：改完跑 `dsh-collab-mode/build.mjs` 同步 DSH 侧，
跑 `zcode-collab/scripts/sync_from_manifest.py` 同步 ZCode 侧。两边产物都是生成物，禁止手改。

</details>

## ⚙️ 模型怎么配（你说了算）

安装时 AI 只做一件事：从你本机**确认可用**的模型里选一个，7 个岗位统一填上。
之后怎么分，是你的自由——只有两条经验建议（不是规矩）：

| 建议 | 原因 |
|------|------|
| 审查者别和执行者用同一个模型 | 同一份权重自审，盲区 100% 重合，等于没审 |
| 圆桌三家（advisor-A/B/C）分属不同厂商 | 配成同一家，圆桌变复读机 |

除此之外：想让审查用旗舰、执行用便宜货——随你；想全用最贵的——也随你。
换模型就是设置界面里点一下下拉框，新会话生效。

## 📜 版本历史

<details>
<summary><b>当前 v1.2.0</b>（2026-09-12）· v1.0.0 → v1.2.0 完整明细点击展开</summary>

| 版本 | 内容 |
|------|------|
| **v1.2.0（2026-09-12）** | **双适配 + 单一内容源**：① 新增 DeepSeek Harness 插件 `dsh-collab-mode`（五个角色工具 + 协作纪律提示段 + 三个代码级钩子 + 设置面板），与 ZCode Skill 共用同一套规则内容；② `content/` 提为**唯一事实源**（manifest.json 描述角色与平台差异），ZCode 侧 agent-*.md 由 `sync_from_manifest.py` 生成，DSH 侧由 `build.mjs` 生成——此前两边手工同步曾导致插件丢失 10 条规则（"不要 git commit""有立场禁止和稀泥"等），已全部回补；③ 仓库由 `zcode-collab` 改名为 `collab-mode`，一个仓库同时服务两种 Agent，README 提供 AI 自识别安装提示词 |
| v1.1.6（2026-09-11） | **非 ASCII 路径乱码修复**（v1.1.5 加的诊断串首次真实调用即定位）：`enforce-flow.ps1` 与 `session-start-enforce.ps1` 用 `[Console]::In.ReadToEnd()` 以文本模式读 stdin，会按控制台代码页（中文 Windows 为 GBK）解码，而 ZCode 管送的是 UTF-8 —— 中文目录名（如 `E:\测试`、`F:\...	okens速度显示`）被解成乱码。后果：① 简报查找从乱码路径出发 → `briefs=0` → 已登记文件也被判未申报 → 误拦；② 状态键由乱码路径算出 → 记到影子项目下 → 用正确路径永远反算不出（此前离线穷举无解的真正原因，已用 sha256 精确复现验证）。修法：与 post-tool-audit/stop-enforce 统一为「按原始字节读 + UTF-8 解码」。附带清理 33 个乱码键孤儿状态文件（多数属 `E:\测试` —— 即该项目全部会话都在被误拦）。回归：中文路径 4 项 + ASCII 6 项全过 |
| v1.1.5（2026-09-11） | enforce-flow「真实调用与手动运行结果不一致」修复：① **拦截文案附诊断串** `[cwd=… sid=… key=state-….json briefs=N]`（此前无法从外部反推钩子实际使用的 projectDir 与 state-key，排障只能靠猜）；② **字段拼写容错**——sessionId / session_id 两种拼写都接受（若真实载荷是 camelCase 而钩子只读 snake_case，同一载荷会落到不同 state-key，正是「真实=拦、手动=放」的成因）；cwd / project_dir / projectDir 同理，且缺 cwd 时回退到目标文件所在目录；③ **规范化统一**——路径统一 `GetFullPath`→反斜杠→去尾斜杠→小写，state-key 与简报查找共用同一函数；④ **双树简报查找**——被改文件可能在会话项目之外（如用户级插件目录），项目树与目标文件树两处都找简报（并集）。另：post-tool-audit 耗时字段容错（durationMs/duration_ms/duration/elapsedMs）。12 项回归全过 |
| v1.1.4（2026-09-10） | 计数范围同源：`~/.zcode` 配置树在 stop-enforce 中也豁免（与 enforce-flow 一致）——协作系统自身的规则/子智能体/钩子改动不再被误计为「项目生产文件」。**代价已注明**：治理工具自身的改动不设机器门禁，依靠简报与审查纪律。两钩子的排除清单至此完全一致 |
| v1.1.3（2026-09-10） | enforce-flow（PreToolUse）三处同族缺陷修复，口径与 stop-enforce 统一：① 简报识别扩为 current-task.md + 全部 task-*.md（原先只有 current-task.md 能重置，按 AGENTS.md 规定的 task-<关键词>.md 命名反而永远重置不了、第 3 个文件必拦，还会逼模型覆盖 canonical 简报槽位造成数据丢失）；② 计数排除 .git/（提交信息临时文件不再误计）；③ 门禁判定从「写过简报＝整会话永久豁免」改为**逐文件覆盖判定**——未申报文件累计 3 个即拦、拦时列名，把文件补进简报后立即放行（自愈），消除「一次重置＝永久放行」。24 项回归全过 |
| v1.1.2（2026-09-10） | 钩子三处设计修正（跨窗口实战反馈）：① 计数排除一次性诊断目录（~/.zcode/tmp、系统 TEMP、node_modules/__pycache__ 等构建目录）——`~/.zcode/tmp` 下的一次性脚本不再被误计为生产文件；② 拦截文案列出**未申报的具体文件名**（Undeclared: a.cs, b.cs …），不再只给一个数字；③ 引入**真实派发信号**——post-tool-audit 记录 Agent 调用的 subagent_type，stop-enforce 见到 executor/code-reviewer 实际派发即放行（不再仅靠简报声明）；路径分隔符正反斜杠均已兼容 |
| v1.1.1（2026-09-09） | 钩子修复（并发会话实战暴露）：stop-enforce 简报识别从「只认 current-task.md」扩为「current-task.md + 全部 task-*.md，取并集覆盖」——修复「按钩子指示用 task-关键词.md 命名反而永远过不了校验」；文件计数排除 `.git/` 内部文件（提交信息临时文件不再误计为生产文件）。五轮回归通过（受影响会话放行、真阳性仍拦截） |
| v1.1.0（2026-09-09） | 满血版：hooks/ 四钩子进包（enforce-flow/PostToolUse/stop-enforce/SessionStart，含安装合并指引）+ scripts/version_check.py 主动版本检查（super-official-writer 同口径：永不阻塞/只读/behind 提示）+ references 同步简报路径参数化与漂移守卫规则 + Agent Skills 触发描述补强 |
| v1.0.0（2026-09-06） | 首版：A/B/C/D 模式判断 + 简报制度 + 7 子智能体（executor/code-reviewer/researcher/vision-reader/advisor×3）+ 双钢人决策内化 + AI 自助安装流程（备份→探测模型→统一填入→读回校验，含字节账校验与备份恢复路径） |

</details>

## 🙏 许可与致谢

- 双钢人决策方法参考开源项目 [dual-steelman-decision](https://github.com/Kujojolyne1992/dual-steelman-decision-skill)（MIT）
- 本仓库代码与配置 MIT License，各文件许可以 [LICENSE](./zcode-collab/LICENSE) 为准

<div align="center">

---

Made by [@Amer-CN](https://github.com/Amer-CN)

*配置来自 3 周真实项目实战迭代。仅供参考，按你自己的工作流调整。*

</div>
