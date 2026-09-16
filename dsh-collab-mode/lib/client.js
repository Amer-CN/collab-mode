/**
 * dsh-collab-mode —— 浏览器半侧。
 *
 * 表面有两处：
 *   1. 设置左侧导航的独立 section（本文件主要部分），
 *      id `collab-mode`、order 79（使用统计 80 的上方）、label `协作模式`。
 *   2. 对话窗口的两处「子智能体运行」表面，都只读展示宿主自检路由的 runs 字段：
 *      a. 右栏 `sidebar.right.pane.tab` 常驻竖列（`RunsPane` / `RunsPaneTitle`，按会话
 *         过滤，随切会话换行；宽列排版用上了宽敞空间）；
 *      b. 输入框上方原位的运行卡（`RoleRunDock`，面板 C 区块的总开关 `dockCardVisible`
 *         控制整卡是否渲染；行数/折叠/列由 `dockRows` / `dockFold` / `dockColumns` 控制）。
 *      两者轮询同一份 `/api/collab-mode/selfcheck`、共用 `runStateOf` 与行样式，
 *      因此不引入第二数据源。走 `ctx.inject(['slots'])` 注册（软依赖），
 *      与设置卡互不影响。
 * 页内是 ZCode 子智能体页同款两视图（列表 / 编辑），语义按 DSH：
 *   列表：7 行（色点 + 名称 + 模型 chip + 工具计数 + 描述）+ 搜索，
 *     点一行进编辑；行上无可写/只读 tag，未注册才红字提示；B/C 原样排下方。
 *   编辑：名称/描述/工具/人设全文只读展示，颜色（8 色点选，写入 `roleColors`）、
 *     模型（供应商→模型两级下拉）+ 推理强度（跟随选中模型的 advertised 档位，查不到
 *     回退静态全集）+ maxTokens 可改，保存只写当前行；不做新建/删除/启用开关。
 *
 * 两份账本都齐才会渲染：
 *   Host 侧注册了 `collab-mode` 命名空间（见 lib/index.js 的 installSection），
 *   浏览器侧在 `settings.section` 上注册 id 为 collab-mode 的导航。
 * 任一缺失时对应位置什么都不渲染 —— 所以本卡片的「找不到条目」降级文案是
 * 卡片自己内部的可读提示，而不是指望外壳兜底。
 *
 * 数据通道：
 *   A/B 区块的读写走原生 client settings scope（`ctx.settingsScope.bind`），
 *   不经过自建 HTTP bridge —— 与 dsh-free-search 的取舍不同，那个插件写于
 *   settingsScope 可用之前。C 区块的运行时自检走宿主侧的一条只读路由
 *   `/api/collab-mode/selfcheck`（Host 半侧用 webServer.register 提供），
 *   自检 payload 里 roles[] 的描述/颜色/工具/人设全文只读字段与顶层的
 *   modelCatalog（可用供应商→模型目录，拿不到就 null）都只读，不可写回。
 *
 * 命名空间缺失/不可写仍由卡片内 `status !== 'ready'` 分支提示。
 *
 * 模块格式：客户端模块系统要求的 lazy-CJS factory（照 dsh-free-search/lib/client.js）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-collab-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')

    const NS = 'collab-mode'
    const SELFCHECK_URL = '/api/collab-mode/selfcheck'
    const EFFORTS_URL = '/api/collab-mode/model-efforts'

    /**
     * 七个角色行：与 Host 半侧 build.mjs 展开出的 ROLES 同序，用于渲染七行。
     * advisor 一份源拆三席（advisor-A/B/C），三席 persona 同文、各配一个厂商。
     */
    const ROLE_ROWS = [
      { key: 'executor', label: 'executor', writable: true },
      { key: 'code-reviewer', label: 'code-reviewer', writable: false },
      { key: 'researcher', label: 'researcher', writable: false },
      { key: 'advisor-A', label: 'advisor-A', writable: false },
      { key: 'advisor-B', label: 'advisor-B', writable: false },
      { key: 'advisor-C', label: 'advisor-C', writable: false },
      { key: 'vision-reader', label: 'vision-reader', writable: false },
    ]

    /**
     * 推理强度枚举，来自 dsh-tool-subagent 的 agentOptions.reasoningEffort。
     * 注意这是静态全集（对话窗口是按模型 advertised efforts 动态过滤的，
     * 所以某些模型在窗口里没有 max 档）。muse-spark-1.3 两个模型都不支持 max，
     * 用户决策去掉 max 档；已存的 max 值用粘滞选项展示，改选即消除。
     */
    const EFFORTS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']

    /**
     * 角色配色：DSH 面板自用的 7 色展示映射（纯展示常量，与 CSS 同类）。
     * 这是**出厂默认**：生效值来自既有 `collab-mode` 命名空间的 `roleColors`
     * 字段（面板编辑页可改），缺项/非法值都回落这里。
     * 注意 manifest zcode.color 是另一套（ZCode frontmatter 的源），两者是各平台的
     * 显示偏好，不要求一致 —— 因此 advisor 三席在这里是绿/粉/黄（与本机 ZCode 三席
     * 文件头一致），researcher 用蓝（把绿让给 advisor-A，避免撞车）。
     */
    const COLOR_HEX = { red: '#e5534b', orange: '#e8933c', yellow: '#d29922', green: '#3fb950', teal: '#39c5cf', blue: '#58a6ff', purple: '#a371f7', pink: '#f778ba' }
    const ROLE_COLORS = { executor: 'orange', 'code-reviewer': 'red', researcher: 'blue', 'advisor-A': 'green', 'advisor-B': 'pink', 'advisor-C': 'yellow', 'vision-reader': 'purple' }

    /** 可选色名集合 = COLOR_HEX 的键（与宿主 ROLE_COLOR_NAMES 同这 8 个）。 */
    const COLOR_NAMES = Object.keys(COLOR_HEX)

    /**
     * 一个角色的生效色名：只认 8 色白名单，缺项与非法值一律回落出厂默认
     * （`colors` 可以是命名空间快照值、自检 live 块，或已经归一化过的映射）。
     * 三处显示面（设置列表色点 / dock 行色条 / 右栏卡片色条）都走这一个口径，
     * 因此「改一处三处联动」不需要第二份取色逻辑。
     */
    function roleColorName(colors, roleKey) {
      const value = colors !== null && typeof colors === 'object' ? colors[roleKey] : undefined
      return COLOR_NAMES.includes(value) ? value : ROLE_COLORS[roleKey] || ''
    }

    /** 一份配置里的角色配色 → 归一化后的完整映射（七个角色一个不缺，见 roleColorName）。 */
    function roleColorsFrom(src) {
      const out = {}
      for (const row of ROLE_ROWS) out[row.key] = roleColorName(src, row.key)
      return out
    }

    const CSS = [
      '.dshcm-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;min-width:0;list-style:none;transition:border-color .16s,background .16s;overflow:clip;margin-bottom:8px}',
      '.dshcm-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.dshcm-header{width:100%;color:inherit;cursor:pointer;text-align:left;font:inherit;background:0 0;border:0;align-items:center;gap:8px;padding:10px 14px;display:flex}',
      '.dshcm-header:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshcm-headText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex;overflow:hidden}',
      '.dshcm-name{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-weight:600;overflow:hidden}',
      '.dshcm-description{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;font-size:12px;overflow:hidden}',
      '.dshcm-pending{color:var(--dsw-alias-state-warn-primary);white-space:nowrap;flex:none;font-size:12px}',
      '.dshcm-chevron{color:var(--dsw-alias-label-tertiary);flex:none;font-size:13px;transition:transform .12s}',
      '.dshcm-chevronOpen{transform:rotate(180deg)}',
      '.dshcm-body{flex-direction:column;gap:16px;padding:0 14px 14px;display:flex}',
      '.dshcm-block{flex-direction:column;gap:8px;display:flex}',
      '.dshcm-blockTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;opacity:.75}',
      '.dshcm-note{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:1.6}',
      '.dshcm-error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.6}',
      /* 面板顶的新版本横幅（宿主 updateInfo.behind 为真时才渲染）：是提示不是报错，
         所以用 warn 色系而不是 error 色系，且不设任何可点元素。 */
      '.dshcm-behind{border:1px solid var(--dsw-alias-state-warn-primary);background:rgba(210,153,34,.12);color:var(--dsw-alias-state-warn-primary);border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.6}',
      '.dshcm-roleName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.dshcm-tag{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary);white-space:nowrap;border-radius:999px;padding:1px 6px;font-size:11px}',
      '.dshcm-tagRo{background:rgba(240,170,80,.15);color:#f0b060;border:1px solid rgba(240,170,80,.3)}',
      '.dshcm-grid{display:flex;gap:8px;flex-wrap:wrap}',
      '.dshcm-field{flex-direction:column;gap:3px;min-width:0;display:flex;flex:1 1 150px}',
      '.dshcm-label{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dshcm-input,.dshcm-select{border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border-radius:6px;padding:5px 7px;font-size:13px;width:100%;box-sizing:border-box}',
      '.dshcm-select{color-scheme:light dark}',
      '.dshcm-select option,.dshcm-select optgroup{background-color:#fff;color:#1f2328}',
      '.dshcm-select option[value="stale"]{color:var(--dsw-alias-state-error-primary);font-weight:600}',
      '@media (prefers-color-scheme:dark){.dshcm-select{color-scheme:dark}.dshcm-select option,.dshcm-select optgroup{background-color:#1e1f24;color:#e8e8ea}}',
      '.dshcm-input:hover:not(:disabled),.dshcm-select:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}',
      '.dshcm-input:focus-visible,.dshcm-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dshcm-input:disabled,.dshcm-select:disabled{opacity:.6;cursor:default}',
      '.dshcm-switch{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}',
      '.dshcm-switch input{accent-color:var(--dsw-alias-state-business-primary)}',
      '.dshcm-footer{justify-content:space-between;align-items:center;gap:8px;display:flex;flex-wrap:wrap}',
      '.dshcm-footerRight{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshcm-btn{font:inherit;cursor:pointer;border-radius:6px;padding:5px 12px;font-size:13px}',
      '.dshcm-save{border:1px solid var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dshcm-save:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}',
      '.dshcm-save:disabled{opacity:.5;cursor:default}',
      '.dshcm-discard{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dshcm-discard:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}',
      '.dshcm-self{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.dshcm-selfRow{display:flex;align-items:baseline;gap:10px;font-size:12px;min-width:0}',
      /* 自检键值：标签定宽顶左，值等宽、允许在任意处断行（审计目录/时间戳都很长）。 */
      '.dshcm-selfKey{flex:none;min-width:8em;color:var(--dsw-alias-label-tertiary)}',
      '.dshcm-selfVal{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}',
      /* 生效路由表：角色 | 厂商 | 模型 | 推理强度，四列焊死（跟运行卡同一套对齐语言）。 */
      '.dshcm-routeList{display:flex;flex-direction:column;gap:4px}',
      '.dshcm-routeRow{display:flex;align-items:baseline;gap:10px;font-size:12px;min-width:0}',
      '.dshcm-routeHead{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px}',
      '.dshcm-routeRole{flex:none;min-width:13ch;color:var(--dsw-alias-label-primary);font-weight:600;white-space:nowrap}',
      '.dshcm-routeProv{flex:none;min-width:11ch;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshcm-routeModel{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshcm-routeEffort{flex:none;min-width:6ch;text-align:right;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.dshcm-selfActions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
      '.dshcm-selfDiv{border:0;border-top:1px solid var(--dsw-alias-border-l2);margin:0}',
      '.dshcm-list{border:0;background:transparent;overflow:hidden}',
      '.dshcm-rowBtn{width:100%;text-align:left;font:inherit;color:inherit;background:0 0;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);padding:12px 8px;display:flex;gap:12px;cursor:pointer;align-items:center;box-sizing:border-box}',
      '.dshcm-rowBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      /* 行按钮的焦点圈走内描边：行有 border-bottom 且父层 overflow:hidden，外描边会被裁掉。 */
      '.dshcm-rowBtn:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-alias-state-business-primary)}',
      '.dshcm-rowBtn:disabled{cursor:default}',
      '.dshcm-rowBtn:last-child{border-bottom:0}',
      '.dshcm-dot{flex:none;width:10px;height:10px;border-radius:50%}',
      '.dshcm-roleName{font-size:14px}',
      '.dshcm-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.dshcm-rowTop{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.dshcm-route{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshcm-routeDim{font-size:12.5px;color:var(--dsw-alias-label-tertiary)}',
      '.dshcm-rowDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}',
      '.dshcm-rowSide{flex:none;align-self:flex-start;display:flex;align-items:center;gap:8px}',
      '.dshcm-tools{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.dshcm-go{font-size:14px;color:var(--dsw-alias-label-tertiary);flex:none}',
      '.dshcm-effort{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dshcm-colorOnce{display:inline-flex;align-items:center;gap:8px}',
      '.dshcm-count{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px}',
      '.dshcm-crumb{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.dshcm-back{font:inherit;cursor:pointer;border:0;background:0 0;color:var(--dsw-alias-state-business-primary);font-size:13px;padding:0}',
      '.dshcm-pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px 10px;margin:0;max-height:220px;overflow:auto}',
      '.dshcm-colorRow{display:flex;gap:10px;flex-wrap:nowrap;align-items:center;min-height:22px}',
      /* 色块流式等分：8 个永远一行，多宽都装下（窄了等比缩，宽了顶到 26px 为止左对齐），
         再不会为最后一个颜色单独换行。 */
      '.dshcm-swatch{flex:1 1 0;min-width:0;aspect-ratio:1 / 1;height:auto;max-width:26px;padding:0;border-radius:50%;border:2px solid transparent;box-sizing:border-box;cursor:pointer}',
      '.dshcm-swatchOn{border-color:var(--dsw-alias-label-primary)}',
      '.dshcm-swatchOff{opacity:.35}',
      '.dshcm-swatch:disabled{cursor:default}',
      /* 键盘焦点圈：色块与行按钮都补上（输入框/下拉早有同款，口径一致）。 */
      '.dshcm-swatch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.dshcm-static{font:inherit;color:var(--dsw-alias-label-primary);font-size:13px}',
      /* 对话窗口的「子智能体运行卡」：整卡只报状态，无可点元素，故不设 hover 反馈。
         宽度对齐官方 dock 家族（vlln/dsh-task-status 样板）：左右各让出
         SIDE_CLEARANCE、每侧再让出 2*DOCK_INSET，上限 CARD_MAX 再扣 4*DOCK_INSET，
         margin 0 auto 居中 —— 与输入框同宽，不溢出容器。 */
      '.dshcm-runs{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:8px 10px;margin:0 auto 8px;min-width:0;box-sizing:border-box}',
      '.dshcm-runsTitle{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;justify-content:space-between;gap:8px}',
      /* 标题行右上角的展开/收起：按钮以前在列表最底下，展开后滚出视野就找不回来了，
         才有人以为“收不回去”。进标题行右端，不占纵向空间。 */
      '.dshcm-foldBtn{font:inherit;font-size:12px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--dsw-alias-label-caption);background:0 0;border:0;padding:0;cursor:pointer;white-space:nowrap}',
      '.dshcm-foldBtn:hover{color:var(--dsw-alias-label-secondary)}',
      /* 跳转按钮：唯一的入口（整卡不可点，防误触），幽灵小字，不抢纵向空间。 */
      '.dshcm-jump{font:inherit;font-size:12px;color:var(--dsw-alias-label-caption);background:0 0;border:0;padding:2px 4px;cursor:pointer;white-space:nowrap;flex:none}',
      '.dshcm-jump:hover{color:var(--dsw-alias-label-secondary)}',
      '.dshcm-cardRight{display:inline-flex;align-items:center;gap:6px;flex:none}',
      '.dshcm-runsList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}',
      '.dshcm-runRow{display:flex;align-items:center;gap:8px;font-size:12.5px;line-height:1.5;min-width:0;font-variant-numeric:tabular-nums;border-radius:6px;box-shadow:inset 3px 0 0 var(--runColor,transparent);padding-left:8px}',
      '.dshcm-runRowStale{opacity:.55}',
      /* 右栏卡片（三段式，大标题/小标题/参数行，窄面竖叠，允许换行不挤）。 */
      '.dshcm-runCard{flex-direction:column;align-items:stretch;gap:3px;padding:8px 10px 8px 12px}',
      '.dshcm-cardTop{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
      '.dshcm-cardTask{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.dshcm-cardName{color:var(--dsw-alias-label-primary);font-size:13.5px;font-weight:600;letter-spacing:-.005em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshcm-cardSub{color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}',
      '.dshcm-cardParams{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dshcm-runRole{color:var(--dsw-alias-label-primary);font-weight:600;flex:none;min-width:13ch}',
      '.dshcm-runRoute{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}',
      '.dshcm-runTime{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;text-align:right}',
      /* 列对齐：每行独立 flex，列宽跟着内容走就会错位。文本列给最小宽顶左，
         数字/时刻列给等宽字体下的固定宽顶右，超长只有路由列能缩（省略号），
         所以多行下来每列的起点永远落在同一 x 上。 */
      '.dshcm-runTime_time{min-width:5ch}',
      '.dshcm-runTime_elapsed{min-width:8ch}',
      '.dshcm-runTime_rate{min-width:10ch}',
      '.dshcm-runState{min-width:3em}',
      /* 「未知」占位样式：耗时 / 开始时刻 / 速率三列共用（runDataCells 里
         text 为 null 的格子都套它，右栏参数行同款）—— 有字段但值为 null
         也是「未知」，绝不编数字。 */
      '.dshcm-runUnknown{color:var(--dsw-alias-label-dimmed);font-style:italic}',
      '.dshcm-runState{flex:none;color:var(--dsw-alias-label-secondary)}',
      '.dshcm-runState_running{color:var(--dsw-alias-state-business-primary)}',
      '.dshcm-runState_stale{color:var(--dsw-alias-state-warn-primary)}',
      '.dshcm-runState_ok{color:var(--dsw-alias-state-success-primary)}',
      '.dshcm-runState_failed{color:var(--dsw-alias-state-error-primary)}',
      /* 右栏竖列形态：常驻，占满格宽并自己滚动。窄栏里行换行排版、不收窄列；
         窗口够宽时右栏才真的宽敞，这时切回单行横向铺开。 */
      '.dshcm-pane{display:flex;flex-direction:column;height:100%;min-height:0;padding:10px 12px 12px;box-sizing:border-box}',
      '.dshcm-paneHead{flex:none;display:flex;align-items:center;gap:8px;padding-bottom:8px}',
      '.dshcm-paneList{flex:1 1 auto;min-height:0;overflow-y:auto}',
      '.dshcm-paneEmpty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;margin:0}',
      /* 两面分开：dock 保高度（单行紧凑，不吃对话空间），侧栏保呼吸感
         （纵向宽敞，行距拉开）；同一套设计语言，不同的身段。注意 padding 简写
         会清掉基类的 padding-left（色条会压字），这里必须带上左边距。 */
      '.dshcm-pane .dshcm-runsList{gap:8px}',
      '.dshcm-pane .dshcm-runRow{flex-wrap:wrap;row-gap:4px;padding:6px 0 6px 8px}',
      '@media (min-width:1200px){.dshcm-pane .dshcm-runRow{flex-wrap:nowrap}}',
      '.dshcm-pane .dshcm-runRoute{flex:1 1 120px}',
      '.dshcm-chip{display:inline-flex;align-items:center;gap:6px;min-width:0}',
      '.dshcm-chipDot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}',
      /* C 区块的运行卡设置：开关/数值一行，列勾选一行（复用 .dshcm-switch 的观感）。
         两组各带一行小标题，免得开关、数字、勾选框糊成一片。 */
      '.dshcm-subLabel{display:block;width:100%;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dshcm-modeRow{display:flex;flex-direction:column;align-items:stretch;gap:8px}',
      '.dshcm-colRow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.dshcm-colBox{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}',
      '.dshcm-colBox input{accent-color:var(--dsw-alias-state-business-primary)}',
      /* 数字框横排：标签在左顶满，框在右 88px —— 两个框再也不会上下错位。 */
      '.dshcm-numField{flex-direction:row;align-items:center;gap:10px;flex:1 1 auto;width:auto}',
      '.dshcm-numField .dshcm-label{flex:1 1 auto;min-width:0}',
      '.dshcm-numField .dshcm-input{width:88px;flex:none}',
      /* 保存栏回到文档流：宿主设置页的滚动容器与假设不一致，sticky 在此页
         封不住底缝；不贴就不漏，跟着内容走。 */
      /* 区块折叠（C 的运行状态）：沿用运行卡标题行折叠按钮的观感
         （幽灵小字按钮 + 同款折角符），字号字重直接写在与 .dshcm-blockTitle 同值上，
         不新增字阶。折角符与开合同步，时长与折叠同语言。 */
      '.dshcm-foldToggle{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;color:inherit;cursor:pointer;text-align:left;font:inherit;background:0 0;border:0;padding:0}',
      /* 只给折角符这个新增控件定色（与 C 的运行卡折叠按钮同口径），正文一律继承。 */
      '.dshcm-foldToggle .dshcm-chevron{color:var(--dsw-alias-label-caption)}',
      /* 键盘焦点圈：与输入框/下拉同口径（新增的折叠控件必须键盘可达且可见）。 */
      '.dshcm-foldToggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dshcm-chevronFold{transition:transform .16s ease-out}',
      /* 面板大改版只动排版：A 行统一 52px 行高（点一行进编辑的整行热区不变）。 */
      '.dshcm-rowBtn{min-height:52px}',
      '.dshcm-dot{width:12px;height:12px}',
    ].join('')

    const tagId = 'dsh-collab-mode/card.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-collab-mode'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const h = react.createElement

    /**
     * 一个空草稿：七个角色都留空（= 继承父会话路由）+ 三个开关默认开 + 阈值 3。
     * C 区块的四个运行卡显示字段也在草稿里（与 A/B 同一个落盘口，不再直写）：
     * 出厂默认就是显示面在没有真值时的兜底值，故空草稿直接取 RUN_DEFAULT_CONFIG，
     * 不另立第二份默认值。
     */
    function emptyDraft() {
      const routes = {}
      for (const row of ROLE_ROWS) {
        routes[row.key] = { provider: '', model: '', reasoningEffort: '', maxTokens: '' }
      }
      return {
        routes,
        gate: true,
        audit: true,
        warnOnTurnEnd: true,
        declarationThreshold: '3',
        logDir: '',
        // 标记色的草稿就是生效值本身（缺项/非法在 roleColorsFrom 里回落出厂默认）。
        roleColors: { ...ROLE_COLORS },
        dockCardVisible: RUN_DEFAULT_CONFIG.dockCardVisible,
        // 行数/折叠数与「未声明文件阈值」同款：草稿用字符串承载，便于输入中途为空。
        dockRows: String(RUN_DEFAULT_CONFIG.dockRows),
        dockFold: String(RUN_DEFAULT_CONFIG.dockFold),
        dockColumns: { ...RUN_DEFAULT_COLUMNS },
      }
    }

    /** 把 scope 快照的解析值摊成草稿（数值字段用字符串承载，便于输入中途为空）。 */
    function draftFromValue(value) {
      const draft = emptyDraft()
      if (value === null || typeof value !== 'object') return draft
      const routes = value.routes
      if (routes !== null && typeof routes === 'object') {
        for (const row of ROLE_ROWS) {
          const route = routes[row.key]
          if (route === null || typeof route !== 'object') continue
          draft.routes[row.key] = {
            provider: typeof route.provider === 'string' ? route.provider : '',
            model: typeof route.model === 'string' ? route.model : '',
            reasoningEffort: typeof route.reasoningEffort === 'string' ? route.reasoningEffort : '',
            maxTokens: Number.isFinite(route.maxTokens) && route.maxTokens > 0 ? String(route.maxTokens) : '',
          }
        }
      }
      if (typeof value.gate === 'boolean') draft.gate = value.gate
      if (typeof value.audit === 'boolean') draft.audit = value.audit
      if (typeof value.warnOnTurnEnd === 'boolean') draft.warnOnTurnEnd = value.warnOnTurnEnd
      if (Number.isInteger(value.declarationThreshold)) draft.declarationThreshold = String(value.declarationThreshold)
      if (typeof value.logDir === 'string') draft.logDir = value.logDir
      draft.roleColors = roleColorsFrom(value.roleColors)
      // C 区块四个显示字段：口径与显示面同源（runsConfigFromLive / roleColorsFrom 同款白名单），
      // 缺项/类型不对/越界一律回出厂默认，不猜。
      draft.dockCardVisible =
        typeof value.dockCardVisible === 'boolean' ? value.dockCardVisible : RUN_DEFAULT_CONFIG.dockCardVisible
      draft.dockRows =
        Number.isInteger(value.dockRows) && value.dockRows >= 0 && value.dockRows <= DOCK_ROWS_MAX
          ? String(value.dockRows)
          : String(RUN_DEFAULT_CONFIG.dockRows)
      draft.dockFold =
        Number.isInteger(value.dockFold) && value.dockFold >= 0 && value.dockFold <= DOCK_FOLD_MAX
          ? String(value.dockFold)
          : String(RUN_DEFAULT_CONFIG.dockFold)
      draft.dockColumns = runsConfigFromLive(value).dockColumns
      return draft
    }

    /**
     * 草稿 → 有序 mutation 操作。
     *
     * 每个角色字段都发一条 `set` 或 `unset`：`unset` 让该字段退回组合层默认值
     * （= 继承父会话路由），这正是「留空 = 继承」的实现方式 —— 发 `set ''` 会把
     * 空串写进用户层，语义就变成「显式设成空」了。
     */
    function opsFromDraft(draft) {
      const ops = []
      for (const row of ROLE_ROWS) {
        const route = draft.routes[row.key]
        const fields = [
          ['provider', route.provider.trim()],
          ['model', route.model.trim()],
          ['reasoningEffort', route.reasoningEffort],
        ]
        for (const [field, text] of fields) {
          const path = ['routes', row.key, field]
          if (text === '') ops.push({ op: 'unset', path })
          else ops.push({ op: 'set', path, value: text })
        }
        const maxTokens = draft.routes[row.key].maxTokens.trim()
        const path = ['routes', row.key, 'maxTokens']
        if (maxTokens === '') ops.push({ op: 'unset', path })
        else ops.push({ op: 'set', path, value: Number(maxTokens) })
      }
      ops.push({ op: 'set', path: ['gate'], value: draft.gate })
      ops.push({ op: 'set', path: ['audit'], value: draft.audit })
      ops.push({ op: 'set', path: ['warnOnTurnEnd'], value: draft.warnOnTurnEnd })
      ops.push({ op: 'set', path: ['declarationThreshold'], value: Number(draft.declarationThreshold) })
      if (draft.logDir.trim() === '') ops.push({ op: 'unset', path: ['logDir'] })
      else ops.push({ op: 'set', path: ['logDir'], value: draft.logDir.trim() })
      // 标记色：七个角色各写各的键（草稿值已归一化，空值不写）。
      // 注意：这里必须有 —— 否则编辑页改了色再点底栏全量保存，颜色会被静默丢掉。
      for (const row of ROLE_ROWS) {
        const color = draft.roleColors[row.key]
        if (typeof color === 'string' && color !== '') ops.push({ op: 'set', path: ['roleColors', row.key], value: color })
      }
      // C 区块四个显示字段：与 A/B 同一批 ops 落盘（没有第二条写入路径）。
      // 列勾选按归一化后的完整映射逐列写；锁死列在草稿里已被强制为 true。
      ops.push({ op: 'set', path: ['dockCardVisible'], value: draft.dockCardVisible === true })
      ops.push({ op: 'set', path: ['dockRows'], value: Number(draft.dockRows) })
      ops.push({ op: 'set', path: ['dockFold'], value: Number(draft.dockFold) })
      for (const id of RUN_COLUMN_IDS) {
        ops.push({ op: 'set', path: ['dockColumns', id], value: draft.dockColumns[id] === true })
      }
      return ops
    }

    /**
     * 单个角色的草稿 → mutation 操作（编辑视图保存只写这一行，不碰开关）。
     * `color` 是这一行的标记色草稿：随路由一起写，且**只写这一个角色的键**
     * （`roleColors.<key>`），其他角色的配色与开关一律不动。
     */
    function opsFromRole(rowKey, route, color) {
      const ops = []
      const fields = [
        ['provider', route.provider.trim()],
        ['model', route.model.trim()],
        ['reasoningEffort', route.reasoningEffort],
      ]
      for (const [field, text] of fields) {
        const path = ['routes', rowKey, field]
        if (text === '') ops.push({ op: 'unset', path })
        else ops.push({ op: 'set', path, value: text })
      }
      const maxTokens = route.maxTokens.trim()
      const path = ['routes', rowKey, 'maxTokens']
      if (maxTokens === '') ops.push({ op: 'unset', path })
      else ops.push({ op: 'set', path, value: Number(maxTokens) })
      // 色名只可能是 8 色白名单里的一个（草稿由 roleColorName 归一化），空值不写。
      if (typeof color === 'string' && color !== '') {
        ops.push({ op: 'set', path: ['roleColors', rowKey], value: color })
      }
      return ops
    }

    /**
     * 单个角色的路由校验（编辑视图只拦这一行，不连坐其他角色）：
     * maxTokens 必须是正数；reasoningEffort 必须在该模型 advertised 档位里。
     */
    function roleInvalid(rowKey, route) {
      const maxTokens = route.maxTokens.trim()
      if (maxTokens !== '' && !(Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0)) {
        return 'maxTokens 必须是正数，或留空'
      }
      return effortInvalid(route)
    }

    /** 草稿里数值/档位字段是否合法；不合法就阻塞保存而不是悄悄改写用户输入。 */
    function draftInvalid(draft) {
      const threshold = Number(draft.declarationThreshold)
      if (!Number.isInteger(threshold) || threshold < 1) return '「未声明文件阈值」必须是 ≥1 的整数'
      // C 区块「运行卡显示」的两个数量：与宿主同界（0 合法 = 不限），空串与非整数一律拦下。
      const rows = Number(draft.dockRows)
      if (draft.dockRows.trim() === '' || !Number.isInteger(rows) || rows < 0 || rows > DOCK_ROWS_MAX) {
        return `「显示行数」必须是 0~${DOCK_ROWS_MAX} 的整数（0 = 不限）`
      }
      const fold = Number(draft.dockFold)
      if (draft.dockFold.trim() === '' || !Number.isInteger(fold) || fold < 0 || fold > DOCK_FOLD_MAX) {
        return `「折叠已完成」必须是 0~${DOCK_FOLD_MAX} 的整数`
      }
      for (const row of ROLE_ROWS) {
        const route = draft.routes[row.key]
        const maxTokens = route.maxTokens.trim()
        if (maxTokens !== '' && !(Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0)) {
          return `角色 ${row.label} 的 maxTokens 必须是正数，或留空`
        }
        const effortProblem = effortInvalid(route)
        if (effortProblem !== null) return `角色 ${row.label} 的${effortProblem}`
      }
      return null
    }

    /**
     * 草稿与宿主当前值是不是同一份（比的是**落盘口径**）。
     *
     * 用途只有一个：行内保存只落当前那一行，落盘后要判断「草稿里除了这一行之外，
     * 还有没有别的未落盘改动」。有 → 脏标记必须留着，否则下面的跟随刷新会拿快照
     * 把列表页改过的 B/C 开关、行数一起回滚掉。
     *
     * `skipRole` 是要排除在比对之外的角色 key（刚被行内保存写下去的那一行：它的
     * 草稿值可能与尚未回写的快照不同，不该因此被算成「还有改动」）。
     *
     * 比法：两侧都先过 draftFromValue（同一套归一化），文本字段 trim 后比（落盘时
     * 会 trim），数值字段比数值（"0500" 与 500 是同一个值，不能判成两份）。
     */
    function draftIsSaved(draft, value, skipRole) {
      const base = draftFromValue(value)
      const sameText = (a, b) => a.trim() === b.trim()
      const sameNumber = (a, b) => {
        const na = Number(a)
        const nb = Number(b)
        if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na === nb
        return sameText(a, b)
      }
      for (const row of ROLE_ROWS) {
        if (row.key === skipRole) continue
        const a = draft.routes[row.key]
        const b = base.routes[row.key]
        if (!sameText(a.provider, b.provider) || !sameText(a.model, b.model)) return false
        if (a.reasoningEffort !== b.reasoningEffort) return false
        if (!sameNumber(a.maxTokens, b.maxTokens)) return false
        if (draft.roleColors[row.key] !== base.roleColors[row.key]) return false
      }
      if (draft.gate !== base.gate || draft.audit !== base.audit || draft.warnOnTurnEnd !== base.warnOnTurnEnd) return false
      if (!sameNumber(draft.declarationThreshold, base.declarationThreshold)) return false
      if (!sameText(draft.logDir, base.logDir)) return false
      if (draft.dockCardVisible !== base.dockCardVisible) return false
      if (!sameNumber(draft.dockRows, base.dockRows) || !sameNumber(draft.dockFold, base.dockFold)) return false
      for (const id of RUN_COLUMN_IDS) {
        if (draft.dockColumns[id] !== base.dockColumns[id]) return false
      }
      return true
    }

    /** C 区块的自检数据；失败时把原因带回给卡片显示，而不是白屏。 */
    async function fetchSelfCheck() {
      try {
        // same-origin + credentials：宿主路由走 composition 的信任栅栏
        // （Host/Origin 检查 + 浏览器认证 cookie），不带 cookie 会被 401。
        const response = await fetch(SELFCHECK_URL, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!response.ok) {
          return {
            ok: false,
            message:
              response.status === 401
                ? '自检路由拒绝了这次请求（未通过浏览器认证）'
                : `自检路由返回 HTTP ${response.status}`,
          }
        }
        const body = await response.json()
        return body && body.ok === true ? { ok: true, value: body.value } : { ok: false, message: (body && body.message) || '自检路由返回了失败结果' }
      } catch (error) {
        return { ok: false, message: `无法访问自检路由：${error && error.message ? error.message : String(error)}` }
      }
    }

    /**
     * 查一个模型的 advertised 推理档位（对话窗口同源：`llm.resolveModelInfo`）。
     * 进程级记忆（key = provider/model），失败回 null —— 调用方回退静态全集。
     */
    const effortsMemo = {}
    async function fetchEfforts(provider, model) {
      const key = `${provider}\n${model}`
      if (Object.hasOwn(effortsMemo, key)) return effortsMemo[key]
      let found = null
      try {
        const url = `${EFFORTS_URL}?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (response.ok) {
          const body = await response.json()
          if (body && body.ok === true && body.value !== undefined && body.value !== null) {
            const v = body.value
            if (Array.isArray(v.efforts) && v.efforts.length > 0) found = v
          }
        }
      } catch (error) {
        found = null
      }
      effortsMemo[key] = found
      return found
    }

    /** 档位缓存里的已知名单（同步读）；查不到（未查询过或查询失败）回 null = 放行。 */
    function knownEfforts(provider, model) {
      const key = `${provider}\n${model}`
      if (!Object.hasOwn(effortsMemo, key)) return null
      const found = effortsMemo[key]
      if (found === null) return null
      const ids = found.efforts.map((e) => (e === null || typeof e !== 'object' || typeof e.id !== 'string' ? '' : e.id)).filter((id) => id !== '')
      return ids.length > 0 ? ids : null
    }

    /**
     * 推理强度校验：effort 非空、且该 provider/model 的 advertised 名单已知、且不在名单里 → 拦。
     * 名单查不到（没选模型、查询失败、模型无档位概念）一律放行，不做静态全集兜底拦截。
     */
    function effortInvalid(route) {
      const effort = route.reasoningEffort
      if (effort === '') return null
      const provider = route.provider.trim()
      const model = route.model.trim()
      if (provider === '' || model === '') return null
      const known = knownEfforts(provider, model)
      if (known === null) return null
      if (known.includes(effort)) return null
      return `推理强度 ${effort} 不在 ${provider}/${model} 支持的档位里（${known.join(' / ')}）`
    }

    /**
     * 保存前把当前草稿用到的 provider/model 档位查齐（带缓存，已查过的直接命中）。
     * 保存被拦就是「校验发生在保存动作里」的证明。
     */
    async function ensureEffortsKnown(routes) {
      for (const route of routes) {
        const provider = route.provider.trim()
        const model = route.model.trim()
        if (provider === '' || model === '' || route.reasoningEffort === '') continue
        if (Object.hasOwn(effortsMemo, `${provider}\n${model}`)) continue
        await fetchEfforts(provider, model)
      }
    }

    /** 生效路由表的一行：角色 | 厂商 | 模型 | 推理强度。未注册的行强度列标红，不丢数据。 */
    function routeRowNode(role) {
      const inherit = role.provider === '' && role.model === ''
      const modelText = inherit ? '继承会话' : (role.model || '?')
      return h(
        'div',
        { className: 'dshcm-routeRow', key: role.key },
        h('span', { className: 'dshcm-routeRole', title: role.tool }, role.tool),
        h('span', { className: 'dshcm-routeProv', title: role.provider }, inherit ? '—' : (role.provider || '?')),
        h('span', { className: 'dshcm-routeModel', title: inherit ? '继承会话' : (role.model || '?') }, modelText),
        role.registered
          ? h('span', { className: 'dshcm-routeEffort' }, role.reasoningEffort ? `@${role.reasoningEffort}` : '—')
          : h('span', { className: 'dshcm-routeEffort', style: { color: 'var(--dsw-alias-state-error-primary)' } }, '未注册'),
      )
    }

    /** 一张只读的键值行（标签定宽，值等宽可断行）。 */
    function selfRow(label, text) {
      return h('div', { className: 'dshcm-selfRow' }, h('span', { className: 'dshcm-selfKey' }, label), h('span', { className: 'dshcm-selfVal' }, text))
    }

    /** 自检区（C 区块）。 */
    function SelfCheckBlock(props) {
      const { check, loading, onRefresh, busy, onProbe, probe } = props
      if (loading && check === null) return h('p', { className: 'dshcm-note' }, '正在读取运行时自检…')
      if (check === null) return h('p', { className: 'dshcm-error' }, '自检数据不可用。')
      if (check.ok !== true) {
        return h(
          'div',
          { className: 'dshcm-block' },
          h('p', { className: 'dshcm-error' }, `自检不可用：${check.message}`),
          h('p', { className: 'dshcm-note' }, '常见原因：宿主半侧未加载（插件未启用），或自检路由未注册。'),
          h('button', { type: 'button', className: 'dshcm-btn dshcm-discard', onClick: onRefresh, disabled: busy }, '重试'),
        )
      }
      const v = check.value
      const registered = v.roles.filter((r) => r.registered).length
      return h(
        'div',
        { className: 'dshcm-self' },
        selfRow('插件版本', v.version || '(未知)'),
        selfRow('提示段', `${v.rulesSection}（${v.rulesChars} 字符）`),
        selfRow('已注册角色工具', `${registered} / ${v.roles.length}`),
        selfRow('审计目录', v.logDir),
        selfRow(
          '最近一条审计',
          v.lastAudit === null
            ? '(本目录还没有审计记录)'
            : `${auditClock(v.lastAudit.ts)} · ${v.lastAudit.tool} · ${v.lastAudit.ok ? 'ok' : 'failed'} · ${v.lastAudit.latency}ms`,
        ),
        h('hr', { className: 'dshcm-selfDiv' }),
        h('span', { className: 'dshcm-subLabel' }, '各角色实际生效路由'),
        h(
          'div',
          { className: 'dshcm-routeList' },
          h(
            'div',
            { className: 'dshcm-routeRow', key: '__head' },
            h('span', { className: 'dshcm-routeRole dshcm-routeHead' }, '角色'),
            h('span', { className: 'dshcm-routeProv dshcm-routeHead' }, '厂商'),
            h('span', { className: 'dshcm-routeModel dshcm-routeHead' }, '模型'),
            h('span', { className: 'dshcm-routeEffort dshcm-routeHead' }, '推理强度'),
          ),
          ...v.roles.map((role) => routeRowNode(role)),
        ),
        h(
          'div',
          { className: 'dshcm-selfActions' },
          h('button', { type: 'button', className: 'dshcm-btn dshcm-discard', onClick: onRefresh, disabled: busy }, '刷新自检'),
          h('button', { type: 'button', className: 'dshcm-btn dshcm-discard', onClick: onProbe, disabled: busy || props.probing }, props.probing ? '探测中…' : '探测七个角色'),
        ),
        probe === null ? null : h('p', { className: probe.ok ? 'dshcm-note' : 'dshcm-error' }, probe.message),
      )
    }

    /* ─────────────── 子智能体运行的两个面（同一数据源） ─────────────── *
     *
     * 数据只有一个来源：宿主 `/api/collab-mode/selfcheck` 的只读 `runs` 字段
     * （会话作用域由客户端按 `run.sid` 过滤，宿主不动）。两个面从同一份 runs 渲染：
     *
     *   1. 右栏 `sidebar.right.pane.tab` 常驻竖列（keyed 座位，键 = 类型 id）；
     *   2. `conversation.input.dock` 在原位的那张卡（面板 `dockCardVisible` 控制整卡开关）。
     *
     * 两个时钟分开：
     *   - 2 秒轮询拉 runs（新行出现、行翻 ok/failed、子会话活动刷新 aliveAt 靠它）；
     *   - 1 秒本地 tick 现算「已跑时长」与 stale 置灰 —— 宿主算的 stale 只反映上一次
     *     拉取，被吞那一行没有 end 事件、也没有新的存活信号，必须靠 aliveAt 自己在
     *     客户端浮出来。
     * 列表为空（或全属于别的会话）时渲染一行空态文案，不占位成空卡。
     *
     * 两个面的行数/状态一致由**同一份 runs + 同一个 runStateOf** 保证；各自轮询的
     * 相位差最多一帧（≤2s 轮询周期内），不引入第二数据源、不新增写入路径。
     */

    /** 布局变量对齐官方 dock 家族（ConversationRoot.module.css，vlln/dsh-task-status 样板）。 */
    const SIDE_CLEARANCE = 'var(--dsh-composer-side-clearance, 16px)'
    const DOCK_INSET = 'var(--dsh-composer-dock-inset, 8px)'
    const CARD_MAX = 'var(--dsh-composer-card-max-width, 780px)'

    const RUN_STATE_TEXT = { running: '运行中', stale: '无响应', ok: '完成', failed: '失败' }

    /**
     * 可显示的列。`role` 与 `state` 是行的骨架，勾选框里禁掉（关掉整行就没内容了）。
     * `rate` 有数据源：宿主从子会话事件累加 settled 步的 outputTokens/decodeMs
     * （口径与官方 sessionStats 逐字段相同），这里按官方 `formatTokensPerSecond` 渲染；
     * 没有上报的行渲染「未知」占位（同 `dshcm-runUnknown`），绝不编数。
     */
    const RUN_COLUMNS = [
      { id: 'role', label: '角色', locked: true },
      { id: 'route', label: '路由' },
      { id: 'state', label: '状态', locked: true },
      { id: 'elapsed', label: '耗时' },
      { id: 'startedAt', label: '开始时刻' },
      { id: 'rate', label: '速率' },
    ]
    const RUN_COLUMN_IDS = RUN_COLUMNS.map((col) => col.id)

    /**
     * 有数据源、可编可缺的列（渲染顺序仍由 RUN_COLUMNS 的声明序决定，见 runDataCells）。
     * `role` / `route` / `state` 是行的骨架列，各自有固定的位置，不走这条数据列通道。
     */
    const RUN_DATA_COLUMN_IDS = ['elapsed', 'startedAt', 'rate']

    /** 出厂默认勾选（与宿主 DEFAULTS.dockColumns 对齐；字段名不一致时以这里的键为准）。 */
    const RUN_DEFAULT_COLUMNS = { role: true, route: true, state: true, elapsed: true, startedAt: false, rate: true }

    /** 运行面显示配置的默认值：总开关开、最多 8 行、折叠 3 条已完成、配色出厂默认。 */
    const RUN_DEFAULT_CONFIG = {
      dockCardVisible: true,
      dockRows: 8,
      dockFold: 3,
      dockColumns: { ...RUN_DEFAULT_COLUMNS },
      roleColors: { ...ROLE_COLORS },
    }

    /**
     * 行数/折叠数的上限，与宿主 index.js 的 DOCK_ROWS_MAX / DOCK_FOLD_MAX 同值。
     * 双侧都校验：这里在保存前拦住，用户看到的是可读提示，而不是宿主 validate 抛回的原话。
     */
    const DOCK_ROWS_MAX = 50
    const DOCK_FOLD_MAX = 20

    /** 一份配置里的列勾选 → 归一化后的完整映射（缺项/非布尔回默认，锁死列强制为真）。 */
    function columnsFromValue(src) {
      const given = src !== null && typeof src === 'object' && src.dockColumns !== null && typeof src.dockColumns === 'object' ? src.dockColumns : {}
      const columns = {}
      for (const id of RUN_COLUMN_IDS) {
        columns[id] = typeof given[id] === 'boolean' ? given[id] : RUN_DEFAULT_COLUMNS[id]
      }
      // 角色与状态是骨架列，无论别人怎么勾都必须为真（否则行里什么都不剩）。
      for (const col of RUN_COLUMNS) if (col.locked === true) columns[col.id] = true
      return columns
    }

    /**
     * 运行面的显示配置。真值存在既有的 `collab-mode` 设置命名空间（五个字段，宿主侧
     * PANEL_SCHEMA 里有），这里是进程内广播：面板 C 区块写四个显示字段、编辑页写
     * `roleColors`，两个显示面与设置列表订阅它（改一处三处联动就靠这条广播）。
     * 命名空间还没到手时用出厂默认，快照与自检的 live 块到了由 runsConfigFromLive 灌入。
     */
    let runsConfig = { ...RUN_DEFAULT_CONFIG, dockColumns: { ...RUN_DEFAULT_COLUMNS }, roleColors: { ...ROLE_COLORS } }
    const runsConfigListeners = new Set()

    /** 宿主自检回读的 live 块 → 归一化后的配置（缺项/类型不对一律回默认，不猜）。 */
    function runsConfigFromLive(live) {
      const src = live !== null && typeof live === 'object' ? live : {}
      return {
        dockCardVisible: typeof src.dockCardVisible === 'boolean' ? src.dockCardVisible : RUN_DEFAULT_CONFIG.dockCardVisible,
        dockRows: Number.isInteger(src.dockRows) && src.dockRows >= 0 && src.dockRows <= DOCK_ROWS_MAX ? src.dockRows : RUN_DEFAULT_CONFIG.dockRows,
        dockFold: Number.isInteger(src.dockFold) && src.dockFold >= 0 && src.dockFold <= DOCK_FOLD_MAX ? src.dockFold : RUN_DEFAULT_CONFIG.dockFold,
        dockColumns: columnsFromValue(src),
        // 角色标记色：缺项/非法名回落出厂默认（同一个 roleColorName 口径）。
        roleColors: roleColorsFrom(src.roleColors),
      }
    }

    function readRunsConfig() {
      return runsConfig
    }

    /** 灌入配置；值真的变了才广播（避免每次轮询都让两个面重渲染）。 */
    function publishRunsConfig(next) {
      const after = JSON.stringify(next)
      if (after === JSON.stringify(runsConfig)) return
      runsConfig = next
      for (const listener of [...runsConfigListeners]) {
        try {
          listener()
        } catch (error) {
          // 一个订阅者炸了不该连坐其他订阅者。
          void error
        }
      }
    }

    /** 订阅运行面配置；返回退订函数。 */
    function subscribeRunsConfig(listener) {
      runsConfigListeners.add(listener)
      return () => runsConfigListeners.delete(listener)
    }

    /**
     * 右栏 tab 类型的身份（`ctx.sidebarRightTabs.register` 的 `id`，同时是
     * `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 两个 keyed 座位的键）。
     * 包名是天然取值 —— id 在全部注册里必须唯一。
     */
    const RUNS_TAB_ID = 'dsh-collab-mode/runs'
    const RUNS_TAB_KIND = 'collab-runs'
    const RUNS_TAB_LABEL = '子智能体运行'

    /**
     * 服务解析器：优先注入回调的参数，其次根 ctx 属性，最后 ctx.get。
     * 照宿主 index.js 的 settingsCtx/serverCtx 先例 —— 注入的服务在回调参数上，
     * 不在闭包捕获的根 ctx 上。
     */
    function makeResolver(injectedCtx, rootCtx) {
      return (name) => {
        if (injectedCtx !== null && injectedCtx !== undefined && injectedCtx[name] !== undefined) return injectedCtx[name]
        if (rootCtx !== null && rootCtx !== undefined && rootCtx[name] !== undefined) return rootCtx[name]
        return typeof (rootCtx === null || rootCtx === undefined ? undefined : rootCtx.get) === 'function' ? rootCtx.get(name) : undefined
      }
    }

    /**
     * 试一次把右栏的 tab（按 kind 认）切出来。返回这次尝试是否「有结论」：
     * 服务还没到手（tab 记录未挂）时返回 false，呼叫方决定要不要再试。
     *
     * `sidebarRight` 是导航控制器（`@deepseek-ai/dsh-client-ui-sidebar-right`
     * 用 `ctx.reflect.provide("sidebarRight", controller)` 提供）：座位没挂时
     * `openTab` 拿不到会话 store 会抛，所以这里必须兜住。
     */
    function tryOpenRunsTab(resolve) {
      try {
        const right = typeof resolve === 'function' ? resolve('sidebarRight') : undefined
        if (right === null || right === undefined || typeof right.openTab !== 'function') return false
        right.openTab(RUNS_TAB_KIND)
        return true
      } catch (error) {
        return false
      }
    }

    /**
     * 注册成功后把右栏的 tab 切出来 —— 用户找不到引导页的胶囊，不能只靠它。
     *
     * 第一次尝试安排在注册那一帧之后的下一帧：座位挂载晚于本插件的 apply。
     * 最多试 5 次（每 400ms 一次），始终没成功就返回，不无限重试。
     */
    function openRunsTabAfterRegister(resolve) {
      if (typeof setTimeout !== 'function') return
      let attempts = 0
      const attempt = () => {
        if (attempts >= 5) return
        attempts += 1
        if (tryOpenRunsTab(resolve) === true) return
        setTimeout(attempt, 400)
      }
      setTimeout(attempt, 0)
    }

    /** 组件侧读运行面配置（React 状态 + 订阅，配置变了立刻重渲染）。 */
    function useRunsConfig() {
      const [value, setValue] = react.useState(readRunsConfig)
      react.useEffect(() => subscribeRunsConfig(() => setValue(readRunsConfig())), [])
      return value
    }

    /**
     * 一格数值输入（行数/折叠数）：改的是草稿，落盘由底栏保存按钮统一做。
     * onChange 直接把原文交给调用方（草稿用字符串承载），合法性由 draftInvalid 在保存时判；
     * 输入框只过滤掉空串，避免草稿被清成空值。
     */
    function runsNumberField(labelText, value, disabled, onChangeText) {
      return h(
        'div',
        { className: 'dshcm-field dshcm-numField' },
        h('span', { className: 'dshcm-label' }, labelText),
        h('input', {
          className: 'dshcm-input',
          value: String(value),
          inputMode: 'numeric',
          min: 0,
          disabled,
          onChange: (e) => {
            if (e.target.value.trim() === '') return
            onChangeText(e.target.value)
          },
        }),
      )
    }

    /**
     * 运行卡设置（面板 C 区块）：总开关 + 行数/折叠数 + 列勾选。
     * 四个字段都改草稿（`props.onChange` → 卡片的 `edit()`），与 A/B 同一批 ops 落盘：
     * 底栏保存/放弃是唯一出口，这里不再直写命名空间。
     * 显示面（dock 与右栏）读的是已保存值，未保存时屏幕上仍是保存前的样子。
     */
    function RunsCardRow(props) {
      const disabled = props.disabled === true
      const draft = props.draft

      return h(
        'div',
        { className: 'dshcm-block' },
        h('span', { className: 'dshcm-blockTitle' }, '运行卡显示'),
        h('span', { className: 'dshcm-subLabel' }, '开关与数量'),
        h(
          'label',
          { className: 'dshcm-switch' },
          h('input', {
            type: 'checkbox',
            checked: draft.dockCardVisible === true,
            disabled,
            onChange: (e) => props.onChange((next) => {
              next.dockCardVisible = e.target.checked
            }),
          }),
          '在对话窗口显示运行卡（关掉 = 整卡不渲染）',
        ),
        h(
          'div',
          { className: 'dshcm-modeRow' },
          runsNumberField('显示行数（0 = 不限）', draft.dockRows, disabled, (text) => props.onChange((next) => {
            next.dockRows = text
          })),
          runsNumberField('折叠已完成', draft.dockFold, disabled, (text) => props.onChange((next) => {
            next.dockFold = text
          })),
        ),
        h('span', { className: 'dshcm-subLabel' }, '显示列'),
        h(
          'div',
          { className: 'dshcm-colRow' },
          ...RUN_COLUMNS.map((col) =>
            h(
              'label',
              { className: 'dshcm-colBox', key: col.id },
              h('input', {
                type: 'checkbox',
                checked: draft.dockColumns[col.id] === true,
                disabled: disabled || col.locked === true,
                onChange: (e) => props.onChange((next) => {
                  // 锁死列写回时强制 true：显示列口径与显示面（runsConfigFromLive）同源。
                  next.dockColumns = { ...next.dockColumns, [col.id]: col.locked === true ? true : e.target.checked }
                }),
              }),
              col.label,
            ),
          ),
        ),
        h(
          'p',
          { className: 'dshcm-note' },
          '角色与状态是行的骨架，固定显示。数据列（耗时 / 开始时刻 / 速率）各自没有上报数据时都显示「未知」，不编数字。本组修改进草稿，点底栏「保存」才生效、「放弃修改」撤回。',
        ),
      )
    }

    /** 耗时 → 照抄官方 formatDuration：1 分钟内 45.2 秒（整数秒不带尾巴），以上 X 分 X 秒，不垫零。 */
    function formatRunMs(ms) {
      const value = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
      const seconds = value / 1000
      if (seconds < 60) {
        const rounded = Math.round(seconds * 10) / 10
        return `${rounded}秒`
      }
      const whole = Math.round(seconds)
      const minutes = Math.floor(whole / 60)
      if (minutes < 60) return `${minutes}分${whole % 60}秒`
      return `${Math.floor(minutes / 60)}小时${minutes % 60}分`
    }

    /** 精确毫秒（耗时列的悬停提示，显示层不叠数字）。 */
    function exactMsTitle(ms) {
      const value = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
      return `${value}ms`
    }

    /**
     * 官方口径的解码速度显示串（`dsh-client-ui-chat` 的 `formatTokensPerSecond`）：
     * ≥10 取整、<10 保留一位小数。单位串与官方 `message.tokensPerSecond` 同形（`{tps} tok/s`）。
     */
    function formatTokensPerSecond(tps) {
      const clamped = Math.max(0, tps)
      return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
    }

    /**
     * 一行的解码速度 = 宿主累加的 settled 步 outputTokens ÷ decodeMs（decode 已剔除 TTFT，
     * 与官方输入框下的速度同一口径）。宿主只给两个计数，除法与格式化在客户端做 ——
     * 与官方 `deriveTurnMetrics` + `formatTokensPerSecond` 的分工相同。
     * 计数缺失、或 decodeMs 不是正数 → null（渲染「未知」，不编数字）。
     */
    function runTokensPerSecond(run) {
      const tokens = run.rateTokens
      const decodeMs = run.rateDecodeMs
      if (!Number.isFinite(tokens) || !Number.isFinite(decodeMs) || decodeMs <= 0) return null
      return tokens / (decodeMs / 1000)
    }

    /**
     * 跳转服务（官方子代理对话页只是一个入口，不自建页面）：照抄
     * background-agents 的跳法 —— 先 refresh 再 open。`sessions` 是宿主核心面，
     * 用软依赖等它；没到手时保持 null，按钮不渲染，整卡不受影响。
     */
    let sessionsSvc = null
    function takeSessionsService(candidate) {
      if (candidate !== null && typeof candidate === 'object'
        && typeof candidate.openSubagent === 'function'
        && typeof candidate.refreshSubagents === 'function') {
        sessionsSvc = candidate
      }
    }

    /**
     * 跳进子会话对话页。候选地址按顺序试（宿主 `selectSubagent` 要求 mode 与
     * 在册条目逐字相等，猜错就抛 —— 但抛在落子之前，无副作用，可放心连试）：
     *  1. `navigationAddress`：从已加载目录按 child id 导出，mode 是条目自己的，最准；
     *  2. `subagentAddress`：之前导航记住的 retained 地址；
     *  3. 自组 one-shot（咱们的角色全是 one-shot 模式）；
     *  4. 自组 continuable（抄 background-agents 的旧兜底，留作兼容）。
     * 全失败就把原因写进按钮悬停（不再静默吞错，否则下次还得猜）。
     */
    async function openRun(run, event) {
      const fail = (message) => {
        try {
          const el = event !== null && typeof event === 'object' ? (event.currentTarget || event.target) : null
          if (el !== null && typeof el.setAttribute === 'function') el.setAttribute('title', message)
        } catch (ignored) {
          /* 悬停都写不进去就算了 */
        }
      }
      try {
        const sessions = sessionsSvc
        if (sessions === null || typeof run.childSid !== 'string' || run.childSid === '') return
        if (typeof run.sid === 'string' && run.sid !== '') await sessions.refreshSubagents(run.sid)
        const candidates = []
        try {
          const derived = typeof sessions.navigationAddress === 'function' ? sessions.navigationAddress(run.childSid) : undefined
          if (derived !== undefined && derived !== null) candidates.push(derived)
        } catch (ignored) {
          /* 目录没加载就下一个 */
        }
        try {
          const retained = typeof sessions.subagentAddress === 'function' ? sessions.subagentAddress(run.childSid) : undefined
          if (retained !== undefined && retained !== null) candidates.push(retained)
        } catch (ignored) {
          /* 没记住就下一个 */
        }
        candidates.push(
          { parentSessionId: run.sid, childSessionId: run.childSid, mode: 'one-shot' },
          { parentSessionId: run.sid, childSessionId: run.childSid, mode: 'continuable' },
        )
        let lastError = null
        for (const address of candidates) {
          try {
            sessions.openSubagent(address)
            return
          } catch (error) {
            lastError = error
          }
        }
        fail(lastError instanceof Error ? lastError.message : String(lastError))
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    }

    /** 该行能不能跳：内存行（有 childSid）且跳转服务已到，缺一不可。审计行无按钮。 */
    function canJump(run) {
      return sessionsSvc !== null && typeof run.childSid === 'string' && run.childSid !== ''
    }

    /** 跳转按钮（唯一的入口，整卡不可点，防误触）。 */
    function jumpButton(run) {
      return h('button', { type: 'button', className: 'dshcm-jump', key: 'jump', title: '进入子代理对话', onClick: (event) => void openRun(run, event) }, '进入 ›')
    }

    /**
     * 官方标题缓存：子会话自己的 `subagent` 投影里折出的 durable label，
     * 跟官方顶部抽屉是同一个来源（`subagent/descriptor` 事件，类型注释原话：
     * “初始委派 description 持久化为子会话的创建标签”）。label 不可变，
     * 读到就缓存；读不到（投影未挂/会话已释放）保持缺席，回落旧逻辑。
     * 读动作是纯同步的 map/快照，无订阅无副作用；失败（包括 growing 的负结果）
     * 也缓存，200 条封顶后清一次 —— 1s tick 重渲染时不会反复建 face。
     */
    const titleCache = new Map()
    function childTitle(childSid) {
      if (typeof childSid !== 'string' || childSid === '') return ''
      if (titleCache.has(childSid)) return titleCache.get(childSid)
      let label = ''
      try {
        const sessions = sessionsSvc
        const binding = sessions !== null && typeof sessions.binding === 'function' ? sessions.binding(childSid) : undefined
        const projections = binding !== undefined && binding !== null ? binding.session?.projections : undefined
        const face = projections !== undefined && projections !== null && typeof projections.faceOf === 'function'
          ? projections.faceOf('subagent')
          : undefined
        const snapshot = face !== undefined && face !== null && typeof face.getSnapshot === 'function' ? face.getSnapshot() : undefined
        const found = snapshot !== undefined && snapshot !== null ? snapshot.label : undefined
        if (typeof found === 'string' && found !== '') label = found
      } catch (ignored) {
        /* 投影没挂就回落 */
      }
      if (titleCache.size > 200) titleCache.clear()
      titleCache.set(childSid, label)
      return label
    }

    /**
     * 一个运行行右侧的生效状态：running / stale（超时没有存活信号）/ ok / failed。
     * stale 看的是 `aliveAt`（宿主记的「最后一次子会话活动」），不是 startedAt ——
     * 前台委派能跑几十分钟，按开始时间判会把正在干活的行全标成无响应。
     */
    function runStateOf(run, now, staleMs) {
      if (run.running !== true) return run.ok === true ? 'ok' : 'failed'
      const aliveAt = Number.isFinite(run.aliveAt) ? run.aliveAt : run.startedAt
      return now - aliveAt > staleMs ? 'stale' : 'running'
    }

    /** 正在跑（含无响应）的行数 —— 右栏标题与 chip 的读数。 */
    function activeCountOf(visible, now, staleMs) {
      let count = 0
      for (const run of visible) {
        const state = runStateOf(run, now, staleMs)
        if (state === 'running' || state === 'stale') count += 1
      }
      return count
    }

    /**
     * 一块运行面的标题读数：总数 + 进行中。dock 与右栏共用这一份措辞与这一份计数口径
     * （同一份 runs、同一个 activeCountOf），两面不会再出现「N 行」与「子智能体运行 · N」
     * 两种写法、或者两个不一样的数。
     */
    function runsCountText(visible, now, staleMs) {
      const active = activeCountOf(visible, now, staleMs)
      return `子智能体运行 · ${visible.length}${active > 0 ? ` · 进行中 ${active}` : ''}`
    }

    /**
     * 把一份 runs 折成「进行中全量 + 已完成最近 fold 行」，再按 rows 上限截最新几行。
     * 右栏竖列与 dock 卡都用它，因此两面的行集合同源。
     * `rows === 0` 表示不限行数；折叠只作用于**已结束**的行，进行中的一行都不能被截掉。
     */
    function foldRuns(visible, now, staleMs, showDone, rows, fold) {
      const isActive = (run) => {
        const state = runStateOf(run, now, staleMs)
        return state === 'running' || state === 'stale'
      }
      const done = visible.filter((run) => !isActive(run))
      const doneShown = showDone ? done : done.slice(-Math.max(0, fold))
      const hiddenCount = done.length - doneShown.length
      const shownIds = new Set(doneShown.map((run) => run.callId))
      const picked = visible.filter((run) => isActive(run) || shownIds.has(run.callId))
      // 行数上限只截「最新 N 行」：runs 由宿主按开始时间升序给，靠后的才是最近的。
      const kept = rows > 0 && picked.length > rows ? picked.slice(picked.length - rows) : picked
      return { rows: kept, doneTotal: done.length, hiddenCount, truncated: picked.length - kept.length }
    }

    /** 开始时刻 → 照抄官方 formatMessageClock：当天只显示 HH:mm（精确毫秒放 title 悬停）。 */
    function formatClock(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * 审计记录的时间戳（宿主 side 是 `new Date().toISOString()`，UTC 串）→ 与运行行
     * 同一个读法（本地 HH:mm，见 formatClock）：面板上两种时间不再一个 UTC 一个本地。
     * 解析不出来（空串/非 ISO）就原样显示，不吞信息。
     */
    function auditClock(ts) {
      if (typeof ts !== 'string' || ts === '') return '(时间未知)'
      const ms = Date.parse(ts)
      return Number.isFinite(ms) ? formatClock(ms) || ts : ts
    }

    /**
     * 一行的耗时：进行中（含无响应）现算 `now - startedAt`，已结束的用宿主记的 `ms`。
     * 两边都拿不到（字段缺失/非正数）时返回 null = 「未知」—— 调用方渲染占位，
     * 绝不把缺失编成「0秒」。
     */
    function runElapsed(run, state, now) {
      if (state === 'running' || state === 'stale') {
        return Number.isFinite(run.startedAt) && run.startedAt > 0 ? Math.max(0, now - run.startedAt) : null
      }
      return Number.isFinite(run.ms) && run.ms > 0 ? run.ms : null
    }

    /**
     * 一行的数据列（耗时 / 开始时刻 / 速率）→ 有序数组，顺序 = RUN_COLUMNS 的声明序。
     * dock 单行与右栏卡片都映射这一个数组，所以「列序」只有一份定义，两面不会再各排
     * 一遍导致先后不一致。每格 `text === null` 表示这一列没有数据源（缺字段/非正数）
     * → 调用方渲染 `${列名} 未知` 占位，绝不编数字。
     */
    function runDataCells(run, state, elapsed, columns) {
      const cells = []
      for (const col of RUN_COLUMNS) {
        if (!RUN_DATA_COLUMN_IDS.includes(col.id)) continue
        if (columns[col.id] !== true) continue
        let text = null
        let title = ''
        if (col.id === 'elapsed' && elapsed !== null) {
          text = formatRunMs(elapsed)
          title = exactMsTitle(elapsed)
        } else if (col.id === 'startedAt') {
          const clock = formatClock(run.startedAt)
          if (clock !== '') text = clock
        } else if (col.id === 'rate') {
          const tps = runTokensPerSecond(run)
          if (tps !== null) {
            text = `${formatTokensPerSecond(tps)} tok/s`
            title = `${run.rateTokens} tok / ${Math.round(run.rateDecodeMs)}ms（decode 已剔除 TTFT）`
          }
        }
        cells.push({ id: col.id, text, title, unknownText: `${col.label} 未知` })
      }
      return cells
    }

    /**
     * 一行运行记录（dot + 勾选出来的若干列）。两面共用，状态语义只有一份。
     * `columns` 控制显示哪些列；角色与状态恒显（配置层已锁）。
     * `colors` 是面板配置的角色配色（缺项/非法回落出厂默认，见 roleColorName），
     * 左边那道色条由它决定。
     * 数据列（耗时 / 开始时刻 / 速率）由 runDataCells 按 RUN_COLUMNS 声明序产出，
     * 哪一格没有数据源就渲染「未知」占位（见 dshcm-runUnknown），不编数字。
     */
    /** dock 单行里的数据列样式（开始时刻用 .dshcm-runTime_time，与耗时/速率区分）。 */
    const DOCK_TIME_CLASS = {
      elapsed: 'dshcm-runTime dshcm-runTime_elapsed',
      startedAt: 'dshcm-runTime dshcm-runTime_time',
      rate: 'dshcm-runTime dshcm-runTime_rate',
    }
    function dockTimeClass(id) {
      return DOCK_TIME_CLASS[id] || 'dshcm-runTime'
    }

    function runRowNode(run, state, elapsed, columns, colors) {
      const route =
        run.provider !== '' && run.model !== ''
          ? `${run.provider}/${run.model}`
          : run.provider !== ''
            ? `${run.provider}/…`
            : '路由未知'
      const on = (id) => columns[id] === true
      // 色条取的是面板配置的角色标记色（缺项/非法名回落出厂默认，见 roleColorName）。
      const runColor = COLOR_HEX[roleColorName(colors, run.role)] || 'var(--dsw-alias-label-dimmed)'
      // 对话窗口行：单行横铺，列对齐，不换行（dock 保高度）。
      const children = [
        h('span', { key: 'role', className: 'dshcm-runRole' }, run.role),
      ]
      if (on('route')) children.push(h('span', { key: 'route', className: 'dshcm-runRoute', title: route }, route))
      // 时刻/耗时/速率三列按 RUN_COLUMNS 声明序出列 —— 与右栏卡片映射同一个数组（列序一份定义）。
      for (const cell of runDataCells(run, state, elapsed, columns)) {
        children.push(
          cell.text === null
            ? h('span', { key: cell.id, className: `${dockTimeClass(cell.id)} dshcm-runUnknown` }, cell.unknownText)
            : h('span', { key: cell.id, className: dockTimeClass(cell.id), title: cell.title === '' ? undefined : cell.title }, cell.text),
        )
      }
      children.push(
        h('span', { key: 'state', className: `dshcm-runState dshcm-runState_${state}` }, RUN_STATE_TEXT[state]),
      )
      if (canJump(run)) children.push(jumpButton(run))
      return h(
        'li',
        {
          className: state === 'stale' ? 'dshcm-runRow dshcm-runRowStale' : 'dshcm-runRow',
          key: run.callId,
          style: { '--runColor': runColor },
          // 标题只进悬停：一行高度是 dock 的命，不加任何纵向开销。
          ...(() => { const t = runTitle(run); return t !== '' ? { title: t } : {} })(),
        },
        ...children,
      )
    }

    /**
     * 卡片标题三级回落：子会话 `subagent` 投影的 durable label（官方顶部抽屉
     * 同一个来源）→ 宿主收的 description → prompt 头（老行/审计行）。
     */
    function runTitle(run) {
      const official = childTitle(run.childSid)
      if (official !== '') return official
      if (typeof run.title === 'string' && run.title !== '') return run.title
      return typeof run.task === 'string' ? run.task : ''
    }

    /**
     * 右栏卡片行（三段式，窄面竖叠）：大标题智能体名 + 状态，小标题模型路由，
     * 下面一行运行参数（耗时/开始时刻/速率，只放勾选的列）。列开关同样生效，
     * 只是从横向列变成纵向行 —— 同一套数据，两种身段。
     */
    function paneCardNode(run, state, elapsed, columns, colors) {
      const route =
        run.provider !== '' && run.model !== ''
          ? `${run.provider}/${run.model}`
          : run.provider !== ''
            ? `${run.provider}/…`
            : '路由未知'
      const on = (id) => columns[id] === true
      // 与 dock 行同一个取色口径（同一份配置、同一个 roleColorName）。
      const runColor = COLOR_HEX[roleColorName(colors, run.role)] || 'var(--dsw-alias-label-dimmed)'
      // 参数行同样是 runDataCells 的顺序（耗时 → 开始时刻 → 速率），与 dock 单行一致。
      const params = []
      for (const cell of runDataCells(run, state, elapsed, columns)) {
        params.push(
          cell.text === null
            ? h('span', { key: cell.id, className: 'dshcm-runUnknown' }, cell.unknownText)
            : h('span', { key: cell.id, title: cell.title === '' ? undefined : cell.title }, cell.text),
        )
      }
      return h(
        'li',
        {
          className: state === 'stale'
            ? 'dshcm-runRow dshcm-runCard dshcm-runRowStale'
            : 'dshcm-runRow dshcm-runCard',
          key: run.callId,
          style: { '--runColor': runColor },
        },
        h(
          'div',
          { className: 'dshcm-cardTop' },
          h('span', { className: 'dshcm-cardName' }, run.role),
          h(
            'span',
            { className: 'dshcm-cardRight' },
            h('span', { className: `dshcm-runState dshcm-runState_${state}` }, RUN_STATE_TEXT[state]),
            canJump(run) ? jumpButton(run) : null,
          ),
        ),
        // 标题行：官方 description 优先（顶部抽屉同源），没有回落 prompt 头；
        // 侧栏纵向够高，允许换两行。
        (() => {
          const t = runTitle(run)
          return t !== '' ? h('div', { className: 'dshcm-cardTask', title: t }, t) : null
        })(),
        on('route') ? h('div', { className: 'dshcm-cardSub', title: route }, route) : null,
        params.length > 0 ? h('div', { className: 'dshcm-cardParams' }, ...params) : null,
      )
    }

    /**
     * 两个面共用的 runs 轮询。返回 null 表示还没有拿到数据（首次请求未回）。
     * `sessionId` 为空串时不筛会话（宁可多显示也不漏报）；宿主按
     * `session.header.parentSession` 认领子会话，所以 `sid` 就是**委派方**会话 id。
     *
     * 顺带把自检里的 `live` 块灌进运行面配置：两者同一次请求回来，不额外发一次
     * `/api/collab-mode/selfcheck`。面板改了配置 → 自检刷新 → 下一次轮询即生效。
     */
    function useRuns(sessionId) {
      const [runs, setRuns] = react.useState(null)
      const [staleMs, setStaleMs] = react.useState(15000)
      const [now, setNow] = react.useState(() => Date.now())

      react.useEffect(() => {
        let alive = true
        const load = async () => {
          const result = await fetchSelfCheck()
          if (!alive || result.ok !== true) return
          const value = result.value
          setRuns(Array.isArray(value.runs) ? value.runs : [])
          if (Number.isFinite(value.runsStaleMs) && value.runsStaleMs > 0) setStaleMs(value.runsStaleMs)
          publishRunsConfig(runsConfigFromLive(value.live))
        }
        void load()
        const pollTimer = setInterval(() => void load(), 2000)
        const tickTimer = setInterval(() => setNow(Date.now()), 1000)
        return () => {
          alive = false
          clearInterval(pollTimer)
          clearInterval(tickTimer)
        }
      }, [])

      // runs 未到（首次请求在飞）或宿主回了个非数组时一律当空列表：
      // 两个面渲染都按「数组」处理，不能让 undefined 泄进 activeCountOf/foldRuns。
      const all = Array.isArray(runs) ? runs : []
      // 只有 string 才算「筛某个会话」；null/undefined（还没拿到会话 id）与其他值
      // 一律当空串：宿主按空 sid 回全部会话，那是多显示而不是串会话。
      const key = typeof sessionId === 'string' ? sessionId : ''
      return {
        ready: runs !== null,
        visible: key === '' ? all : all.filter((run) => run.sid === key),
        now,
        staleMs,
      }
    }

    /** 一个竖列：标题行（计数）+ 行列表 + 「已完成 N · 展开」。`variant` 决定行形态：
     * dock 传默认单行（保高度），右栏传 `card` 三段式（保呼吸感）。 */
    function RunsColumn(props) {
      const [showDone, setShowDone] = react.useState(false)
      const config = useRunsConfig()
      const visible = props.visible
      const folded = props.variant === 'card'
        // 右栏纵向管够：全部展开、滚动条兜底，不折叠（折叠是 dock 保高度才需要的）。
        ? { rows: visible, doneTotal: 0, hiddenCount: 0, truncated: 0 }
        : foldRuns(visible, props.now, props.staleMs, showDone, config.dockRows, config.dockFold)
      if (visible.length === 0) {
        return h('p', { className: props.emptyClass }, props.emptyText)
      }
      // 折叠开关放标题行右端：以前在列表底下，展开后滚出视野等于没有。
      // 右栏不定（全部展开），开关只属于 dock。
      const foldN = props.variant === 'card' ? 0 : Math.max(0, config.dockFold)
      const foldable = foldN > 0 && folded.doneTotal > foldN
      // 标题行与右栏竖列自己的表头是同一句读数（runsCountText），所以右栏那一面
      // 传 showTitle: false，免得同一个数在右栏里出现两行。
      const titleNode = props.showTitle === false
        ? null
        : h(
          'div',
          { className: 'dshcm-runsTitle' },
          h('span', null, runsCountText(visible, props.now, props.staleMs)),
          foldable
            ? h(
              'button',
              { type: 'button', className: 'dshcm-foldBtn', onClick: () => setShowDone((v) => !v) },
              showDone ? '收起' : `已完成 ${folded.hiddenCount} · 展开`,
            )
            : null,
        )
      return h(
        react.Fragment,
        null,
        titleNode,
        h('ul', { className: 'dshcm-runsList' }, ...folded.rows.map((run) => {
          const state = runStateOf(run, props.now, props.staleMs)
          const elapsed = runElapsed(run, state, props.now)
          return props.variant === 'card'
            ? paneCardNode(run, state, elapsed, config.dockColumns, config.roleColors)
            : runRowNode(run, state, elapsed, config.dockColumns, config.roleColors)
        })),
        folded.truncated > 0
          ? h('p', { className: 'dshcm-paneEmpty' }, `还有 ${folded.truncated} 行未显示（面板可调「显示行数」）`)
          : null,
      )
    }

    /** 右栏竖列里的 tab 标题（chip 文案；不动 tab 记录本身）。 */
    function RunsChip(props) {
      const [active, setActive] = react.useState(0)
      react.useEffect(() => {
        const load = async () => {
          const result = await fetchSelfCheck()
          if (result.ok !== true || !Array.isArray(result.value.runs)) return
          // 与右栏正文同一口径：id 没到手时不出读数 —— 拿别会话的行充数就是
          // 「过滤错会话」，那正是这一处要修的失效。
          const key = typeof props.sessionId === 'string' ? props.sessionId : ''
          const visible = key === '' ? [] : result.value.runs.filter((run) => run.sid === key)
          const staleMs = Number.isFinite(result.value.runsStaleMs) ? result.value.runsStaleMs : 15000
          setActive(activeCountOf(visible, Date.now(), staleMs))
        }
        void load()
        const timer = setInterval(() => void load(), 3000)
        return () => clearInterval(timer)
      }, [props.sessionId])
      return h(
        'span',
        { className: 'dshcm-chip' },
        active > 0 ? h('span', { className: 'dshcm-chipDot' }) : null,
        h('span', null, active > 0 ? `子智能体运行 ${active}` : '子智能体运行'),
      )
    }

    /** 右栏竖列：`sidebar.right.pane.tab` 的正文（常驻，自己滚动）。 */
    function RunsPane(props) {
      const tabInfo = props.useTabInfo
      let sessionId = props.sessionId
      let visible = true
      if (typeof tabInfo === 'function') {
        try {
          const info = tabInfo()
          if (info !== null && typeof info === 'object') {
            const tab = info.tab
            if (tab !== null && typeof tab === 'object') {
              if (typeof tab.sessionId === 'string') sessionId = tab.sessionId
              // visible 只决定渲染：轮询照跑，行数与 dock 卡不错帧。
              visible = tab.visible !== false
            }
          }
        } catch {
          visible = true
        }
      }
      // 会话 id 还没到手（tab 记录未挂上）时按空串拉会拿到**全部会话**的 runs，
      // 那是「过滤错会话」而不是「多显示一点」，所以这一帧等 id，不拿空串。
      const fetches = typeof sessionId === 'string' && sessionId !== ''
      const runs = useRuns(fetches ? sessionId : null)
      // `useRuns` 的空串口径是「不筛会话」（给 dock 的：宁可多显示也不漏报），右栏
      // 用不了它 —— id 没到手时那一份是别会话的行。这里把行摁成空列表，配合下面的
      // emptyText 显示加载态，等 id 到手再按本会话筛（就绪后只显示本会话的行）。
      const shown = visible
        ? { ready: runs.ready, visible: fetches ? runs.visible : [], now: runs.now, staleMs: runs.staleMs }
        : { ready: true, visible: [], now: Date.now(), staleMs: runs.staleMs }
      return h(
        'div',
        { className: 'dshcm-pane' },
        h(
          'div',
          { className: 'dshcm-paneHead' },
          h(
            'span',
            { className: 'dshcm-runsTitle' },
            runsCountText(shown.visible, shown.now, shown.staleMs),
          ),
        ),
        h(
          'div',
          { className: 'dshcm-paneList' },
          h(RunsColumn, {
            visible: shown.visible,
            now: shown.now,
            staleMs: shown.staleMs,
            variant: 'card',
            // 表头已经在上面这一行（同一句读数），列表里不再重复一遍。
            showTitle: false,
            emptyClass: 'dshcm-paneEmpty',
            // 空态分三种：标签页不可见 / 数据还没到手（不能当「没有记录」）/ 真的没有记录。
            emptyText: !visible
              ? '这个标签页当前不可见，先展开右侧栏再读数据。'
              : fetches && shown.ready
                ? '本会话还没有委派记录。'
                : '正在读取本会话的运行行…',
          }),
        ),
      )
    }

    /** 右栏竖列的 chip 标题（`sidebar.right.pane.tab.title`）。 */
    function RunsPaneTitle(props) {
      let sessionId = props.sessionId
      if (typeof props.useTabInfo === 'function') {
        try {
          const info = props.useTabInfo()
          const tab = info === null || typeof info !== 'object' ? null : info.tab
          if (tab !== null && typeof tab === 'object' && typeof tab.sessionId === 'string') sessionId = tab.sessionId
        } catch {
          sessionId = props.sessionId
        }
      }
      return h(RunsChip, { sessionId })
    }

    /**
     * 对话窗口的运行卡（`conversation.input.dock` 原位）。
     * 面板 C 区块的总开关关了 → 整卡不渲染（不占位）；开着但本会话没有委派记录时
     * 给一行空态文案。
     */
    function RoleRunDock(props) {
      const config = useRunsConfig()
      const { ready, visible, now, staleMs } = useRuns(props.sessionId)
      if (config.dockCardVisible !== true) return null
      return h(
        'div',
        {
          className: 'dshcm-runs',
          role: 'status',
          style: {
            width: `calc(100% - 2 * ${SIDE_CLEARANCE} - 4 * ${DOCK_INSET})`,
            maxWidth: `calc(${CARD_MAX} - 4 * ${DOCK_INSET})`,
          },
        },
        h(RunsColumn, {
          visible,
          now,
          staleMs,
          emptyClass: 'dshcm-paneEmpty',
          // 空态分两种：首轮轮询还没回来时不能说「本会话没有委派记录」。
          emptyText: ready ? '本会话还没有委派记录。' : '正在读取本会话的运行行…',
        }),
      )
    }

    /** 「协作模式」卡片本体。section 路径下默认展开、静态标题（不折叠）。 */
    function CollabModeCard(props) {
      const { scope, asSection } = props
      const isSection = asSection === true
      const [open, setOpen] = react.useState(isSection)
      const [snapshot, setSnapshot] = react.useState(scope === null ? null : scope.getSnapshot())
      const [draft, setDraft] = react.useState(emptyDraft)
      const [dirty, setDirty] = react.useState(false)
      const [saving, setSaving] = react.useState(false)
      const [failed, setFailed] = react.useState(null)
      const [check, setCheck] = react.useState(null)
      const [loadingCheck, setLoadingCheck] = react.useState(false)
      const [probing, setProbing] = react.useState(false)
      const [probe, setProbe] = react.useState(null)
      // C 区块「运行状态」的折叠：纯客户端 state，不写设置，默认收起。
      const [selfDetailsOpen, setSelfDetailsOpen] = react.useState(false)
      // 两视图状态：selected 为 null = 列表视图，否则为正在编辑的角色 key。
      const [selected, setSelected] = react.useState(null)
      const [query, setQuery] = react.useState('')
      // 当前编辑行的 advertised 档位：{ key: 'provider\nmodel', value }，value null = 回退静态。
      const [effortDyn, setEffortDyn] = react.useState({ key: null, value: null })

      // 订阅原生 scope：宿主侧写入、外部编辑 settings.yaml 都会推新快照过来。
      react.useEffect(() => {
        if (scope === null) return undefined
        setSnapshot(scope.getSnapshot())
        return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
      }, [scope])

      // 运行面配置的真值在命名空间里；快照一到就灌进进程内值（两个显示面订阅它）。
      // 外部改 settings.yaml 也会走这条路径跟着变。
      react.useEffect(() => {
        if (snapshot === null || snapshot.value === null || typeof snapshot.value !== 'object') return
        publishRunsConfig(runsConfigFromLive(snapshot.value))
      }, [snapshot])

      // 快照变了而用户没有未保存草稿时，草稿跟随刷新（屏幕上所见 = 保存后会存）。
      react.useEffect(() => {
        if (dirty) return
        setDraft(draftFromValue(snapshot === null ? null : snapshot.value))
      }, [snapshot, dirty])

      const refreshCheck = react.useCallback(async () => {
        setLoadingCheck(true)
        setCheck(await fetchSelfCheck())
        setLoadingCheck(false)
      }, [])

      react.useEffect(() => {
        if (open && check === null) void refreshCheck()
      }, [open, check, refreshCheck])

      // 编辑行的供应商/模型变了就重查 advertised 档位；未选模型时清空回静态。
      const selProvider = selected === null ? '' : (draft.routes[selected] === undefined ? '' : draft.routes[selected].provider.trim())
      const selModel = selected === null ? '' : (draft.routes[selected] === undefined ? '' : draft.routes[selected].model.trim())
      react.useEffect(() => {
        if (selected === null || selProvider === '' || selModel === '') {
          if (effortDyn.key !== null || effortDyn.value !== null) setEffortDyn({ key: null, value: null })
          return undefined
        }
        const key = `${selProvider}\n${selModel}`
        if (effortDyn.key === key) return undefined
        if (Object.hasOwn(effortsMemo, key)) {
          setEffortDyn({ key, value: effortsMemo[key] })
          return undefined
        }
        let cancelled = false
        void (async () => {
          // fetchEfforts 自带进程级记忆；这里只为拿它回来渲染。
          const found = await fetchEfforts(selProvider, selModel)
          if (!cancelled) setEffortDyn({ key, value: found })
        })()
        return () => {
          cancelled = true
        }
      }, [selected, selProvider, selModel])

      const edit = (mutate) => {
        setDraft((prev) => {
          const next = {
            routes: { ...prev.routes },
            gate: prev.gate,
            audit: prev.audit,
            warnOnTurnEnd: prev.warnOnTurnEnd,
            declarationThreshold: prev.declarationThreshold,
            logDir: prev.logDir,
            roleColors: { ...prev.roleColors },
            // C 区块四个显示字段同样是草稿：漏掉这几个键会让面板改动「点了没反应」。
            dockCardVisible: prev.dockCardVisible,
            dockRows: prev.dockRows,
            dockFold: prev.dockFold,
            dockColumns: { ...prev.dockColumns },
          }
          for (const key of Object.keys(prev.routes)) next.routes[key] = { ...prev.routes[key] }
          mutate(next)
          return next
        })
        setDirty(true)
        setFailed(null)
      }

      const invalid = draftInvalid(draft)

      const save = async () => {
        if (scope === null || invalid !== null) return
        // 先占住按钮再查档位：查询在飞时按钮已是「保存中…」+ 禁用，连点不会重复提交。
        setSaving(true)
        setFailed(null)
        try {
          // 全量保存前把七个角色的档位查齐（已缓存的直接命中，不额外发请求）再判定。
          await ensureEffortsKnown(ROLE_ROWS.map((row) => draft.routes[row.key]))
          // 查回来的 advertised 档位可能推翻保存前的那一判（effortInvalid 读的就是这份缓存）：
          // 这时重渲染会把原因标红写在页脚、保存按钮转回禁用 —— 不再有「点了毫无反应」。
          if (draftInvalid(draft) !== null) return
          // revision 栅栏：卡片加载后被外部改过，这次保存会被拒绝，而不是覆盖新值。
          await scope.mutate(opsFromDraft(draft), snapshot === null ? undefined : snapshot.revision)
          setDirty(false)
          await refreshCheck()
        } catch (error) {
          setFailed(error && error.message ? error.message : String(error))
        } finally {
          setSaving(false)
        }
      }

      // 编辑视图的保存：只写当前这一行的四个路由字段 + 这一个角色的标记色，不碰开关与其他角色。
      const saveRole = async (rowKey) => {
        if (scope === null) return
        // 同上：档位查询在飞时按钮必须是禁用的。
        setSaving(true)
        setFailed(null)
        try {
          // 保存前查齐档位（缓存命中就不发请求），再判定 —— 选错档位在这里被拦，
          // 拦下后重渲染会把 roleInvalid 的原话标红写在保存栏。
          await ensureEffortsKnown([draft.routes[rowKey]])
          if (roleInvalid(rowKey, draft.routes[rowKey]) !== null) return
          // 只写这一行：落盘后能标干净的也只有这一行。整份草稿标干净是错的 ——
          // 列表页改过的 B/C 开关、行数还挂在草稿里，那会让下面的跟随刷新拿快照
          // 把它们一起回滚掉（改动无声消失）。这里只把当前行排除在比对之外。
          await scope.mutate(opsFromRole(rowKey, draft.routes[rowKey], draft.roleColors[rowKey]), snapshot === null ? undefined : snapshot.revision)
          setDirty(!draftIsSaved(draft, snapshot === null ? null : snapshot.value, rowKey))
          await refreshCheck()
        } catch (error) {
          setFailed(error && error.message ? error.message : String(error))
        } finally {
          setSaving(false)
        }
      }

      const probeRoles = async () => {
        setProbing(true)
        setProbe(null)
        const result = await fetchSelfCheck()
        if (result.ok !== true) {
          setProbe({ ok: false, message: `自检不可用，无法探测：${result.message}` })
          setProbing(false)
          return
        }
        const missing = result.value.roles.filter((r) => !r.registered).map((r) => r.tool)
        setProbe(
          missing.length === 0
            ? { ok: true, message: `七个角色工具均已注册：${result.value.roles.map((r) => r.tool).join(' / ')}` }
            : { ok: false, message: `以下角色工具未注册：${missing.join(' / ')}` },
        )
        setProbing(false)
      }

      const status = snapshot === null ? 'unavailable' : snapshot.status
      const disabled = status !== 'ready' || snapshot === null || snapshot.writable !== true

      const header = isSection
        ? h(
          'div',
          { className: 'dshcm-header' },
          h(
            'span',
            { className: 'dshcm-headText' },
            h('span', { className: 'dshcm-name' }, '协作模式'),
            h(
              'span',
              { className: 'dshcm-description' },
              '按角色指定子智能体的模型与推理强度，并查看插件是否真的生效',
            ),
          ),
          dirty ? h('span', { className: 'dshcm-pending' }, '未保存') : null,
        )
        : h(
        'button',
        { type: 'button', className: 'dshcm-header', onClick: () => setOpen((v) => !v) },
        h(
          'span',
          { className: 'dshcm-headText' },
          h('span', { className: 'dshcm-name' }, '协作模式'),
          h(
            'span',
            { className: 'dshcm-description' },
            '按角色指定子智能体的模型与推理强度，并查看插件是否真的生效',
          ),
        ),
        dirty ? h('span', { className: 'dshcm-pending' }, '未保存') : null,
        h('span', { className: 'dshcm-chevron' + (open ? ' dshcm-chevronOpen' : '') }, '▾'),
      )

      if (!isSection && !open) {
        return h('li', { className: 'dshcm-card' }, header)
      }

      const body = []

      /* 面板顶的新版本横幅：宿主自检的 `updateInfo.behind` 为真才渲染（远端拿不到即 false，
         离线的正常态不占位）。纯展示：无按钮、无写入 —— 更新动作由用户自己 git pull + 重启。 */
      const update = check !== null && check.ok === true ? check.value.updateInfo : null
      if (update !== null && update !== undefined && update.behind === true) {
        body.push(
          h(
            'div',
            { className: 'dshcm-behind', key: 'update' },
            `有新版本 ${update.remote}（本地 ${update.local}），git pull + 重启 dsh web 后生效。`,
          ),
        )
      }

      // 命名空间不可用时给出可读原因，不白屏（验收标准 6）。
      if (status !== 'ready') {
        body.push(
          h(
            'div',
            { className: 'dshcm-block', key: 'status' },
            h(
              'p',
              { className: 'dshcm-error' },
              status === 'loading'
                ? '正在等待宿主侧提供 collab-mode 设置命名空间…'
                : '宿主侧没有提供 collab-mode 设置命名空间，因此这里没有可编辑项。',
            ),
            h(
              'p',
              { className: 'dshcm-note' },
              '常见原因：插件未启用、宿主半侧加载失败，或当前连接把偏好留在浏览器进程内（memory 模式不可写）。',
            ),
          ),
        )
      }

      // A 区块：角色路由 —— ZCode 子智能体页同款两视图（列表 / 编辑），语义按 DSH。
      // 自检 enrichment：描述/颜色/工具/人设全文只读展示；模型目录给编辑页下拉用。
      const liveRoles = check !== null && check.ok === true && Array.isArray(check.value.roles) ? check.value.roles : null
      const liveByKey = (key) => (liveRoles === null ? undefined : liveRoles.find((r) => r.key === key))
      const catalog = check !== null && check.ok === true && check.value.modelCatalog !== undefined && check.value.modelCatalog !== null
        ? check.value.modelCatalog
        : null
      const useCatalog = catalog !== null && Array.isArray(catalog.providers) && catalog.providers.length > 0

      const q = query.trim().toLowerCase()
      const visibleRows = ROLE_ROWS.filter((row) => {
        if (q === '') return true
        const live = liveByKey(row.key)
        const hay = `${row.key} ${row.label} ${live !== undefined && live.description ? live.description : ''}`.toLowerCase()
        return hay.includes(q)
      })

      // 模型路由：等宽半粗体正文（行内主角，不套 pill）；继承会话用灰字降噪；
      // 推理强度后缀更淡一档 —— 每行都有 @max，全黑就成噪音了。
      const routeNode = (row) => {
        const live = liveByKey(row.key)
        if (live === undefined) return h('span', { className: 'dshcm-routeDim' }, '…')
        if (live.provider === '' && live.model === '') return h('span', { className: 'dshcm-routeDim' }, '继承会话')
        const main = `${live.provider === '' ? '?' : live.provider}/${live.model === '' ? '?' : live.model}`
        if (!live.reasoningEffort) return h('span', { className: 'dshcm-route' }, main)
        return h('span', null, h('span', { className: 'dshcm-route' }, main), h('span', { className: 'dshcm-effort' }, ` @${live.reasoningEffort}`))
      }
      // 行尾：正常时只有 11px 灰字计数；未注册红字警告 —— 行上唯一的 pill。
      const toolsSide = (row) => {
        const live = liveByKey(row.key)
        if (live === undefined) return h('span', { className: 'dshcm-tools' }, '…')
        if (!live.registered) return h('span', { className: 'dshcm-tag dshcm-tagRo' }, '未注册')
        const n = Array.isArray(live.tools) ? live.tools.length : 0
        return h('span', { className: 'dshcm-tools' }, n > 0 ? `${n} 工具` : '')
      }
      const rowDesc = (row) => {
        const live = liveByKey(row.key)
        if (live === undefined) return '自检加载中…'
        return live.description !== '' ? live.description : '（暂无描述）'
      }
      // 列表色点读的是**已保存**的配色（命名空间快照），所以编辑页保存后这里跟着变；
      // 归一化与运行面同一份口径（缺项/非法回落出厂默认，行不丢色点）。
      const savedColors = roleColorsFrom(snapshot !== null && snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value.roleColors : null)
      const rowDot = (row) => {
        const color = roleColorName(savedColors, row.key)
        return h('span', { className: 'dshcm-dot', style: { background: COLOR_HEX[color] || 'var(--dsw-alias-label-dimmed)' } })
      }

      // 列表视图：7 行（色点 + 名称 + 模型 chip + 工具计数 + 描述），点行进编辑。
      const listBlock = h(
        'div',
        { className: 'dshcm-block', key: 'roles' },
        h('span', { className: 'dshcm-blockTitle' }, 'A. 角色路由'),
        h('p', { className: 'dshcm-count' }, `共 ${ROLE_ROWS.length} 个角色，点一行进入编辑`),
        h('input', {
          className: 'dshcm-input',
          value: query,
          placeholder: '搜索角色…',
          disabled,
          onChange: (e) => setQuery(e.target.value),
        }),
        h(
          'div',
          { className: 'dshcm-list' },
          ...visibleRows.map((row) =>
            h(
              'button',
              { type: 'button', className: 'dshcm-rowBtn', key: row.key, disabled, onClick: () => setSelected(row.key) },
              rowDot(row),
              h(
                'span',
                { className: 'dshcm-rowMain' },
                h(
                  'span',
                  { className: 'dshcm-rowTop' },
                  h('span', { className: 'dshcm-roleName' }, row.label),
                  routeNode(row),
                ),
                h('span', { className: 'dshcm-rowDesc' }, rowDesc(row)),
              ),
              h(
                'span',
                { className: 'dshcm-rowSide' },
                toolsSide(row),
                h('span', { className: 'dshcm-go' }, '›'),
              ),
            ),
          ),
        ),
      )

      /** 下拉框的选项（含"继承默认"首项；目录里没有的旧值标"失效"警示）。 */
      const staleTag = '（失效，目录无此项）'
      const staleKey = 'stale'
      const staleOf = (value) => ({ value: staleKey, label: `${value}${staleTag}` })
      const isStale = (value) => value === staleKey
      /**
       * 下拉的选中值。占位项只在「当前值不在目录/档位名单里」时才由 staleOf 追加
       * （见三个 options 函数），所以「选项里有占位项」等价于「当前值已失效」——
       * 这时选中的必须是那一项本身（红字，见 CSS 的 option[value="stale"]）。
       * 旧写法拿当前值和字面量 'stale' 比，永远不成立，于是选中值落在目录里没有的
       * 真值上，下拉框整个空白 —— 这一处就是那个缺口的修复。
       */
      const selectValue = (current, options) => (options.some((o) => o.value === staleKey) ? staleKey : current)
      const providerOptions = (current) => {
        const opts = [{ value: '', label: '继承默认' }]
        if (useCatalog) {
          for (const p of catalog.providers) {
            opts.push({ value: p.id, label: p.name === p.id ? p.id : `${p.name}（${p.id}）` })
          }
        }
        if (current !== '' && !opts.some((o) => o.value === current)) opts.push(staleOf(current))
        return opts
      }
      const modelOptions = (provider, current) => {
        const opts = [{ value: '', label: '继承默认' }]
        const seen = new Set([''])
        const pushAll = (models) => {
          for (const m of models) {
            if (m === null || typeof m !== 'object' || typeof m.id !== 'string' || seen.has(m.id)) continue
            seen.add(m.id)
            opts.push({ value: m.id, label: m.name === m.id ? m.id : `${m.name}（${m.id}）` })
          }
        }
        if (useCatalog) {
          if (provider === '') {
            for (const p of catalog.providers) if (Array.isArray(p.models)) pushAll(p.models)
          } else {
            const hit = catalog.providers.find((x) => x.id === provider)
            if (hit !== undefined && Array.isArray(hit.models)) pushAll(hit.models)
          }
        }
        if (current !== '' && !seen.has(current)) opts.push(staleOf(current))
        return opts
      }
      /** 推理强度选项：EFFORTS 全集 + 目录外旧值标"失效"（如下拉里没有 max 但草稿是 max）。 */
      const effortOptions = (current) => {
        const opts = EFFORTS.map((effort) => ({ value: effort, label: effort === '' ? '（继承）' : effort }))
        if (current !== '' && !opts.some((o) => o.value === current)) opts.push(staleOf(current))
        return opts
      }
      /**
       * 推理强度下拉：有 advertised 档位就按模型的来（默认档标出），
       * 否则回退静态全集。首项永远是"继承"，已存旧值粘滞保留。
       */
      const effortSelect = (rowKey, route, dyn) => {
        const current = route.reasoningEffort
        let options
        if (dyn === null || dyn.value === null) {
          options = effortOptions(current)
        } else {
          options = [{ value: '', label: '（继承）' }]
          const seen = new Set([''])
          for (const e of dyn.value.efforts) {
            if (e === null || typeof e !== 'object' || typeof e.id !== 'string' || seen.has(e.id)) continue
            seen.add(e.id)
            const label = e.id === dyn.value.defaultEffort && dyn.value.defaultEffort !== ''
              ? `${e.name || e.id}（默认）`
              : (e.name && e.name !== e.id ? `${e.name}（${e.id}）` : e.id)
            options.push({ value: e.id, label })
          }
          if (current !== '' && !seen.has(current)) options.push(staleOf(current))
        }
        return h(
          'div',
          { className: 'dshcm-field' },
          h('span', { className: 'dshcm-label' }, '推理强度'),
          h(
            'select',
            {
              className: 'dshcm-select',
              // 失效占位项不可提交：选它等于什么都没选（守卫在 onChange 里）。
              value: selectValue(current, options),
              disabled,
              onChange: (e) => {
                if (isStale(e.target.value)) return
                edit((next) => {
                  next.routes[rowKey].reasoningEffort = e.target.value
                })
              },
            },
            ...options.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
          ),
        )
      }
      const selectField = (labelText, value, options, onPick) =>
        h(
          'div',
          { className: 'dshcm-field' },
          h('span', { className: 'dshcm-label' }, labelText),
          h(
            'select',
            {
              className: 'dshcm-select',
              // 失效占位项不可提交：选它等于什么都没选（守卫在 onPick 里）。
              value: selectValue(value, options),
              disabled,
              onChange: (e) => {
                if (isStale(e.target.value)) return
                onPick(e.target.value)
              },
            },
            ...options.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
          ),
        )
      const textField = (labelText, value, placeholderText, onType) =>
        h(
          'div',
          { className: 'dshcm-field' },
          h('span', { className: 'dshcm-label' }, labelText),
          h('input', { className: 'dshcm-input', value, placeholder: placeholderText, disabled, onChange: (e) => onType(e.target.value) }),
        )
      // 模型字段：有目录就"供应商 → 模型"两级下拉，否则回退原来的文本输入。
      const routeModelControls = (rowKey, route) => {
        if (!useCatalog) {
          return [
            textField('供应商', route.provider, '留空 = 继承会话', (v) => edit((next) => { next.routes[rowKey].provider = v })),
            textField('模型', route.model, '留空 = 继承会话', (v) => edit((next) => { next.routes[rowKey].model = v })),
          ]
        }
        return [
          selectField('供应商', route.provider, providerOptions(route.provider), (v) => edit((next) => {
            // 供应商一切换，旧模型必然是幽灵组合（大小写错位如 kimi-k3 vs KIMI-K3）——
            // 直接清空逼重选，不给误导活路。这是"幽灵组合误导"事故的源头修复。
            next.routes[rowKey].provider = v
            next.routes[rowKey].model = ''
            next.routes[rowKey].reasoningEffort = ''
          })),
          selectField('模型', route.model, modelOptions(route.provider, route.model), (v) => edit((next) => { next.routes[rowKey].model = v })),
        ]
      }

      // 编辑视图：名称/颜色/描述/工具/人设全文只读，模型+推理强度+maxTokens 可改。
      const editBlock = (rowKey) => {
        const found = ROLE_ROWS.find((r) => r.key === rowKey)
        const row = found === undefined ? ROLE_ROWS[0] : found
        const route = draft.routes[row.key]
        const live = liveByKey(row.key)
        const perInvalid = roleInvalid(row.key, route)
        // 当前标记色：读草稿里的配置值（缺项/非法在草稿构造时已回落出厂默认）。
        const colorName = roleColorName(draft.roleColors, row.key)
        const deniedList = live !== undefined && Array.isArray(live.denied) ? live.denied : []
        return h(
          'div',
          { className: 'dshcm-block', key: `edit-${row.key}` },
          h(
            'div',
            { className: 'dshcm-crumb' },
            h('button', { type: 'button', className: 'dshcm-back', onClick: () => setSelected(null) }, '‹ 返回列表'),
            h('span', null, `协作模式 ＞ ${row.label}`),
          ),
          h(
            'div',
            { className: 'dshcm-grid' },
            h('div', { className: 'dshcm-field' }, h('span', { className: 'dshcm-label' }, '名称'), h('span', { className: 'dshcm-static' }, row.label)),
            h(
              'div',
              { className: 'dshcm-field' },
              h('span', { className: 'dshcm-label' }, '颜色标记'),
              h(
                'span',
                { className: 'dshcm-colorOnce' },
                h('span', { className: 'dshcm-dot', style: { background: COLOR_HEX[colorName] || 'var(--dsw-alias-label-dimmed)' } }),
                h('span', { className: 'dshcm-static' }, colorName === '' ? '（未知）' : colorName),
              ),
              // 8 色点选：点一下即改草稿（当前选中打亮），保存时随这一行的路由一起落盘。
              h(
                'div',
                { className: 'dshcm-colorRow' },
                ...COLOR_NAMES.map((name) =>
                  h('button', {
                    key: name,
                    type: 'button',
                    title: name,
                    className: name === colorName ? 'dshcm-swatch dshcm-swatchOn' : 'dshcm-swatch dshcm-swatchOff',
                    style: { background: COLOR_HEX[name] },
                    disabled,
                    onClick: () => edit((next) => {
                      next.roleColors[row.key] = name
                    }),
                  }),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dshcm-grid' },
            ...routeModelControls(row.key, route),
            effortSelect(row.key, route, selected === row.key ? effortDyn : null),
            h(
              'div',
              { className: 'dshcm-field' },
              h('span', { className: 'dshcm-label' }, 'maxTokens'),
              h('input', {
                className: 'dshcm-input',
                value: route.maxTokens,
                placeholder: '留空 = 继承',
                inputMode: 'numeric',
                disabled,
                onChange: (e) => edit((next) => {
                  next.routes[row.key].maxTokens = e.target.value
                }),
              }),
            ),
          ),
          h('div', { className: 'dshcm-field' }, h('span', { className: 'dshcm-label' }, '描述'), h('span', { className: 'dshcm-static' }, live !== undefined && live.description !== '' ? live.description : '（暂无描述）')),
          h(
            'div',
            { className: 'dshcm-field' },
            h('span', { className: 'dshcm-label' }, '可用工具'),
            row.writable
              ? h('p', { className: 'dshcm-note' }, '全部工具：可写角色不受 toolFilter 限制。')
              : h(
                'span',
                { className: 'dshcm-rowTop' },
                ...(deniedList.length > 0
                  ? deniedList.map((t) => h('span', { key: t, className: 'dshcm-tag dshcm-tagRo' }, t))
                  : [h('span', { key: 'unknown', className: 'dshcm-tag' }, '只读')]
                )),
            row.writable ? null : h('p', { className: 'dshcm-note' }, '以上工具被 toolFilter.deny 摘除，只读角色不可改。'),
          ),
          h(
            'div',
            { className: 'dshcm-field' },
            h('span', { className: 'dshcm-label' }, '系统提示词（只读）'),
            live !== undefined && live.persona !== ''
              ? h('pre', { className: 'dshcm-pre' }, live.persona)
              : h('p', { className: 'dshcm-note' }, '自检不可用时无法显示。人设正文的单一来源是仓库 content/roles/*.md，这里不提供编辑。'),
          ),
          h(
            'div',
            // 编辑视图的保存栏不贴底：它后面还跟着 B/C 与总保存栏，sticky 在这里
            // 零行程（父块到它就结束了），贴了也盖不住后面，不如不贴；
            // 它紧贴着编辑字段走，正常滚屏永远看得见。
            { className: 'dshcm-footer' },
            h(
              'span',
              { className: perInvalid === null ? 'dshcm-note' : 'dshcm-error' },
              perInvalid !== null ? perInvalid : failed !== null ? `保存失败：${failed}` : dirty ? '有未保存的修改' : '与宿主一致',
            ),
            h(
              'div',
              { className: 'dshcm-footerRight' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshcm-btn dshcm-discard',
                  disabled: !dirty || saving,
                  onClick: () => {
                    setDraft(draftFromValue(snapshot === null ? null : snapshot.value))
                    setDirty(false)
                    setFailed(null)
                  },
                },
                '放弃修改',
              ),
              h(
                'button',
                { type: 'button', className: 'dshcm-btn dshcm-save', disabled: disabled || !dirty || saving || perInvalid !== null, onClick: () => void saveRole(row.key) },
                saving ? '保存中…' : '保存',
              ),
            ),
          ),
        )
      }

      if (selected === null) {
        body.push(listBlock)
      } else {
        body.push(editBlock(selected))
      }

      if (selected === null) {
      // B 区块：纪律开关（只在列表视图展示，编辑视图只改当前行）。
      body.push(
        h(
          'div',
          { className: 'dshcm-block', key: 'switches' },
          h('span', { className: 'dshcm-blockTitle' }, 'B. 纪律开关'),
          h(
            'label',
            { className: 'dshcm-switch' },
            h('input', {
              type: 'checkbox',
              checked: draft.gate,
              disabled,
              onChange: (e) => edit((next) => {
                next.gate = e.target.checked
              }),
            }),
            '改动前拦截（tools/pre-execute）',
          ),
          h(
            'label',
            { className: 'dshcm-switch' },
            h('input', {
              type: 'checkbox',
              checked: draft.audit,
              disabled,
              onChange: (e) => edit((next) => {
                next.audit = e.target.checked
              }),
            }),
            '工具调用审计（tools/post-execute）',
          ),
          h(
            'label',
            { className: 'dshcm-switch' },
            h('input', {
              type: 'checkbox',
              checked: draft.warnOnTurnEnd,
              disabled,
              onChange: (e) => edit((next) => {
                next.warnOnTurnEnd = e.target.checked
              }),
            }),
            '轮次结束告警（agent/turn-stopping）',
          ),
          h(
            'div',
            { className: 'dshcm-grid' },
            h(
              'div',
              { className: 'dshcm-field' },
              h('span', { className: 'dshcm-label' }, '未声明文件阈值'),
              h('input', {
                className: 'dshcm-input',
                value: draft.declarationThreshold,
                inputMode: 'numeric',
                disabled,
                onChange: (e) => edit((next) => {
                  next.declarationThreshold = e.target.value
                }),
              }),
            ),
            h(
              'div',
              { className: 'dshcm-field' },
              h('span', { className: 'dshcm-label' }, '审计日志目录'),
              h('input', {
                className: 'dshcm-input',
                value: draft.logDir,
                placeholder: '留空 = $DSH_HOME/hooks',
                disabled,
                onChange: (e) => edit((next) => {
                  next.logDir = e.target.value
                }),
              }),
            ),
          ),
        ),
      )

      // C 区块：拆两组 —— 上组「运行卡显示」（可写），下组「运行状态」默认折叠
      // （自检 JSON/审计目录/最近审计/各角色生效路由/刷新与探测两个按钮都装在里面）。
      // 运行卡设置放这里是因为它是「显示多少/显示什么」的取舍，与 C 区块一样属于
      // 运行时观察面，不占 A/B 的可编辑命名空间。
      body.push(
        h(
          'div',
          { className: 'dshcm-block', key: 'runsCard' },
          h('span', { className: 'dshcm-blockTitle' }, 'C. 自检'),
          h(RunsCardRow, {
            draft,
            disabled,
            onChange: edit,
          }),
        ),
      )

      body.push(
        h(
          'div',
          { className: 'dshcm-block', key: 'selfcheck' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshcm-foldToggle',
              'aria-expanded': selfDetailsOpen,
              onClick: () => setSelfDetailsOpen((v) => !v),
            },
            h('span', { className: 'dshcm-blockTitle' }, '运行状态'),
            h('span', { className: 'dshcm-chevron dshcm-chevronFold' + (selfDetailsOpen ? ' dshcm-chevronOpen' : '') }, '▾'),
          ),
          selfDetailsOpen
            ? h(SelfCheckBlock, {
              check,
              loading: loadingCheck,
              onRefresh: () => void refreshCheck(),
              busy: disabled,
              probing,
              onProbe: () => void probeRoles(),
              probe,
            })
            : null,
        ),
      )

      // 页脚：保存 / 放弃。
      body.push(
        h(
          'div',
          { className: 'dshcm-footer', key: 'footer' },
          h(
            'span',
            { className: invalid === null ? 'dshcm-note' : 'dshcm-error' },
            invalid !== null ? invalid : failed !== null ? `保存失败：${failed}` : dirty ? '有未保存的修改' : '与宿主一致',
          ),
          h(
            'div',
            { className: 'dshcm-footerRight' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshcm-btn dshcm-discard',
                disabled: !dirty || saving,
                onClick: () => {
                  setDraft(draftFromValue(snapshot === null ? null : snapshot.value))
                  setDirty(false)
                  setFailed(null)
                },
              },
              '放弃修改',
            ),
            h(
              'button',
              { type: 'button', className: 'dshcm-btn dshcm-save', disabled: disabled || !dirty || saving || invalid !== null, onClick: () => void save() },
              saving ? '保存中…' : '保存',
            ),
          ),
        ),
      )
      }

      if (isSection) {
        return h('div', { className: 'dshcm-card dshcm-cardOpen' }, header, h('div', { className: 'dshcm-body' }, ...body))
      }

      return h('li', { className: 'dshcm-card dshcm-cardOpen' }, header, h('div', { className: 'dshcm-body' }, ...body))
    }

    /**
     * 服务依赖。
     *
     * ⚠ `settingsScope` **必须**列在这里，不能靠 `ctx.get()` 一次性读取：
     * Cordis 的 `ctx.get(name)` 不参与依赖等待（`ServiceRegistry.notify` 只对
     * 出现在 `fiber.inject` 里的名字重评估 fiber）。服务若晚于本插件就绪，
     * 一次性读取就永远拿到 `undefined`，卡片锁死在降级态 —— v0.2.0 的面板
     * 不可编辑就是这个原因。
     *
     * 代价：`settingsScope` 缺席时整个客户端插件不加载、面板不出现。
     * 保留 settingsScope 硬依赖，因为 scope.bind 仍需要它：命名空间级降级
     * （宿主未服务该 ns / memory 模式不可写）仍由卡片内
     * `status !== 'ready'` 分支给出可读原因。
     */
    const inject = ['slots', 'settingsScope']

    function apply(ctx) {
      // inject 满足后 Cordis 才调 apply，此时服务必定可用。
      const scope = ctx.settingsScope.bind({ namespace: NS })

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'collab-mode',
            order: 79,
            label: '协作模式',
            inject: () => ({ scope, asSection: true }),
          },
          CollabModeCard,
        ),
      )

      // 软依赖注册：走 `ctx.inject`（离线夹具的 ctx 没有它，因此那里的「恰好一个
      // 槽位注册」断言不受影响）。注册用外层 `ctx.slots`（`inject` 数组里的硬依赖，
      // `apply` 跑起来时必定可用）。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['slots'], () => {
          // 输入框上方原位的运行卡（面板 C 区块的总开关控制整卡是否渲染）。
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register({ name: 'conversation.input.dock', id: 'collab-mode-runs', order: 90 }, RoleRunDock),
          )

          // 右栏：`sidebar.right.pane.tab` 契约走两阶段。
          //   1. 类型：`ctx.sidebarRightTabs.register({ id, kind, title, guide })`
          //      —— id 同时是正文与标题两个 keyed 座位的键；`title` 的签名是
          //      `(address: string) => string`（tab-registry 的契约）；guide 给引导页
          //      一个胶囊入口（没有它，右栏在没有 tab 时打开的是引导页，用户无从点进
          //      这个类型）。
          //   2. 正文与标题：两个 keyed 座位各注册一次，同键同体。
          //
          // ⚠ 类型注册必须等 `sidebarRightTabs` 到位，不能直接用 `ctx.sidebarRightTabs`：
          // 该服务由 `@deepseek-ai/dsh-client-ui-sidebar-right` 在它自己的 apply 里
          // `ctx.reflect.provide("sidebarRightTabs", tabs)` 提供，晚于本插件就绪，
          // 一次性读取拿到 undefined，注册被静默跳过 —— 结果只剩两个 keyed 座位的键
          // 空转，宿主对没有在册类型的 kind 渲染「nothing can view」，右栏什么都不显示。
          // 这里照 `slots` 的先例用 `ctx.inject(['sidebarRightTabs'], ...)` 等它，
          // 注册仍包在 `ctx.effect` 里拿回 disposer（服务卸载时类型跟着撤）。
          // 服务始终没到（老版本 / 该包未装载）时整段不跑，dock 卡照常。
          ctx.inject(['sidebarRightTabs'], (tabsCtx) => {
            // 服务从注入回调的参数上取（照宿主 index.js 的 settingsCtx/serverCtx 先例），
            // 根 ctx 属性与 ctx.get 只作兜底。
            const resolve = makeResolver(tabsCtx, ctx)
            const tabs = resolve('sidebarRightTabs')
            const effect = typeof (tabsCtx !== null && tabsCtx !== undefined ? tabsCtx.effect : undefined) === 'function' ? tabsCtx.effect : ctx.effect
            if (typeof effect === 'function' && tabs !== undefined && tabs !== null) {
              effect(() =>
                tabs.register({
                  id: RUNS_TAB_ID,
                  kind: RUNS_TAB_KIND,
                  title: () => RUNS_TAB_LABEL,
                  guide: [
                    {
                      order: 60,
                      title: () => RUNS_TAB_LABEL,
                      description: () => '本会话的子智能体运行行（与对话窗口运行卡同一份数据）',
                    },
                  ],
                }),
              )
              // 类型在册了才谈「把 tab 切出来」：kind 没注册时 openTab 自己会抛。
              openRunsTabAfterRegister(resolve)
            }
          })
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: RUNS_TAB_ID, inject: (sessionId) => ({ sessionId }) },
              RunsPane,
            ),
          )
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab.title', key: RUNS_TAB_ID, inject: (sessionId) => ({ sessionId }) },
              RunsPaneTitle,
            ),
          )
          // 跳转服务软依赖：sessions 是宿主核心面，到了就收下做按钮；不到（老版本）
          // 整段跳过，行只少个按钮，其他照常。组件靠 2s 轮询重渲染，服务晚到也能补上。
          ctx.inject(['sessions'], (sctx) => {
            const fromArg = sctx !== null && sctx !== undefined ? sctx.sessions : undefined
            takeSessionsService(fromArg)
            if (sessionsSvc === null && ctx !== null && ctx !== undefined) takeSessionsService(ctx.sessions)
          })
        })
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
