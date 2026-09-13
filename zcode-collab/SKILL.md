---
name: zcode-collab
description: ZCode 多模型子智能体协作模式：主模型编排 → executor 执行 → code-reviewer 跨厂商独立审查，附 researcher 调研、vision-reader 识图、advisor 三人圆桌、双钢人决策前置。当用户提到装协作模式、子智能体、executor、code-reviewer、圆桌、多方意见、双钢人、决策前置、该不该做/选哪个方案，或想一键部署多模型分工时使用——即使用户没说"协作模式"三个字。
license: MIT
---

# ZCode 多模型协作模式（zcode-collab）

把"顶级模型编排 → 便宜模型执行 → 跨厂商独立审查"落成 ZCode 配置。本 Skill 有三个用途：

1. **部署**：按 references/ 里的材料，把协作模式装到本机（AI 全程代办，用户几乎零操作）。
2. **运行时查询**：部署后日常使用中，用户问"该怎么搭配/怎么用/出问题了怎么办"，按本文件作答。
3. **维护**：修改这套协作模式本身时，入口见下「用途三」。

## 用途三：改这套协作模式本身（给 AI 的入口）

**当用户要求修改协作规则、角色提示词、钩子行为，或问"这套东西怎么维护"时**：

本 Skill 是**生成物**——`references/agent-*.md` 由仓库根 `content/roles/*.md` 生成。
**不要直接改本机 skill 目录里的文件**，那样改动不会进仓库、别人拿不到、下次生成还会被覆盖。

正确入口：

| 要改什么 | 改哪里 | 然后 |
|---|---|---|
| 协作纪律 / 角色提示词 | 仓库根 `content/`（`collab-rules.md`、`roles/*.md`） | 跑 `build.mjs` + `sync_from_manifest.py` + **`sync-agents.py`** |
| 角色清单 / 工具权限 | 仓库根 `content/manifest.json` | 同上 |
| 部署流程 / 双钢人决策（本文件） | `zcode-collab/SKILL.md` | 直接改，重跑部署 |
| 四个钩子 | `zcode-collab/hooks/*.ps1` | 复制到 `~/.zcode/cli/hooks/` |

**关于角色数**：`content/roles/` 里是 **5 份源**，但**两侧部署后都是 7 个**——
advisor 一份源在**两侧**都拆成 **advisor-A / advisor-B / advisor-C 三席**
（ZCode 是三个静态子智能体文件，DSH 是三条 `dsh-tool-subagent` 实例行，面板上
各配一个厂商）。2026-09-13 起 DSH 圆桌与 ZCode 同体验：一次性配好三厂商，
之后一句话同时问三家。

⚠️ **改了角色提示词后，`~/.zcode/agents/*.md` 不会自动更新**——那些是部署产物。
必须跑 `python scripts/sync-agents.py .. --write` 把新正文推过去（它只换正文，
保留各文件的 `model:` / `color:`），然后**重启 ZCode 或新开会话**才生效。
2026-09-13 实测：漏了这步导致五个角色全部落后于源，回补的规则从未生效。

**仓库**：https://github.com/Amer-CN/collab-mode
**维护说明**：仓库根的 [`AGENTS.md`](https://github.com/Amer-CN/collab-mode/blob/main/AGENTS.md)
——改哪个目录、哪些是生成物、跑哪几条验证、实测踩过的坑，全在里面。**动手前先读它。**

## 版本

读取本 Skill 目录下的 `VERSION` 文件即为当前版本。用户问版本号、或要求检查更新时，报告 VERSION 内容即可（`scripts/version_check.py` 会联网比对远端 VERSION，输出 `behind` 时提示用户更新）。

## 用途一：部署（AI 自助安装，用户零界面操作）

**执行部署前，先按顺序完成下面 6 步。全程不需要用户碰设置界面，也不要问用户问题——除非第 2 步找不到任何可用模型。**

### 第 1 步：备份

若 `~/.zcode/AGENTS.md` 已存在，先复制一份到 `~/.zcode/AGENTS.md.bak-collab`；若 `~/.zcode/agents/` 目录已存在，整个目录复制为 `~/.zcode/agents.bak-collab/`。已有内容绝不覆盖丢失。

### 第 2 步：确认一个可用模型（关键：只判断"能用"，不判断"好坏"）

读取本机 ZCode 的供应商配置（通常在 `~/.zcode/v2/config.json` 的 `provider` 节，或你已知悉的等价位置），列出**当前可用**的模型。

供应商分两类，都算可用：
- **内置渠道**（ID 以 `builtin:` 开头，如 `builtin:zai-start-plan`）：ZCode 官方订阅，开箱即用，优先选
- **自定义渠道**（长 UUID，如 `a1b2c3d4-...`）：用户自己接的第三方渠道，有哪个用哪个

然后选定**一个**模型，作为全部 7 个子智能体的默认值。选择标准只有一条：**它是可用的**。最稳的选择就是你（主模型）自己正在用的那个——它必然可用。

⚠️ 不要做任何"哪个更强、哪个更便宜、哪个适合什么岗位"的判断——那是用户自己的事。统一填一个能用的，剩下的让用户自己去换。

模型引用格式按本机惯例填写（形如 `custom:<供应商ID>:<模型ID>`；内置供应商的 `builtin:` 前缀需 URL 编码为 `builtin%3A`，例如 `custom:builtin%3Azai-start-plan:GLM-5.3-Flash`）。以你本机配置中真实出现的写法为准。

### 第 3 步：写入全局规则文件

把 `references/global-agents.md` 的全文写入 `~/.zcode/AGENTS.md`：
- 文件已存在 → **追加到末尾**（先空一行），不删除既有内容
- 文件不存在 → 直接创建

### 第 4 步：写入子智能体文件

在 `~/.zcode/agents/` 目录下创建 .md 文件。每个文件的完整内容（frontmatter + 提示词）在 `references/` 下：

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| executor.md | references/agent-executor.md | 施工队（必装） |
| code-reviewer.md | references/agent-code-reviewer.md | 监理（只读，必装） |
| researcher.md | references/agent-researcher.md | 只读调研（推荐） |
| vision-reader.md | references/agent-vision-reader.md | 识图（可选，主模型支持看图可跳过） |
| advisor-a.md / advisor-b.md / advisor-c.md | references/agent-advisor.md | 圆桌三席（可选，同模板，仅 name 不同） |

写文件时做两处替换：
- `model:` 行 → 全部填第 2 步选定的那个可用模型
- `color:` 行 → 按模板保留即可（纯视觉标记）

两个注意：
- researcher 的工具列表若引用了 GitHub MCP 工具（`mcp__github__*`），先确认本机确实存在这些 MCP 工具；不存在就删掉那几行，保留 Read/Grep/Glob/Bash/WebSearch/WebFetch。
- **跳过任何可选子智能体时，必须同步删除 global-agents.md 里对应的选择规则行**（vision-reader 对应"需要理解图片内容…"一行，advisor 对应"用户想听多方意见时…"一整行）——规则行指向不存在的子智能体，主模型触发时会撞墙。

### 第 5 步：读回校验

从磁盘读回所有写入的文件。这是硬性步骤——"写成功"和"写对了"是两回事。

**agent 文件**：与 references/ 模板逐行核对，允许的差异仅限三类，出现其他差异即重写该文件：
1. `model:` 行 = 第 2 步选定的模型（必然与模板占位符不同）
2. advisor-b.md / advisor-c.md 的 `name:` 行（三席共用同一模板，仅 name 不同）
3. 第 4 步中按本机情况删除的 researcher GitHub MCP 工具行（若确实删了）

**AGENTS.md**：追加模式下的校验方法是字节账，不是逐字比对全文——
> 追加前 AGENTS.md 字节数 + global-agents.md 字节数 + 1（空行换行符）= 追加后总字节数

等式成立 = 用户既有内容原样保留且新段完整；不等 = 出了问题，用备份恢复后重来。全新创建（原文件不存在）时，才适用"全文与 references 一致"的校验。

### 第 4.5 步：安装钩子（满血版协作模式需要这一步）

四个钩子脚本在 `hooks/` 下（enforce-flow.ps1、post-tool-audit.ps1、stop-enforce.ps1、session-start-enforce.ps1）。Windows 机器照做，其他系统跳过本步（钩子是 PowerShell 脚本）：

1. 四个文件复制到 `~/.zcode/cli/hooks/`。
2. **合并**（不是覆盖）`~/.zcode/cli/config.json` 的 hooks 配置：读出现有 `hooks.events`，把四个事件追加进去——
   - `PreToolUse`（matcher `Edit|Write|MultiEdit|ApplyPatch|NotebookEdit`，调 enforce-flow.ps1，timeoutMs 10000）
   - `Stop`（调 stop-enforce.ps1，timeoutMs 5000）
   - `SessionStart`（matcher `startup|resume`，调 session-start-enforce.ps1，timeoutMs 5000）
   - `PostToolUse`（调 post-tool-audit.ps1，timeoutMs 10000）
   
   ⚠️ config.json 里可能有密钥（mcp.headers 等），**只改 `hooks` 键，其他键一个字节都不许动**。改前先备份 config.json。
3. PowerShell 语法校验四个脚本（ParseFile 零错误），模拟 stdin 跑一遍 post-tool-audit 确认能写出审计日志。

### 第 6 步：告知用户

向用户报告：
1. 装了什么、模型统一填了哪个、钩子装了几个；
2. **必须重启 ZCode（或新开会话）才会生效**——子智能体在会话启动时发现，旧会话直接用是看不到的；
3. 模型是统一默认，随时可在设置界面逐个更换（换法见下方"模型自主权"）；
4. 给三条使用示范：「帮我看看这个项目」／粘贴一段方案／说"圆桌"。

### 版本检查（每次协作任务开工前顺手执行）

跑 `python scripts/version_check.py`（以 Skill 目录为 cwd）。输出 `behind` 时提醒用户一句"发现新版（本地 X → 远端 Y），要不要同步"，用户说要才动手（git pull 或重下覆盖）；`current`/`unknown`（断网无 git）静默继续，**绝不阻塞任务**。

## 用途二：日常使用与答疑

### 模型自主权（用户问"该用什么模型"时这样答）

模型选择是用户自己的事，本 Skill **不绑定任何模型**。只有两条经验建议（不是规矩）：

1. **审查者别和执行者用同一个模型**——同一份权重自审，盲区 100% 重合，等于没审。最好也不同厂商。
2. **圆桌三家（advisor-A/B/C）分属不同厂商**——配成同一家，圆桌变复读机。

其余搭配（哪个岗位用贵模型、用便宜模型、什么时候换）完全由用户决定。用户改模型：设置界面里逐个子智能体换下拉框即可，新会话生效。

### 日常用法速查

- **粘贴现成方案** → 自动走外部方案模式（跳过出方案，执行完提交推送，审查交给外部 AI）
- **大白话描述需求** → 自动走完整四步（出方案 → 写简报 → executor → code-reviewer → 裁决）
- **纯讨论、≤2 文件小改动** → 主模型直接做
- **说「圆桌」「大家怎么看」** → 同时召集 advisor-A/B/C，主模型综合出"一致点/分歧点/我的判断"
- **感觉跑偏** → 说「回滚到基线提交」（每个任务简报里存了基线哈希，`git reset --hard <哈希>` 保命）
- **小事别啰嗦** → 说「直接做」；恢复 → 说「走流程」

### 健康信号

- code-reviewer 长期零驳回 → 审查走过场（比没有更危险），换更强模型
- code-reviewer 驳回率过半 → 执行者不胜任，换中档模型
- executor 频繁报"受阻" → 多半是简报质量问题

## 决策前置流程（双钢人，已内化）

**触发**（须同时满足）：用户的问题是「该不该做 / 选哪个方案 / 为什么现在做 / 要不要迁移或重构」类决策问题；不是纯执行任务，不是事实查询。
**不触发**：用户已带完整方案来（不重新争论）、执行流程进行中、≤2 文件小改动、事实检索类问题。纯讨论中的决策问题，先走本流程再回答。

**分级**：默认一律走 15 分钟简版；只有用户明说「完整备忘录」，或决策不可逆且影响面大（换架构、换数据库、删数据）时，才用完整 12 段版（模板见 `references/decision-full.md`）。

**执行者**：主模型自己跑，不派子智能体。需要补事实时先派 researcher 取证。

**简版硬规则**：
1. 决策结论只是建议，由用户拍板。
2. 输出总长 ≤300 字：crux 一句话（最小可翻转结论的假设）、反转条件至多 3 条、承诺窗口一句话。超出即为违规。
3. 决策落定且涉及改代码时，从结论生成任务简报，走正常协作流程；code-reviewer 只管"做对了没有"，不管"该不该做"。

**简版输出格式**：
```
crux：<一句话>
反转条件：<至多 3 条>
承诺窗口：<一句话>
```

完整版按 `references/decision-full.md` 的 12 段结构执行（问题定义 → 目标层级 → 证据审计 → 选项 → 正反钢人 → crux → 决策门 → 建议 → 牺牲/风险/置信度/反转条件/承诺窗口 → 验证计划）。
