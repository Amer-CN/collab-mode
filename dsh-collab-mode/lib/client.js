/**
 * dsh-collab-mode —— 浏览器半侧。
 *
 * 只做一件事：把「协作模式」卡片注册进官方插槽 `settings.plugin.item`，
 * key 等于本插件的 settings 命名空间 `collab-mode`。
 *
 * 两份账本都齐才会渲染（`@deepseek-ai/dsh-client-ui-settings-plugins` 的设计）：
 *   Host 侧注册了 `collab-mode` 命名空间（见 lib/index.js 的 installSection），
 *   浏览器侧在 `settings.plugin.item` 上注册 key 为该命名空间的卡片。
 * 任一缺失时官方标签页什么都不渲染 —— 所以本卡片的「找不到条目」降级文案是
 * 卡片自己内部的可读提示，而不是指望标签页兜底。
 *
 * 数据通道：
 *   A/B 区块的读写走原生 client settings scope（`ctx.settingsScope.bind`），
 *   不经过自建 HTTP bridge —— 与 dsh-free-search 的取舍不同，那个插件写于
 *   settingsScope 可用之前。C 区块的运行时自检走宿主侧的一条只读路由
 *   `/api/collab-mode/selfcheck`（Host 半侧用 webServer.register 提供）。
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

    /** 推理强度枚举，来自 dsh-tool-subagent 的 agentOptions.reasoningEffort。 */
    const EFFORTS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

    const CSS = [
      '.dshcm-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;min-width:0;list-style:none;transition:border-color .16s,background .16s;overflow:hidden;margin-bottom:8px}',
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
      '.dshcm-role{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}',
      '.dshcm-roleHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshcm-roleName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.dshcm-tag{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary);white-space:nowrap;border-radius:999px;padding:1px 6px;font-size:11px}',
      '.dshcm-tagRo{background:rgba(240,170,80,.15);color:#f0b060;border:1px solid rgba(240,170,80,.3)}',
      '.dshcm-tagOk{background:rgba(80,200,120,.15);color:#7ddb9c;border:1px solid rgba(80,200,120,.3)}',
      '.dshcm-grid{display:flex;gap:8px;flex-wrap:wrap}',
      '.dshcm-field{flex-direction:column;gap:3px;min-width:0;display:flex;flex:1 1 150px}',
      '.dshcm-label{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dshcm-input,.dshcm-select{border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border-radius:6px;padding:5px 7px;font-size:13px;width:100%;box-sizing:border-box}',
      '.dshcm-select{color-scheme:light dark}',
      '.dshcm-select option,.dshcm-select optgroup{background-color:#fff;color:#1f2328}',
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
      '.dshcm-self{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:5px}',
      '.dshcm-selfRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshcm-mono{font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary)}',
      '.dshcm-roleDef{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}',
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

    /** 一个空草稿：七个角色都留空（= 继承父会话路由）+ 三个开关默认开 + 阈值 3。 */
    function emptyDraft() {
      const routes = {}
      for (const row of ROLE_ROWS) {
        routes[row.key] = { provider: '', model: '', reasoningEffort: '', maxTokens: '' }
      }
      return { routes, gate: true, audit: true, warnOnTurnEnd: true, declarationThreshold: '3', logDir: '' }
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
      return ops
    }

    /** 草稿里数值字段是否可解析；不可解析就阻塞保存而不是悄悄改写用户输入。 */
    function draftInvalid(draft) {
      const threshold = Number(draft.declarationThreshold)
      if (!Number.isInteger(threshold) || threshold < 1) return '「未声明文件阈值」必须是 ≥1 的整数'
      for (const row of ROLE_ROWS) {
        const maxTokens = draft.routes[row.key].maxTokens.trim()
        if (maxTokens !== '' && !(Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0)) {
          return `角色 ${row.label} 的 maxTokens 必须是正数，或留空`
        }
      }
      return null
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

    /** 一张只读的键值行。 */
    function selfRow(label, text) {
      return h('div', { className: 'dshcm-selfRow' }, h('span', null, label), h('span', { className: 'dshcm-mono' }, text))
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
            : `${v.lastAudit.ts} · ${v.lastAudit.tool} · ${v.lastAudit.ok ? 'ok' : 'failed'} · ${v.lastAudit.latency}ms`,
        ),
        h(
          'div',
          { className: 'dshcm-selfRow' },
          h('span', null, '各角色实际生效路由：'),
          ...v.roles.map((role) =>
            h(
              'span',
              { key: role.key, className: role.registered ? 'dshcm-tag dshcm-tagOk' : 'dshcm-tag' },
              `${role.tool} = ${role.provider === '' && role.model === '' ? '继承会话' : `${role.provider || '?'}/${role.model || '?'}${role.reasoningEffort ? ` @${role.reasoningEffort}` : ''}`}`,
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshcm-footer' },
          h('button', { type: 'button', className: 'dshcm-btn dshcm-discard', onClick: onRefresh, disabled: busy }, '刷新自检'),
          h('button', { type: 'button', className: 'dshcm-btn dshcm-discard', onClick: onProbe, disabled: busy || props.probing }, props.probing ? '探测中…' : '探测七个角色'),
        ),
        probe === null ? null : h('p', { className: probe.ok ? 'dshcm-note' : 'dshcm-error' }, probe.message),
      )
    }

    /** 「协作模式」卡片本体。 */
    function CollabModeCard(props) {
      const { scope, clientCtx } = props
      const [open, setOpen] = react.useState(false)
      const [snapshot, setSnapshot] = react.useState(scope === null ? null : scope.getSnapshot())
      const [draft, setDraft] = react.useState(emptyDraft)
      const [dirty, setDirty] = react.useState(false)
      const [saving, setSaving] = react.useState(false)
      const [failed, setFailed] = react.useState(null)
      const [check, setCheck] = react.useState(null)
      const [loadingCheck, setLoadingCheck] = react.useState(false)
      const [probing, setProbing] = react.useState(false)
      const [probe, setProbe] = react.useState(null)

      // 订阅原生 scope：宿主侧写入、外部编辑 settings.yaml 都会推新快照过来。
      react.useEffect(() => {
        if (scope === null) return undefined
        setSnapshot(scope.getSnapshot())
        return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
      }, [scope])

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

      const edit = (mutate) => {
        setDraft((prev) => {
          const next = { routes: { ...prev.routes }, gate: prev.gate, audit: prev.audit, warnOnTurnEnd: prev.warnOnTurnEnd, declarationThreshold: prev.declarationThreshold, logDir: prev.logDir }
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
        setSaving(true)
        setFailed(null)
        try {
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

      const header = h(
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

      if (!open) {
        return h('li', { className: 'dshcm-card' }, header)
      }

      const body = []

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

      // A 区块：角色路由。
      const roleNodes = ROLE_ROWS.map((row) => {
        const route = draft.routes[row.key]
        const live = check !== null && check.ok === true ? check.value.roles.find((r) => r.key === row.key) : undefined
        return h(
          'div',
          { className: 'dshcm-role', key: row.key },
          h(
            'div',
            { className: 'dshcm-roleHead' },
            h('span', { className: 'dshcm-roleName' }, row.label),
            h('span', { className: 'dshcm-tag' + (row.writable ? '' : ' dshcm-tagRo') }, row.writable ? '可写' : '只读'),
            live === undefined
              ? null
              : h(
                  'span',
                  { className: live.registered ? 'dshcm-tag dshcm-tagOk' : 'dshcm-tag' },
                  live.registered
                    ? `生效：${live.provider === '' && live.model === '' ? '继承会话' : `${live.provider || '?'}/${live.model || '?'}${live.reasoningEffort ? ` @${live.reasoningEffort}` : ''}`}`
                    : '未注册',
                ),
          ),
          h(
            'div',
            { className: 'dshcm-grid' },
            h(
              'div',
              { className: 'dshcm-field' },
              h('span', { className: 'dshcm-label' }, '供应商'),
              h('input', {
                className: 'dshcm-input',
                value: route.provider,
                placeholder: '留空 = 继承会话',
                disabled,
                onChange: (e) => edit((next) => {
                  next.routes[row.key].provider = e.target.value
                }),
              }),
            ),
            h(
              'div',
              { className: 'dshcm-field' },
              h('span', { className: 'dshcm-label' }, '模型'),
              h('input', {
                className: 'dshcm-input',
                value: route.model,
                placeholder: '留空 = 继承会话',
                disabled,
                onChange: (e) => edit((next) => {
                  next.routes[row.key].model = e.target.value
                }),
              }),
            ),
            h(
              'div',
              { className: 'dshcm-field' },
              h('span', { className: 'dshcm-label' }, '推理强度'),
              h(
                'select',
                {
                  className: 'dshcm-select',
                  value: route.reasoningEffort,
                  disabled,
                  onChange: (e) => edit((next) => {
                    next.routes[row.key].reasoningEffort = e.target.value
                  }),
                },
                ...EFFORTS.map((effort) => h('option', { key: effort, value: effort }, effort === '' ? '（继承）' : effort)),
              ),
            ),
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
        )
      })

      body.push(
        h(
          'div',
          { className: 'dshcm-block', key: 'roles' },
          h('span', { className: 'dshcm-blockTitle' }, 'A. 角色路由'),
          h('p', { className: 'dshcm-note' }, '留空的字段表示该角色继承当前会话的模型路由；填了就以这里为准，保存后立即生效。'),
          ...roleNodes,
        ),
      )

      // B 区块：纪律开关。
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

      // C 区块：自检。
      body.push(
        h(
          'div',
          { className: 'dshcm-block', key: 'selfcheck' },
          h('span', { className: 'dshcm-blockTitle' }, 'C. 自检'),
          h(
            SelfCheckBlock,
            { check, loading: loadingCheck, onRefresh: () => void refreshCheck(), busy: disabled, probing, onProbe: () => void probeRoles(), probe },
          ),
        ),
      )

      // D 区块：角色定义（只读）。
      const defNodes =
        check !== null && check.ok === true
          ? check.value.roles.map((role) =>
              h(
                'div',
                { className: 'dshcm-roleDef', key: role.key },
                `${role.tool}  ·  loader 行 ${role.entryId}  ·  ${role.entryPresent ? (role.active ? '运行中' : '已建行未激活') : '未建行'}  ·  ${role.readonly ? `toolFilter.deny ${role.deniedTools} 项` : '无 toolFilter（可写）'}  ·  persona ${role.personaChars} 字符`,
              ),
            )
          : [h('p', { className: 'dshcm-note', key: 'nodef' }, '自检不可用时无法列出角色定义。')]

      body.push(
        h(
          'div',
          { className: 'dshcm-block', key: 'defs' },
          h('span', { className: 'dshcm-blockTitle' }, 'D. 角色定义（只读）'),
          h('p', { className: 'dshcm-note' }, '人设正文的单一来源是插件仓库的 content/roles/*.md，这里不提供可视化编辑，避免出现第二个内容源。'),
          ...defNodes,
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
     * 代价：`settingsScope` 缺席时整个客户端插件不加载、卡片不出现。经核实
     * 这个损失是空的：`settings.plugin.item` 插槽本身由
     * `dsh-client-ui-settings-plugins` 的 ConfigurablePluginsTab 声明，而它的
     * `inject` 也含 `settingsScope` —— 服务缺席时插槽根本不存在，卡片无处注册。
     * 命名空间级降级（宿主未服务该 ns / memory 模式不可写）仍由卡片内
     * `status !== 'ready'` 分支给出可读原因。
     */
    const inject = ['slots', 'settingsScope']

    function apply(ctx) {
      // inject 满足后 Cordis 才调 apply，此时服务必定可用。
      const scope = ctx.settingsScope.bind({ namespace: NS })

      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register(
          {
            name: 'settings.plugin.item',
            key: NS,
            id: 'dsh-collab-mode',
            // 排在 Free Search（order 120）之后。
            order: 130,
            inject: () => ({ scope, clientCtx: ctx }),
          },
          CollabModeCard,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
