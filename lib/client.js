// opencode-go-quota-pool client half：composer dock 四根 OpenCode Go 计量条（5h / 周 / 月 + 近 30 天 Usage 分模型）
// 样式：前三根与 Desktop splash.html 的流光长条同款（5px 圆角 + 渐变 fill + sheen 扫光）；
//       第四根是分段堆叠条，每段一模型一颜色，宽度 = 该模型 token / 近 30 天总 token
// 数据：host 半 /api/quota/opencode-go（60s 轮询）→ windows[] + usageMonth{models[],totalTokens}
// 悬浮：显示原版会话统计详情 + 第四根的分模型构成明细
window.__ModuleLoader__.load({
  id: 'opencode-go-quota-pool',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let React = require('react')

    // 主人定稿：说明文字固定中文（如需英文可改回 navigator 检测）
    const LANG = 'zh'
    // 2026-09-29 主人额外令：三根标题由「限额」口径改为「用量」口径（中英两侧同步，勿留旧名）
    const WINDOW_NAMES = {
      zh: { rolling: '滚动用量', weekly: '每周用量', monthly: '每月用量' },
      en: { rolling: '5-hour usage', weekly: 'Weekly usage', monthly: 'Monthly usage' }
    }
    // 第四条标题（主人定稿：使用额度 / 月度）
    const USAGE_TITLE = { zh: '使用额度', en: 'Usage' }
    // 分模型配色：与主色系同族但可区分；超出取模循环，保证任意模型数都有色
    const MODEL_COLORS = [
      '#2563eb', '#0ea5e9', '#14b8a6', '#f59e0b', '#ef4444',
      '#8b5cf6', '#ec4899', '#84cc16', '#06b6d4', '#f97316',
      '#6366f1', '#a855f7', '#10b981', '#eab308', '#d946ef'
    ]
    const colorFor = (i) => MODEL_COLORS[i % MODEL_COLORS.length]
    // 段内渐变：同色系深→浅 + 顶端高光，模仿 qb-fill 的体积感（不改变模型可辨识色相）
    function shade(hex, amt) {
      const m = /^#([0-9a-f]{6})$/i.exec(hex)
      if (!m) return hex
      const n = parseInt(m[1], 16)
      const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.max(0, Math.min(255, Math.round(c + amt))))
      return '#' + ch.map((c) => c.toString(16).padStart(2, '0')).join('')
    }
    const segFill = (hex) => 'linear-gradient(180deg,' + shade(hex, 34) + ',' + hex + ' 46%,' + shade(hex, -26) + ')';
    function formatCount(n) {
      let v
      try { v = BigInt(String(n || 0)) } catch (e) { v = 0n }
      if (v < 1000n) return v.toString()
      if (v < 1000000n) return (Number(v) / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
      if (v < 1000000000n) return (Number(v) / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M'
      return (Number(v) / 1000000000).toFixed(2).replace(/\.?0+$/, '') + 'B'
    }

    // ── 样式注入（与 splash.html 同款流光条 + 悬浮面板 + 隐藏原 stats 行）──
    const CSS = `
/* 固化 2026-08-29 + 2026-09-24/26 修正：官方 stats 监控行已从结构上被顶掉
   （client 半改占 slot id 'stats'，官方 StatsPills 不再占该格）。
   2026-10-18 主人令：官方新版又把统计拆成 activity / usage 两个 dock cell（监控条右侧的轮数与 token 计数），
   同样以结构顶替处理（见 apply 里的注册）。下面三条仅作兜底，防止官方换 id / 换属性时再冒出来。 */
[data-composer-stats]{display:none!important}
[data-composer-stat]{display:none!important}
.NnMFTq_root:has([data-composer-stats]){padding-bottom:8px!important}
/* ── 宽度：不再赌任何 CSS 公式，改为运行时实测输入框 ──
   教训（2026-09-26，已栽两次）：DSH 改版就会改 composer 的 padding / max-width / 嵌套 / margin 链，
   任何「照抄卡片公式」的做法都会在某次升级后失配（先被 G:\DSH Desktop 0.1.5-rc.1 的旧构建骗过，
   又被 0.1.7-rc.2 的 dock 新结构骗过），表现为条比输入框窄或左右缩进。
   现在改由 JS 实测 [data-composer-card]（官方稳定属性，跨版本都在）的布局宽度，
   直接把 .qb-root 的 width 钉成同一个像素值，并用 ResizeObserver 跟随输入框动态变化。
   CSS 里的 width:100% 仅作「JS 未生效/找不到卡片」时的兜底。
   另：dock 里官方上下文圆环按「带 aria-haspopup=dialog 的按钮」精确命中藏掉（环已回归输入框内部）。 */
.qb-root{display:flex;flex-direction:row;align-items:stretch;justify-content:center;gap:24px;width:100%;max-width:100%;margin:0 auto;padding:2px 0 0;box-sizing:border-box;position:relative}
/* 前三根单独成组（主人 2026-09-27 令）：轮次悬浮只挂在这组、且以这组为基准居中。
   此前 .qb-tip 挂在 .qb-root 上且 :hover 范围是整个 root，悬停第四根时它照样弹出，
   而两条 tip 的 bottom 都是 calc(100% + 6px)，于是轮次信息正好压住分模型明细。
   flex:3 不是笔误：root 下只剩「前三根组」与「第四根」两个 flex 子项，
   按 3:1 才能还原原来四根等宽（各占 1/4）；写成 1:1 会让第四根宽一倍。 */
.qb-windows{flex:3 1 0;min-width:0;display:flex;flex-direction:row;align-items:stretch;gap:24px;position:relative}
div:has(> [data-qb]) > *:not([data-qb]):has(button[aria-haspopup="dialog"]){display:none!important}
.qb-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px}
.qb-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary, #8e897b)}
/* 标题加粗：主人 2026-09-29 令，深色背景下原 tertiary 字重过细不显眼。 */
.qb-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.qb-pct{flex:none;font-variant-numeric:tabular-nums;font-weight:500;color:var(--dsw-alias-label-secondary, #77756d)}
.qb-track{position:relative;height:5px;border-radius:3px;background:rgba(0,0,0,.1);overflow:hidden}
/* 填充色回归 DeepSeek 蓝（主人 2026-09-27 令）。此前是 #9b7247→#a67d48→#b98c53 的棕色，
   与本插件自身设计约定（FIXED.md 第 2 条：与 splash.html 同款
   #1d4ed8→#3b82f6→#60a5fa）相矛盾，也与第四根 MODEL_COLORS 的蓝色系不统一。 */
.qb-fill{position:relative;height:100%;width:0%;overflow:hidden;border-radius:3px;background:linear-gradient(90deg,#1d4ed8,#3b82f6,#60a5fa);transition:width .45s cubic-bezier(.22,1,.36,1)}
.qb-sheen{position:absolute;inset:0;width:100%;pointer-events:none;background:linear-gradient(100deg,transparent 32%,rgba(255,255,255,.55) 50%,transparent 68%);animation:qb-sheen 1.6s linear infinite}
@keyframes qb-sheen{from{transform:translateX(-120%)}to{transform:translateX(140%)}}
.qb-tip{display:none;position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);z-index:120;box-sizing:border-box;padding:11px 13px;border:1px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 10%));border-radius:10px;background:var(--dsw-alias-bg-layer-1, #e8e5e1);box-shadow:var(--dsw-shadow-lv3, 0 8px 24px rgb(0 0 0 / 12%));color:var(--dsw-alias-label-secondary, #77756d);font-size:11.5px;line-height:17px;min-width:340px;max-width:min(560px,86vw)}
/* 2026-10-25 主人令：前三根的悬浮框重新排版，不用圆环。
   改成自上而下一条主线：本会话多少 → 花在哪（构成条 + 图例）→ 快不快（指标），
   高度仍收在 7 行字附近，hover 时不多盖聊天区。 */
.qb-windows:hover .qb-tip{display:flex;flex-direction:column;gap:9px}
.qb-tip-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.qb-tip-title{font-size:11px;color:var(--dsw-alias-label-tertiary, #8e897b)}
.qb-tip-total{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary, #4a4a46);font-variant-numeric:tabular-nums}
/* 构成条：与第四根同款 5px 圆角分段条，颜色与下方图例色块同源 */
.qb-tip-bar{height:5px;border-radius:3px;background:rgba(0,0,0,.1);overflow:hidden;display:flex}
.qb-tip-seg{height:100%;flex:none;transition:width .45s cubic-bezier(.22,1,.36,1)}
.qb-tip-seg+.qb-tip-seg{box-shadow:inset 1px 0 0 rgba(255,255,255,.35)}
.qb-tip-legend{display:flex;flex-wrap:wrap;gap:4px 16px}
.qb-tip-legend-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.qb-tip-dot{width:8px;height:8px;border-radius:2px;flex:none}
.qb-tip-legend-val{color:var(--dsw-alias-label-tertiary, #8e897b);font-variant-numeric:tabular-nums}
/* 指标：小标签 + 大数值，三列一行；上方细线把「构成」与「性能」分开 */
.qb-tip-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px 16px;border-top:1px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 10%));padding-top:7px}
.qb-tip-metric{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.qb-tip-metric-label{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary, #8e897b);white-space:nowrap}
.qb-tip-metric-value{font-size:12px;line-height:15px;font-weight:600;color:var(--dsw-alias-label-primary, #4a4a46);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qb-tip-empty{color:var(--dsw-alias-label-tertiary, #8e897b)}
/* 第四条：分模型堆叠条 */
.qb-seg-track{position:relative;height:5px;border-radius:3px;background:rgba(0,0,0,.1);overflow:hidden;display:flex}
/* 整条大计量条共用一条流光：绝对定位浮层，不参与 flex 布局，且压在全部分段之上 */
.qb-seg-track>.qb-sheen{z-index:1}
.qb-seg{position:relative;height:100%;overflow:hidden;transition:width .45s cubic-bezier(.22,1,.36,1)}
.qb-seg+.qb-seg{box-shadow:inset 1px 0 0 rgba(255,255,255,.35)}
.qb-usage-legend{display:none;position:absolute;bottom:calc(100% + 6px);right:0;z-index:121;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 10%));border-radius:10px;background:var(--dsw-alias-bg-layer-1, #e8e5e1);box-shadow:var(--dsw-shadow-lv3, 0 8px 24px rgb(0 0 0 / 12%));color:var(--dsw-alias-label-secondary, #77756d);font-size:11.5px;line-height:17px;white-space:nowrap;max-width:min(420px,calc(100vw - 24px))}
/* 环状 token 明细（2026-10-25 主人令）：环 + 图例横排，环心放总量。
   只换悬浮框内容，四根条、hover 触发范围与触发方式都不动。 */
.qb-usage-col:hover .qb-usage-legend{display:flex}
/* 环径 = 7 排字的总高（2026-10-25 主人令）：7 × 17 + 6 × 3 = 137px。
   明细固定 7 行（末行 others，见 QuotaBars 的 MAX_ROWS），所以环径是常量、不随模型数跳动。
   这里直接写像素、不走 CSS 变量：变量一旦继承不到，calc 整条失效，环会塌成 0 宽。 */
.qb-ring{position:relative;flex:none;align-self:center;width:137px;height:137px}
.qb-ring svg{display:block;width:100%;height:100%;transform:rotate(-90deg);transform-origin:center}
/* 轨道走主题令牌，暗色下自动换色，不再单列 prefers-color-scheme 覆盖 */
.qb-ring-track{fill:none;stroke:var(--dsw-alias-border-l3, rgba(0,0,0,.12));stroke-width:6}
.qb-ring-seg{fill:none;stroke-width:6;transition:stroke-dasharray .45s cubic-bezier(.22,1,.36,1)}
.qb-ring-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;pointer-events:none}
.qb-ring-total{font-size:15px;font-weight:600;line-height:17px;color:var(--dsw-alias-label-primary, #4a4a46);font-variant-numeric:tabular-nums}
.qb-ring-cap{font-size:10.5px;line-height:12px;color:var(--dsw-alias-label-tertiary, #8e897b)}
.qb-ring-rows{display:flex;flex-direction:column;justify-content:center;gap:3px;min-width:0;margin-left:12px}
.qb-usage-row{display:flex;align-items:center;gap:6px}
.qb-usage-dot{width:8px;height:8px;border-radius:2px;flex:none}
.qb-usage-name{overflow:hidden;text-overflow:ellipsis;max-width:150px}
.qb-usage-val{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary, #8e897b)}
@media (prefers-color-scheme:dark){.qb-track{background:rgba(255,255,255,.09)}.qb-seg-track{background:rgba(255,255,255,.09)}}
body[data-ds-dark-theme] .qb-track{background:rgba(255,255,255,.09)}
body[data-ds-dark-theme] .qb-seg-track{background:rgba(255,255,255,.09)}
@media (prefers-reduced-motion: reduce) { .qb-root *, .qb-root *::before, .qb-root *::after { animation: none !important; transition: none !important; } }
/* ── qbc-*：上下文占用圆环（放回输入框内部）。样式与色值对齐官方 ContextMeter.module.css ── */
.qbc-root{flex:none;display:inline-flex;position:relative}
.qbc-trigger{border-radius:var(--dsw-radius-sm, 8px);color:var(--dsw-alias-label-tertiary, #8e897b);font-family:inherit;font-size:var(--dsh-content-font-size-secondary, 13px);font-variant-numeric:tabular-nums;line-height:1.45;white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.qbc-trigger:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))}
.qbc-track{fill:none;stroke:var(--dsw-alias-border-l3, rgba(0,0,0,.12));stroke-width:2}
.qbc-fill{fill:none;stroke:var(--dsw-alias-label-tertiary, #8e897b);stroke-width:2;stroke-linecap:round;transition:stroke-dashoffset .35s cubic-bezier(.22,1,.36,1)}
.qbc-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg, 12px);background:var(--dsw-specific-menu, #fff);width:min(264px, calc(100vw - 24px));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1, rgb(0 0 0 / 10%));box-shadow:var(--dsw-elevation-prominent, 0 8px 24px rgb(0 0 0 / 14%));color:var(--dsw-alias-label-secondary, #77756d);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px;position:absolute;bottom:calc(100% + 8px);right:0}
.qbc-headline{color:var(--dsw-alias-label-tertiary, #8e897b)}
.qbc-headline b{color:var(--dsw-alias-label-primary, #4a4a46);font-weight:500}
.qbc-bar{border-radius:999px;background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));gap:1px;height:4px;margin:10px 0 12px;display:flex;overflow:hidden}
.qbc-segment{background:var(--meter-tint, var(--dsw-alias-label-tertiary, #8e897b));border-radius:1px;flex:none;min-width:2px;height:100%}
.qbc-swatch{background:var(--meter-tint);vertical-align:baseline;border-radius:2px;width:8px;height:8px;margin-right:6px;display:inline-block}
.qbc-figures{margin-left:auto;color:var(--dsw-alias-label-primary, #4a4a46);font-variant-numeric:tabular-nums;font-weight:500}
.qbc-c-system{--meter-tint:var(--dsw-static-neutral-bluish-400, #93a5c3)}
.qbc-c-tools{--meter-tint:#a78bfa}
.qbc-c-messages{--meter-tint:var(--dsw-static-blue-450, #2f6feb)}
`
    try {
      // 热重载会重新执行本模块：先摘掉上一代注入的样式，否则每改一次就多叠一份旧规则，
      // 新旧同选择器并存时看着「生效了」，实际是两代规则在互相盖。
      for (const old of Array.from(document.querySelectorAll('style[data-plugin="opencode-go-quota-pool"]'))) old.remove()
      const tag = document.createElement('style')
      tag.dataset.plugin = 'opencode-go-quota-pool'
      tag.textContent = CSS
      document.head.appendChild(tag)
    } catch (e) {}

    // 2026-11-16 主人令：前三条计量条按剩余百分比变色——100-50 绿→蓝渐变（越近 50 越蓝），
    // 50-30 保持当前蓝，30-5 黄，5 以下红；只作用于 windowList 的三根，不碰 usage 列与上下文圆环。
    function lerpHex(a, b, t) {
      const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
      const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
      return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')
    }
    function quotaTint(pct) {
      // 全程按区间插值：100-50 绿→蓝、50-30 蓝→黄、30-5 黄→红、5 以下红。
      // 区间边界处插值 t 恰好取到端点色，所以整条从 100 到 0 颜色连续，不跳变。
      const mix = (from, to, t) => 'linear-gradient(90deg,'
        + lerpHex(from[0], to[0], t) + ',' + lerpHex(from[1], to[1], t) + ',' + lerpHex(from[2], to[2], t) + ')'
      const GREEN = ['#16a34a', '#22c55e', '#4ade80']
      const BLUE = ['#1d4ed8', '#3b82f6', '#60a5fa']
      const AMBER = ['#b45309', '#f59e0b', '#fbbf24']
      if (pct >= 50) return mix(GREEN, BLUE, Math.max(0, Math.min(1, (100 - pct) / 50)))
      if (pct >= 30) return mix(BLUE, AMBER, Math.max(0, Math.min(1, (50 - pct) / 20)))
      if (pct >= 5) return mix(AMBER, ['#b91c1c', '#ef4444', '#f87171'], Math.max(0, Math.min(1, (30 - pct) / 25)))
      return 'linear-gradient(90deg,#b91c1c,#ef4444,#f87171)'
    }

    // ── 原版统计口径（与 conversation StatsLine 同算法，移植 deriveStats / formatTokens / formatDuration / cacheHit）──
    function formatTokens(n) {
      if (!(n > 0)) return '0'
      const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
      if (n < 1e3) return String(n)
      if (n < 1e6) return scaled(n / 1e3) + 'K'
      return scaled(n / 1e6) + 'M'
    }
    function formatDuration(ms) {
      const s = ms / 1e3
      if (s < 60) return String(Math.round(s * 10) / 10) + 's'
      const whole = Math.round(s)
      return Math.floor(whole / 60) + 'm' + (whole % 60) + 's'
    }
    function formatTokensPerSecond(tps) { return Math.round(tps) + ' tok/s' }
    function cacheHitPercent(usage) {
      const denominator = (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
      if (!(denominator > 0)) return null
      const cr = usage.cacheReadTokens || 0
      const quotient = Math.floor(denominator / 200)
      const remainder = denominator % 200
      let lower = 0, upper = 100
      while (lower < upper) {
        const candidate = Math.floor((lower + upper + 1) / 2)
        const factor = candidate * 2 - 1
        if (cr >= factor * quotient + Math.ceil(factor * remainder / 200)) lower = candidate
        else upper = candidate - 1
      }
      return lower
    }
    function deriveStats(nodes) {
      const turns = new Set()
      let steps = 0, llmMs = 0, toolMs = 0, ttftMs = 0, ttftSteps = 0, decodeMs = 0, decodeTokens = 0
      for (const node of nodes || []) {
        if (node.kind === 'tool-result') {
          if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
          continue
        }
        if (node.kind !== 'assistant') continue
        turns.add(node.turn)
        steps += 1
        const tm = node.timing
        if (tm !== undefined && tm.stepStartTime !== null) llmMs += Math.max(0, tm.completedTime - tm.stepStartTime)
        if (tm !== undefined && tm.stepStartTime !== null && tm.firstTokenTime !== null) { ttftMs += Math.max(0, tm.firstTokenTime - tm.stepStartTime); ttftSteps += 1 }
        if (tm !== undefined && tm.firstTokenTime !== null) { decodeMs += Math.max(0, tm.completedTime - tm.firstTokenTime); decodeTokens += (node.usage && node.usage.outputTokens) || 0 }
      }
      return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
    }

    // ── 环状 token 明细（通用）──
    // 输入任意「token 构成」即可：segments 每段 { key, label, tokens(十进制字符串), share(0-100), color }。
    // 环与图例同色、环心放总量，图例逐段给 token 数与占比；段数与颜色全由调用方给，
    // 本组件不认任何具体数据源 —— 别处要按类别看 token 构成时直接复用，不必再写一份。
    // 环用 pathLength=100：dasharray 直接写百分比，改环径不用重算周长。
    const RING_GAP = 1.2   // 段间留白（百分比单位）；极细段保底 0.15，免得整段消失
    function TokenRing(props) {
      const segments = props.segments || []
      let offset = 0
      const arcs = segments.map((s) => {
        const share = Math.max(0, Math.min(100, Number(s.share) || 0))
        const arc = Math.max(0.15, share - RING_GAP)
        const node = React.createElement('circle', {
          className: 'qb-ring-seg', key: 'ring-' + s.key,
          cx: '21', cy: '21', r: '15.9155', pathLength: '100',
          stroke: s.color,
          strokeDasharray: arc.toFixed(3) + ' ' + (100 - arc).toFixed(3),
          strokeDashoffset: (-offset).toFixed(3)
        })
        offset += share
        return node
      })
      return React.createElement('div', { className: 'qb-ring' },
        React.createElement('svg', { viewBox: '0 0 42 42', 'aria-hidden': 'true' },
          [React.createElement('circle', { className: 'qb-ring-track', key: 'ring-track', cx: '21', cy: '21', r: '15.9155' })].concat(arcs)),
        React.createElement('div', { className: 'qb-ring-center' },
          React.createElement('span', { className: 'qb-ring-total' }, formatCount(props.totalTokens)),
          props.caption ? React.createElement('span', { className: 'qb-ring-cap' }, props.caption) : null))
    }

    // 图例单独出：第四根横排（环 + 图例），前三根把图例和指标一起塞进右列，
    // 这样面板高度与第四根对齐，不会因为多一段指标就向上多盖一截聊天区。
    function TokenLegend(props) {
      const segments = props.segments || []
      return React.createElement('div', { className: 'qb-ring-rows' },
        segments.map((s) => React.createElement('div', { className: 'qb-usage-row', key: 'row-' + s.key },
          React.createElement('span', { className: 'qb-usage-dot', style: { background: s.color } }),
          React.createElement('span', { className: 'qb-usage-name' }, s.label),
          React.createElement('span', { className: 'qb-usage-val' },
            formatCount(s.tokens) + ' · ' + (Math.round((Number(s.share) || 0) * 10) / 10) + '%'))))
    }

    function QuotaBars(props) {
      const useSession = props.useSession
      const useProjection = props.useProjection
      const t = props.t
      const [data, setData] = React.useState(null)
      React.useEffect(() => {
        let live = true
        const load = async () => {
          try {
            var _c=new AbortController(); var _t=setTimeout(function(){_c.abort();},8000); const r = await fetch('/api/quota/opencode-go', { headers: { accept: 'application/json' }, signal: _c.signal }); clearTimeout(_t) // R56 超时
            if (!r.ok) return
            const j = await r.json()
            if (live) setData(j)
          } catch (e) {}
        }
        load()
        const iv = setInterval(load, 60000)
        return () => { live = false; clearInterval(iv) }
      }, [])

      // 宽度跟随：实测输入框（[data-composer-card] 是官方稳定属性，跨版本都在），
      // 把 .qb-root 钉成同一像素宽；ResizeObserver 负责「跟随输入框动态变化」。
      // 用 offsetWidth 而非 getBoundingClientRect：后者会带上入场动画的 transform，读数会偏。
      const rootRef = React.useRef(null)
      React.useEffect(() => {
        const el = rootRef.current
        if (!el) return
        const card = document.querySelector('[data-composer-card]')
        if (!card) return   // 找不到就交给 CSS 的 width:100% 兜底，不乱写死值
        const sync = () => {
          const w = card.offsetWidth
          if (w > 0) { el.style.width = w + 'px'; el.style.maxWidth = 'none' }
        }
        sync()
        if (typeof ResizeObserver === 'undefined') {
          window.addEventListener('resize', sync)
          return () => window.removeEventListener('resize', sync)
        }
        const ro = new ResizeObserver(sync)
        ro.observe(card)
        return () => ro.disconnect()
      }, [])

      // 屏蔽 dock 里那份官方上下文监控圆环（主人 2026-09-26 令：只屏蔽 dock 里的，
      // 输入框内我们自己注册的那只正常启用，不许误伤）。
      // 为什么不能只靠 CSS：插槽渲染器可能给条目包一层，官方环与 [data-qb] 未必同级，
      // 结构选择器 div:has(> [data-qb]) 会够不着 ⇒ 改用「向上找共同祖先 → 藏其下含环的兄弟」，
      // 不依赖任何层级假设，也不认构建期哈希类名。
      // 为什么藏的是环的根节点而不是 button：根是 flex:none 的行内 flex 盒，只藏 button
      // 会在 dock 的 gap:12px 下留下 12px 空位（主人看到的「依然占位」）。
      React.useEffect(() => {
        const el = rootRef.current
        if (!el) return
        const hasOfficialRing = (node) => Array.from(node.querySelectorAll('button[aria-haspopup="dialog"]'))
          .some((b) => {
            if (b.closest('[data-qbc]')) return false   // [data-qbc] 是我们输入框内那只，豁免
            // 官方 ContextMeter 的特征：按钮内有 SVG 圆环 + 百分比文字。
            // 侧边栏的新建/设置按钮同样 aria-haspopup=dialog，但不含环（2026-11-15 误藏即因只看 aria）。
            return !!b.querySelector('svg') && /%/.test(b.textContent ?? '')
          })
        // 官方环 0.1.7-rc.2 起挪进 dock 行，可能在 composer 卡片之外；从 el 向上找第一个
        // 含官方环的祖先，apply 只藏含「真环」的子节点——侧边栏不含环，不会被误伤。
        let scope = null
        const apply = () => {
          if (!scope) return
          for (const child of Array.from(scope.children)) {
            if (child.contains(el)) continue
            if (hasOfficialRing(child)) child.style.display = 'none'
          }
        }
        const locate = () => {
          scope = null
          let node = el
          while (node.parentElement) {
            const p = node.parentElement
            if (hasOfficialRing(p)) { scope = p; break }
            node = p
          }
          apply()
        }
        locate()
        // 官方环是条件渲染（activity 切换、或无 contextPressure 时直接不渲染），故监听子树反复补刀
        const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(locate) : null
        if (mo && scope) mo.observe(scope, { childList: true, subtree: true })
        window.addEventListener('resize', apply)
        return () => { if (mo) mo.disconnect(); window.removeEventListener('resize', apply) }
      }, [])

      // 固化（2026-08-29 主人令）：官方 stats 监控已移除，窗口列始终保留三条。
      // 2026-10-01 主人令：口径由「已用」改为「剩余」；host 半只给 remainingPercent，
      // 条形宽度也跟着走剩余，满条即额度全新，避免数字与图形说两件事。
      // 取不到数据时 remainingPercent 为 null 而非 0 或 100 —— 凭据过期会让上游返回
      // Unauthorized，填任何一个数都会把「没读到」说成「额度用尽」或「额度全新」。
      const windowList = (data && data.ok && Array.isArray(data.windows) && data.windows.length > 0)
        ? data.windows
        : [{ key: 'rolling', remainingPercent: null }, { key: 'weekly', remainingPercent: null }, { key: 'monthly', remainingPercent: null }]

      // 悬浮面板（2026-10-25 主人令）：token 构成交给环，其余指标改成「小标签 + 大数值」的格子。
      // 原来是一整行 ` | ` 拼接的文字，又密又分不清哪个数是什么。
      const metrics = []
      let tipSegments = []
      let tipTotal = 0
      try {
        const settledNodes = useSession ? useSession((s) => (s && s.chat && s.chat.legacy && s.chat.legacy.nodes) || []) : []
        const projected = useProjection ? useProjection('sessionStats') : undefined
        const stats = projected || deriveStats(settledNodes)
        const usage = useProjection ? useProjection('tokenUsage') : undefined
        const LN = LANG === 'zh'
        if (stats && stats.steps > 0) {
          metrics.push({ key: 'turns', label: LN ? '轮次' : 'turns', value: String(stats.turns || 0) })
          metrics.push({ key: 'steps', label: LN ? '步骤' : 'steps', value: String(stats.steps) })
          if (stats.llmMs > 0) metrics.push({ key: 'llm', label: 'LLM', value: formatDuration(stats.llmMs) })
          if (stats.toolMs > 0) metrics.push({ key: 'tool', label: LN ? '工具' : 'tool', value: formatDuration(stats.toolMs) })
          if (stats.ttftSteps > 0) metrics.push({ key: 'ttft', label: 'TTFT', value: formatDuration(stats.ttftMs / stats.ttftSteps) })
          if (stats.decodeMs > 0) metrics.push({ key: 'speed', label: LN ? '解码速度' : 'decode', value: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) })
        }
        if (usage) {
          const billed = (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
          if (billed > 0 || (usage.outputTokens || 0) > 0) {
            const ch = cacheHitPercent(usage)
            if (ch !== null) metrics.push({ key: 'cache', label: LN ? '缓存命中' : 'cache hit', value: ch + '%' })
            // token 账目改由环展示（2026-10-25 主人令）：输入拆成缓存读 / 未缓存 / 缓存写，与输出并列，
            // 所以这里不再重复「输入 X / 输出 Y」那一行。
            const parts = [
              { key: 'cacheRead', label: LN ? '缓存读' : 'cache read', tokens: usage.cacheReadTokens || 0 },
              { key: 'input', label: LN ? '未缓存输入' : 'uncached in', tokens: usage.uncachedInputTokens || 0 },
              { key: 'cacheWrite', label: LN ? '缓存写' : 'cache write', tokens: usage.cacheWriteTokens || 0 },
              { key: 'output', label: LN ? '输出' : 'output', tokens: usage.outputTokens || 0 }
            ].filter((p) => p.tokens > 0)
            tipTotal = parts.reduce((a, p) => a + p.tokens, 0)
            tipSegments = parts.map((p, i) => ({
              key: p.key,
              label: p.label,
              tokens: String(p.tokens),
              share: tipTotal > 0 ? (p.tokens / tipTotal) * 100 : 0,
              color: colorFor(i)
            }))
          }
        }
      } catch (e) {}

      const names = WINDOW_NAMES[LANG]

      // 第四条：近 30 天分模型 token 构成（总 token = 100%，每模型一色一段）
      const um = data && data.usageMonth && data.usageMonth.ok ? data.usageMonth : null
      const rawModels = um && Array.isArray(um.models) ? um.models : []
      // 2026-10-25 主人令：明细固定 7 行、末行 others —— 环径取 7 排字的总高（见 CSS .qb-ring），
      // 行数必须稳定，否则环会随模型数忽大忽小。本条取代 2026-09-27 的「<1% 归并」：
      // 不再按占比阈值筛，而是按名次取前 6 个，其余全部折进第 7 行 —— 阈值筛会让行数随数据漂移，
      // 环与图例就对不齐了。归并只发生在展示层：um.totalTokens 仍是真实总 token，
      // 各段 sharePercent 仍以该总量为分母，合并后合计仍是 100%。
      const MAX_ROWS = 7
      const MAX_MODELS = MAX_ROWS - 1   // 第 7 行留给 others
      const models = rawModels.slice(0, MAX_MODELS)
      let othersTokens = 0n
      let othersShare = 0
      for (const m of rawModels.slice(MAX_MODELS)) {
        try { othersTokens += BigInt(String(m.totalTokens || '0')) } catch (e) {}
        othersShare += m.sharePercent
      }
      if (othersTokens > 0n) {
        // provider 留空，key 与其余段不冲突；颜色取末位序号，接在可见模型之后
        models.push({ provider: '', model: 'others', totalTokens: othersTokens.toString(), sharePercent: othersShare })
      }
      const usageTotalTokens = um ? um.totalTokens : '0'
      const usageSegments = models.map((m, i) => ({
        key: (m.provider || 'p') + '/' + m.model,
        label: m.model,
        tokens: m.totalTokens,
        share: m.sharePercent,
        color: colorFor(i)
      }))
      const usageCol = React.createElement('div', { className: 'qb-col qb-usage-col', key: 'usage' },
        React.createElement('div', { className: 'qb-head' },
          React.createElement('span', { className: 'qb-name' }, USAGE_TITLE[LANG]),
          React.createElement('span', { className: 'qb-pct' }, formatCount(usageTotalTokens) + ' tok')),
        React.createElement('div', { className: 'qb-seg-track' },
          models.length === 0
            ? null
            : models.map((m, i) => React.createElement('div', {
                className: 'qb-seg',
                key: (m.provider || 'p') + '/' + m.model,
                title: m.model + ' · ' + (Math.round(m.sharePercent * 10) / 10) + '%',
                // 段内同样走「深→浅」纵向渐变 + 顶端高光，与前三根的立体感一致
                style: { width: Math.max(0, Math.min(100, m.sharePercent)) + '%', background: segFill(colorFor(i)) }
              })),
          // 流光挂在整条大计量条上：每段各挂一条会随模型数并行扫光，噪音成倍放大
          models.length > 0 ? React.createElement('div', { className: 'qb-sheen' }) : null),
        models.length > 0
          ? React.createElement('div', { className: 'qb-usage-legend', role: 'tooltip' },
              React.createElement(TokenRing, {
                segments: usageSegments,
                totalTokens: usageTotalTokens,
                caption: LANG === 'zh' ? '近30天合计' : '30d total'
              }),
              React.createElement(TokenLegend, { segments: usageSegments }))
          : null)

      return React.createElement('div', { className: 'qb-root', 'data-qb': '', ref: rootRef },
        React.createElement('div', { className: 'qb-windows' },
          React.createElement('div', { className: 'qb-tip', role: 'tooltip' },
            React.createElement('div', { className: 'qb-tip-head' },
              React.createElement('span', { className: 'qb-tip-title' }, LANG === 'zh' ? '本会话' : 'session'),
              React.createElement('span', { className: 'qb-tip-total' }, formatCount(tipTotal) + ' tok')),
            tipSegments.length > 0
              ? React.createElement('div', { className: 'qb-tip-bar' },
                  tipSegments.map((s) => React.createElement('span', {
                    className: 'qb-tip-seg', key: 'bar-' + s.key,
                    style: { width: Math.max(0, Math.min(100, Number(s.share) || 0)) + '%', background: s.color }
                  })))
              : null,
            tipSegments.length > 0
              ? React.createElement('div', { className: 'qb-tip-legend' },
                  tipSegments.map((s) => React.createElement('span', { className: 'qb-tip-legend-item', key: 'lg-' + s.key },
                    React.createElement('span', { className: 'qb-tip-dot', style: { background: s.color } }),
                    React.createElement('span', null, s.label),
                    React.createElement('span', { className: 'qb-tip-legend-val' },
                      formatCount(s.tokens) + ' · ' + (Math.round((Number(s.share) || 0) * 10) / 10) + '%'))))
              : null,
            metrics.length > 0
              ? React.createElement('div', { className: 'qb-tip-metrics' },
                  metrics.map((m) => React.createElement('div', { className: 'qb-tip-metric', key: m.key },
                    React.createElement('span', { className: 'qb-tip-metric-label' }, m.label),
                    React.createElement('span', { className: 'qb-tip-metric-value' }, m.value))))
              : React.createElement('div', { className: 'qb-tip-empty' }, '—')),
          windowList.map((w) => {
            const name = names[w.key] || w.key
            // 2026-09-29 主人令：标题后追加「于 X 后重置」。X 直接用 host 在抓取时刻算好的
            // resetText（d/h/m 粒度，本就不含秒），客户端不做本地倒计时——60s 轮询的秒数
            // 只会来回跳且已偏离真实剩余量。宽度不够时由 .qb-name 的省略号截断，
            // 完整文案另落在 title 属性里。
            const label = w.resetText ? name + ' 于 ' + w.resetText + ' 后重置' : name
            // 读不到数就显示破折号并且不填条：留一条空轨道比画一根满条诚实，
            // 后者会被当成「额度全新」。
            const known = typeof w.remainingPercent === 'number'
            return React.createElement('div', { className: 'qb-col', key: w.key },
              React.createElement('div', { className: 'qb-head' },
                React.createElement('span', { className: 'qb-name', title: label }, label),
                React.createElement('span', { className: 'qb-pct' },
                  known ? (Math.round(w.remainingPercent * 10) / 10).toFixed(1) + '%' : '—')),
              React.createElement('div', { className: 'qb-track' },
                known
                  ? React.createElement('div', { className: 'qb-fill', style: { width: Math.min(100, w.remainingPercent) + '%', background: quotaTint(w.remainingPercent) } },
                      React.createElement('div', { className: 'qb-sheen' }))
                  : null))
          })),
        usageCol)
    }

    // ── 上下文占用圆环 ──
    // 0.1.7-rc.2 起官方把 ContextMeter 挪进了 dock 行（跟额度条同排），主人要求它回到输入框内部。
    // 官方组件封在 ui-conversation 包内、既无插槽也不导出，无法重新登记 ⇒ 本组件按官方同一口径重做一只：
    // 数据源同为 contextPressure / contextBreakdown 投影，占位/公式/色值全部对齐官方。
    const CTX_ROWS = [
      { key: 'systemTokens', label: '系统提示', cls: 'qbc-c-system' },
      { key: 'toolsTokens', label: '工具定义', cls: 'qbc-c-tools' },
      { key: 'messageTokens', label: '对话内容', cls: 'qbc-c-messages' }
    ]
    const RING_R = 5.5
    const RING_C = 2 * Math.PI * RING_R
    function ContextRing(props) {
      const useProjection = props.useProjection
      const pressure = useProjection ? useProjection('contextPressure') : undefined
      const breakdown = useProjection ? useProjection('contextBreakdown') : undefined
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      React.useEffect(() => {
        if (!open) return
        const onDown = (e) => { if (rootRef.current && rootRef.current.contains(e.target)) return; setOpen(false) }
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onDown)
        document.addEventListener('keydown', onKey)
        return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
      }, [open])
      // 官方 contextOccupancy 同口径：projectedTokens ?? pressureTokens，除以 contextWindow
      const used = pressure ? (pressure.projectedTokens !== undefined ? pressure.projectedTokens : pressure.pressureTokens) : undefined
      const capacity = pressure ? pressure.contextWindow : undefined
      if (used === undefined || capacity === undefined) return null
      const percent = Math.min(100, Math.round((used / capacity) * 100))
      const reading = percent + '%'
      const total = breakdown ? (breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens) : 0
      const segs = (!breakdown || total === 0)
        ? [{ key: 'total', cls: '', width: percent }]
        : CTX_ROWS.map((r) => ({ key: r.key, cls: r.cls, width: (percent * (breakdown[r.key] || 0)) / total }))
            .filter((s) => s.width > 0)

      const panel = open ? React.createElement('div', { className: 'qbc-panel', role: 'dialog' },
        React.createElement('div', null,
          React.createElement('span', { className: 'qbc-headline' }, '上下文已用 '),
          React.createElement('b', null, reading),
          React.createElement('span', { className: 'qbc-figures' }, formatCount(used) + ' / ' + formatCount(capacity) + ' tok')),
        React.createElement('div', { className: 'qbc-bar' },
          segs.map((s) => React.createElement('div', { className: 'qbc-segment ' + s.cls, key: 'sg-' + s.key, style: { width: s.width + '%' } }))),
        breakdown && total > 0
          ? React.createElement(React.Fragment, null, CTX_ROWS.map((r) => React.createElement('div', { key: 'rw-' + r.key },
              React.createElement('span', { className: 'qbc-swatch ' + r.cls, 'aria-hidden': 'true' }),
              r.label,
              React.createElement('span', { className: 'qbc-figures' }, formatCount(breakdown[r.key] || 0)))))
          : null) : null

      return React.createElement('span', { className: 'qbc-root', ref: rootRef, 'data-qbc': '' },
        React.createElement('button', {
          type: 'button', className: 'qbc-trigger', 'aria-haspopup': 'dialog', 'aria-expanded': open,
          'aria-label': '上下文已用 ' + reading,
          onClick: () => setOpen(!open)
        },
          React.createElement('svg', { viewBox: '0 0 14 14', width: '14', height: '14', 'aria-hidden': 'true' },
            React.createElement('circle', { className: 'qbc-track', cx: '7', cy: '7', r: String(RING_R) }),
            React.createElement('circle', {
              className: 'qbc-fill', cx: '7', cy: '7', r: String(RING_R),
              strokeDasharray: RING_C.toFixed(3),
              strokeDashoffset: (RING_C * (1 - percent / 100)).toFixed(3),
              transform: 'rotate(-90 7 7)'
            })),
          React.createElement('span', null, reading)),
        panel)
    }

    function apply(ctx) {
      exports._applyCtx = ctx
      if (ctx && ctx.slots) {
        // 2026-09-26 修正（主人额外令）：改占官方同款 cell id 'stats'，并以更低 priority 抢占。
        // 官方 slot 引擎语义（dsh-client-ui-slots/lib/index.js）：
        //   · list 槽「每个 id 就是一个 cell，渲染该 cell 内 priority 最低的存活条目」（其余被 shadow）；
        //   · 同 id 且同 priority 注册会直接 throw（"register at a different priority to shadow it"）。
        // 此前用自有 id 'quota-bars' 并靠 CSS 隐藏官方 StatsPills 行——选择器随官方构建变动而失效，
        // 官方行复现 ⇒ 多出一个监控。改占 cell 后从结构上顶掉，不再依赖选择器。
        // 2026-10-18 主人令：官方新版把统计行拆成 activity（轮数 / 步骤 / 解码速度，ActivityPill）与
        // usage（token 总量 / 缓存命中，UsagePill）两个 dock cell，它们又出现在监控条右侧。
        // 屏蔽沿用同一套语义：占同 cell、压更低 priority 让官方那条被 shadow；抢占条目渲染 null，
        // 效果等价于「该 cell 不存在」，不靠 CSS 选择器。order 沿用官方值，将来若要恢复，去掉对应 yield 即可。
        const SuppressedStatPill = () => null
        ctx.slots.inject('conversation.composer.dock', function* () {
          yield ctx.slots.register({ name: 'conversation.composer.dock', id: 'stats', order: -10, priority: -10 }, QuotaBars)
          yield ctx.slots.register({ name: 'conversation.composer.dock', id: 'activity', order: 0, priority: -10 }, SuppressedStatPill)
          yield ctx.slots.register({ name: 'conversation.composer.dock', id: 'usage', order: 1, priority: -10 }, SuppressedStatPill)
        })
        // 上下文圆环放回输入框内部：conversation.input.right 就是发送按钮左侧那一格
        // （0.1.7-rc.2 里 .standardControls 内，官方环被挪走后此处空着）
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register({ name: 'conversation.input.right', id: 'quota-context-ring', order: -10 }, ContextRing))
      }
    }
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  }
})
