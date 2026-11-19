/**
 * dsh-web-updater 的页面 UI。
 *
 * 由客户端 bundle 通过 <script src="/dsh-updater/ui.js"> 加载（服务端 no-store），
 * 改样式/交互只需刷新页面，不用重启 host。
 *
 * 交互（浏览器竖直标签页模型）：
 * - 默认收缩成贴边的竖直小标签（箭头 + 状态点），左右吸附、纵向自由。
 * - 指针悬停 → 展开成胶囊（版本 / 更新按钮）。
 * - 点击 → 打开详情浮层；浮层向气泡内侧弹出并夹在视口内。
 * - 指针移出「标签 + 浮层」范围 → 自动收起（更新中/刚更新完/出错时保持展开）。
 */
(function () {
  const STATUS = '/dsh-updater/status'
  const CHECK = '/dsh-updater/check'
  const APPLY = '/dsh-updater/apply'
  const POS_KEY = 'dsh-web-updater:pos:v2'
  const HIDDEN_KEY = 'dsh-web-updater:hidden'
  const THEME_KEY = 'dsh-web-updater:theme'
  const STYLE_ID = 'dsh-updater-style'
  const ROOT_ID = 'dsh-updater-root'
  const PANEL_ID = 'dsh-updater-panel'

  try { window.__dshUpdaterUi?.destroy?.() } catch {}
  document.getElementById(ROOT_ID)?.remove()
  document.getElementById(PANEL_ID)?.remove()

  const MARGIN = 14        // 展开态距边缘留白
  const COLLAPSE_DELAY = 420

  const CSS = `
#${ROOT_ID}{position:fixed;left:0;top:0;z-index:2147483000;display:flex;opacity:0;
  font:500 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif;
  color:var(--fg);text-align:left}
#${ROOT_ID},#${PANEL_ID}{--bg:#fff;--fg:#0f172a;--muted:#55607a;--line:rgba(15,23,42,.16);--accent:#2f6fed;--accent-fg:#fff;
  --warn:#92400e;--warn-bg:#fff7e6;--warn-line:rgba(180,83,9,.45);--bad:#b91c1c;--bad-bg:#fef2f2;--ok:#15803d;
  --latest-bg:#eef1f6;--latest-fg:#334155;--latest-line:rgba(15,23,42,.12)}
@media (prefers-color-scheme:dark){
  #${ROOT_ID}:not([data-theme="light"]):not([data-theme="amber"]),#${PANEL_ID}:not([data-theme="light"]):not([data-theme="amber"]){
    --bg:#1b1e26;--fg:#e8ebf2;--muted:#9aa4b8;--line:rgba(255,255,255,.16);--accent:#5b8dfa;--accent-fg:#fff;
    --warn:#fcd34d;--warn-bg:#2a2417;--warn-line:rgba(252,211,77,.4);--bad:#fca5a5;--bad-bg:#2a1a1c;--ok:#4ade80;
    --latest-bg:#20242d;--latest-fg:#c3cbd9;--latest-line:rgba(255,255,255,.1)}
}
#${ROOT_ID}[data-theme="dark"],#${PANEL_ID}[data-theme="dark"]{--bg:#1b1e26;--fg:#e8ebf2;--muted:#9aa4b8;--line:rgba(255,255,255,.16);
  --accent:#5b8dfa;--accent-fg:#fff;--warn:#fcd34d;--warn-bg:#2a2417;--warn-line:rgba(252,211,77,.4);--bad:#fca5a5;--bad-bg:#2a1a1c;--ok:#4ade80;
  --latest-bg:#20242d;--latest-fg:#c3cbd9;--latest-line:rgba(255,255,255,.1)}
#${ROOT_ID}[data-theme="amber"],#${PANEL_ID}[data-theme="amber"]{--bg:#2a2117;--fg:#fde9b8;--muted:#d8bb8c;--line:rgba(253,233,184,.24);
  --accent:#f59e0b;--accent-fg:#1b1206;--warn:#fbbf24;--warn-bg:#3a2a12;--warn-line:rgba(251,191,36,.45);--bad:#fca5a5;--bad-bg:#2a1a1c;--ok:#facc15;
  --latest-bg:#332a1c;--latest-fg:#fde9b8;--latest-line:rgba(253,233,184,.24)}
#${ROOT_ID} *{box-sizing:border-box}
#${ROOT_ID}.dshu-dragging{user-select:none}

.dshu-bubble{display:flex;align-items:center;background:var(--bg);color:var(--fg);border:1px solid var(--line);
  box-shadow:0 8px 24px rgba(0,0,0,.26),0 2px 5px rgba(0,0,0,.16);cursor:pointer;user-select:none;touch-action:none;
  transition:width .16s ease,padding .16s ease,border-radius .16s ease,height .16s ease;overflow:hidden}
/* ── 收缩态：贴边的竖直标签 ── */
#${ROOT_ID}[data-mode="tab"] .dshu-bubble{width:26px;height:58px;flex-direction:column;justify-content:center;gap:9px;padding:0}
#${ROOT_ID}[data-mode="tab"][data-side="right"] .dshu-bubble{border-radius:9px 0 0 9px;border-right:0;margin-right:0}
#${ROOT_ID}[data-mode="tab"][data-side="left"] .dshu-bubble{border-radius:0 9px 9px 0;border-left:0;margin-left:0}
#${ROOT_ID}[data-mode="tab"] .dshu-chev{display:block}
#${ROOT_ID}[data-mode="tab"] .dshu-text,#${ROOT_ID}[data-mode="tab"] .dshu-btn,#${ROOT_ID}[data-mode="tab"] .dshu-close{display:none}
/* ── 展开态：胶囊 ── */
#${ROOT_ID}[data-mode="open"] .dshu-bubble{height:41px;padding:0 13px 0 14px;gap:10px;border-radius:999px}
#${ROOT_ID}[data-mode="open"] .dshu-chev{display:none}

.dshu-chev{display:none;width:7px;height:7px;border-left:2px solid var(--muted);border-bottom:2px solid var(--muted);
  transform:rotate(45deg) translate(1px,-1px);flex:0 0 auto}
#${ROOT_ID}[data-side="left"] .dshu-chev{transform:rotate(-135deg) translate(1px,-1px)}
.dshu-dot{width:9px;height:9px;flex:0 0 auto;border-radius:50%;background:var(--ok);flex:0 0 auto;box-shadow:0 0 0 3px rgba(21,128,61,.14)}
.dshu-bubble[data-state="available"] .dshu-dot{background:var(--warn);box-shadow:0 0 0 3px rgba(180,83,9,.18)}
.dshu-bubble[data-state="error"] .dshu-dot,.dshu-bubble[data-state="timeout"] .dshu-dot{background:var(--bad);box-shadow:0 0 0 3px rgba(185,28,28,.16)}
.dshu-bubble[data-state="applying"] .dshu-dot,.dshu-bubble[data-state="restarting"] .dshu-dot,.dshu-bubble[data-state="unknown"] .dshu-dot{
  background:var(--accent);box-shadow:0 0 0 3px rgba(47,111,237,.16);animation:dshu-pulse 1.1s ease-in-out infinite}
@keyframes dshu-pulse{0%,100%{opacity:.3}50%{opacity:1}}

.dshu-bubble[data-state="available"]{background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn)}
.dshu-bubble[data-state="error"],.dshu-bubble[data-state="timeout"]{background:var(--bad-bg);border-color:rgba(185,28,28,.4);color:var(--bad)}
@media (prefers-color-scheme:dark){.dshu-bubble[data-state="error"],.dshu-bubble[data-state="timeout"]{border-color:rgba(252,165,165,.4)}}
.dshu-bubble[data-state="latest"]{color:var(--latest-fg);background:var(--latest-bg);border-color:var(--latest-line)}

.dshu-text{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:650;letter-spacing:.01em;font-size:14px}
.dshu-text small{font-weight:650;color:var(--muted);margin-left:8px;font-variant-numeric:tabular-nums}
.dshu-bubble[data-state="available"] .dshu-text small,.dshu-bubble[data-state="error"] .dshu-text small,.dshu-bubble[data-state="timeout"] .dshu-text small{color:inherit;opacity:.72}
.dshu-btn{font:inherit;font-weight:650;border:1px solid transparent;background:transparent;color:inherit;padding:5px 14px;border-radius:999px;cursor:pointer;line-height:1.35;
  flex:0 0 auto;white-space:nowrap}
.dshu-btn.primary{background:var(--accent);color:var(--accent-fg);box-shadow:0 1px 2px rgba(0,0,0,.18)}
.dshu-btn.primary:hover{filter:brightness(1.08)}
.dshu-btn.ghost{border-color:var(--line);color:var(--fg)}
.dshu-btn.ghost:hover{border-color:var(--accent);color:var(--accent)}
.dshu-close{border:0;background:transparent;color:var(--muted);font:600 17px/1 inherit;cursor:pointer;padding:0 2px;border-radius:6px}
.dshu-close:hover{color:var(--fg);background:rgba(127,127,127,.14)}

/* ── 完全隐藏：只剩贴边热区，悬停时渗出一点可见残影 ── */
.dshu-peek{display:flex;align-items:center;justify-content:center;width:12px;height:96px;cursor:pointer;background:transparent;
  opacity:0;transition:opacity .15s ease}
.dshu-peek:hover{opacity:1}
.dshu-peek i{display:block;width:8px;height:54px;border-radius:7px;background:#fff;border:1px solid rgba(15,23,42,.18);
  box-shadow:0 3px 12px rgba(0,0,0,.35)}
@media (prefers-color-scheme:dark){.dshu-peek i{background:#20242d;border-color:rgba(255,255,255,.22)}}
#${ROOT_ID}[data-mode="hidden"] .dshu-peek{margin:0}
.dshu-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483000;padding:9px 14px;border-radius:10px;
  background:rgba(17,24,39,.92);color:#fff;font:500 13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
  box-shadow:0 10px 30px rgba(0,0,0,.3);opacity:0;transition:opacity .2s ease;pointer-events:none;max-width:70vw}
.dshu-toast[data-show="1"]{opacity:1}
#${PANEL_ID}{position:fixed;display:none;z-index:2147483000;width:min(92vw,384px);padding:15px 17px;border-radius:14px;
  background:var(--bg);color:var(--fg);border:1px solid var(--line);box-shadow:0 16px 40px rgba(0,0,0,.26),0 2px 6px rgba(0,0,0,.14);
  font:500 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;text-align:left}
#${PANEL_ID} *{box-sizing:border-box}
#${PANEL_ID} .dshu-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
#${PANEL_ID} .dshu-title strong{font-size:14.5px;font-weight:700}
#${PANEL_ID} .dshu-close{color:inherit;opacity:.55}
#${PANEL_ID} .dshu-row{display:flex;justify-content:space-between;gap:14px;padding:3.5px 0;font-size:13.5px}
#${PANEL_ID} .dshu-row>span:first-child{opacity:.62;flex:0 0 auto}
#${PANEL_ID} .dshu-row>span:last-child{text-align:right;word-break:break-all;font-variant-numeric:tabular-nums}
#${PANEL_ID} .dshu-sep{height:1px;background:rgba(127,127,127,.28);margin:9px 0}
#${PANEL_ID} .dshu-log{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.62;max-height:112px;overflow:auto;white-space:pre-wrap;word-break:break-all}
#${PANEL_ID} .dshu-hint{opacity:.62;font-size:12.5px;margin-top:8px}
#${PANEL_ID} .dshu-actions{display:flex;gap:9px;justify-content:flex-end;margin-top:12px}
#${PANEL_ID} .dshu-btn{font:inherit;font-weight:650;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;
  padding:5px 14px;border-radius:999px;cursor:pointer;line-height:1.35}
#${PANEL_ID} .dshu-btn:hover{border-color:#2f6fed;color:#2f6fed}
#${PANEL_ID} .dshu-btn.primary{background:#2f6fed;border-color:transparent;color:#fff}
#${PANEL_ID} .dshu-btn.primary:hover{filter:brightness(1.08);color:#fff}
`

  let root = null
  let panelEl = null
  let bubbleEl = null
  let state = null
  let error = null
  let panelOpen = false
  let hoverOpen = false
  let confirmingUntil = 0
  let busyUntil = 0
  let timer = null
  let signature = ''
  let suppressClickUntil = 0
  let pendingTarget = null
  let applyStartedAt = 0
  let timedOut = false
  let justUpdated = false
  let reloadTimer = null
  let reloadDeferred = false
  let pos = { side: 'right', y: null }
  let dragging = false
  let collapseTimer = null
  let hidden = false
  let theme = 'auto'

  const APPLY_TIMEOUT_MS = 3 * 60 * 1000

  const h = (tag, props, ...kids) => {
    const node = document.createElement(tag)
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
        else node.setAttribute(key, value === true ? '' : String(value))
      }
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue
      node.append(typeof kid === 'string' ? document.createTextNode(kid) : kid)
    }
    return node
  }

  // ───────────────────────── 状态 ─────────────────────────

  const installing = () => Boolean(state?.applying) || Date.now() < busyUntil
  const hasUpdate = () => Boolean(state?.updateAvailable && state?.latest && state?.installed && state.latest !== state.installed)
  const checkFailed = () => Boolean(error)
  const forceOpen = () => justUpdated || timedOut || installing() || checkFailed()
  const mode = () => (hoverOpen || panelOpen || forceOpen() ? 'open' : 'tab')

  function chipState() {
    if (justUpdated) return 'updated'
    if (timedOut) return 'timeout'
    if (installing()) return error ? 'restarting' : 'applying'
    if (checkFailed()) return 'error'
    if (!state) return 'unknown'
    if (hasUpdate()) return 'available'
    return 'latest'
  }

  function chipLabel(st) {
    const installed = state?.installed ? ` ${state.installed}` : ''
    switch (st) {
      case 'updated': return [`已更新到${state?.installed ? ` ${state.installed}` : '新版本'}`, reloadDeferred ? '点「刷新」加载新版本' : '正在刷新页面']
      case 'applying': return ['正在更新', state?.latest ? `到 ${state.latest}` : null]
      case 'restarting': return ['正在重启服务', '稍后会自动回来']
      case 'timeout': return ['更新超时', '服务可能没起来']
      case 'error': return ['更新检查失败', error ? String(error).slice(0, 60) : null]
      case 'available': return [state?.updateAvailable ? '有新版' : '可更新', state?.latest || null]
      case 'unknown': return ['检查更新中', null]
      default: return [`DSH${installed} 已是最新`, null]
    }
  }

  // ───────────────────────── 位置 ─────────────────────────

  function bubbleSize() {
    return { w: root?.offsetWidth || 0, h: root?.offsetHeight || 0 }
  }
  const clampNum = (v, min, max) => Math.min(Math.max(v, min), max)

  /** 拖动中：自由 left/top 定位。 */
  function placeAt(x, y) {
    if (!root) return
    const { w, h: hh } = bubbleSize()
    root.style.right = 'auto'
    root.style.left = `${Math.round(clampNum(x, 0, Math.max(0, innerWidth - w)))}px`
    root.style.top = `${Math.round(clampNum(y, 0, Math.max(0, innerHeight - hh)))}px`
    root.style.opacity = '1'
  }

  /**
   * 贴边吸附：按吸附方向锚定（右侧用 right、左侧用 left），
   * 这样内容变宽时向内生长，不会因为可用空间变小把按钮挤成两行。
   */
  function applyPos({ keepY = true } = {}) {
    if (!root) return
    const { h: hh } = bubbleSize()
    const margin = hidden || mode() === 'tab' ? 0 : MARGIN
    const maxY = Math.max(margin, innerHeight - hh - margin)
    const y = keepY && Number.isFinite(pos.y) ? pos.y : innerHeight - hh - 96
    pos.y = Math.round(clampNum(y, margin, maxY))
    root.style.top = `${pos.y}px`
    root.style.left = pos.side === 'left' ? `${margin}px` : 'auto'
    root.style.right = pos.side === 'right' ? `${margin}px` : 'auto'
    root.style.opacity = '1'
  }

  function readHidden() {
    try { return localStorage.getItem(HIDDEN_KEY) === '1' } catch { return false }
  }
  function saveHidden(value) {
    try { value ? localStorage.setItem(HIDDEN_KEY, '1') : localStorage.removeItem(HIDDEN_KEY) } catch {}
  }

  function readTheme() {
    try {
      const value = localStorage.getItem(THEME_KEY)
      return value === 'light' || value === 'dark' || value === 'amber' ? value : 'auto'
    } catch { return 'auto' }
  }

  function readPos() {
    try {
      const raw = localStorage.getItem(POS_KEY)
      if (!raw) return null
      const p = JSON.parse(raw)
      if (!p || (p.side !== 'left' && p.side !== 'right')) return null
      return { side: p.side, y: Number.isFinite(p.y) ? p.y : null }
    } catch { return null }
  }
  function savePos() {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ side: pos.side, y: Math.round(pos.y) })) } catch {}
  }
  function resetPos() {
    pos = { side: 'right', y: null }
    try { localStorage.removeItem(POS_KEY) } catch {}
    applyPos({ keepY: false })
    placePanel()
  }

  function placePanel() {
    if (!panelEl) return
    if (!panelOpen || !root) {
      panelEl.style.display = 'none'
      return
    }
    panelEl.style.display = 'block'
    const b = root.getBoundingClientRect()
    const pw = panelEl.offsetWidth
    const ph = panelEl.offsetHeight
    const gap = 10
    let x = pos.side === 'right' ? b.left - pw - gap : b.right + gap
    if (x < MARGIN) x = b.right + gap
    if (x + pw > innerWidth - MARGIN) x = b.left - pw - gap
    x = clampNum(x, MARGIN, Math.max(MARGIN, innerWidth - pw - MARGIN))
    let y = b.bottom - ph
    if (y < MARGIN) y = b.bottom + gap
    y = clampNum(y, MARGIN, Math.max(MARGIN, innerHeight - ph - MARGIN))
    panelEl.style.left = `${Math.round(x)}px`
    panelEl.style.top = `${Math.round(y)}px`
  }

  function onResize() {
    applyPos()
    placePanel()
  }

  // ───────────────────────── 悬停展开 / 移出收起 ─────────────────────────

  function cancelCollapse() {
    if (collapseTimer) clearTimeout(collapseTimer)
    collapseTimer = null
  }
  function expandNow() {
    cancelCollapse()
    if (hidden) return
    if (!hoverOpen) { hoverOpen = true; paint(true) }
  }
  function scheduleCollapse() {
    if (hidden || forceOpen()) return
    cancelCollapse()
    collapseTimer = setTimeout(() => {
      if (root?.matches(':hover') || panelEl?.matches(':hover')) return
      if (forceOpen()) return
      hoverOpen = false
      panelOpen = false
      paint(true)
    }, COLLAPSE_DELAY)
  }

  // ───────────────────────── 拖动 ─────────────────────────

  function startDrag(event) {
    if (event.button !== undefined && event.button !== 0) return
    const rect = root.getBoundingClientRect()
    const baseX = rect.left
    const baseY = rect.top
    const startX = event.clientX
    const startY = event.clientY
    let moved = false
    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) {
        moved = true
        dragging = true
        root.classList.add('dshu-dragging')
        if (panelOpen) { panelOpen = false; paint(true) }
      }
      if (!moved) return
      moveEvent.preventDefault()
      placeAt(baseX + dx, baseY + dy)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      root.classList.remove('dshu-dragging')
      dragging = false
      if (!moved) return
      const dropped = root.getBoundingClientRect()
      pos.side = dropped.left + dropped.width / 2 < innerWidth / 2 ? 'left' : 'right'
      pos.y = dropped.top
      savePos()
      applyPos()
      suppressClickUntil = Date.now() + 300
      if (!root.matches(':hover')) scheduleCollapse()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // ───────────────────────── 渲染 ─────────────────────────

  function buildBubble() {
    const st = chipState()
    const [text, sub] = chipLabel(st)
    const bubble = h('div', { class: 'dshu-bubble', 'data-state': st, role: 'button', tabindex: '0', title: '悬停展开 · 点击查看详情 · 拖动可移动 · 双击归位' },
      h('span', { class: 'dshu-chev' }),
      h('span', { class: 'dshu-dot' }),
      h('span', { class: 'dshu-text' }, text, sub ? h('small', { text: sub }) : null),
    )
    bubble.addEventListener('dblclick', (event) => {
      if (event.target.closest('.dshu-btn') || event.target.closest('.dshu-close')) return
      resetPos()
      suppressClickUntil = Date.now() + 300
    })
    bubble.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.dshu-btn') || event.target.closest('.dshu-close')) return
      startDrag(event)
    })
    bubble.addEventListener('click', (event) => {
      if (event.target.closest('.dshu-btn') || event.target.closest('.dshu-close')) return
      if (Date.now() < suppressClickUntil) return
      hoverOpen = true
      panelOpen = !panelOpen
      paint(true)
    })
    if (st === 'available') {
      const confirming = Date.now() < confirmingUntil
      bubble.append(h('button', {
        class: 'dshu-btn primary',
        text: confirming ? '确认更新' : '更新',
        onclick: (event) => { event.stopPropagation(); onUpdate() },
      }))
    }
    if (st === 'updated') {
      bubble.append(h('button', {
        class: 'dshu-btn primary', text: '刷新',
        onclick: (event) => { event.stopPropagation(); try { location.reload() } catch {} },
      }))
    }
    if (st === 'timeout') {
      bubble.append(h('button', {
        class: 'dshu-btn primary', text: '刷新',
        onclick: (event) => { event.stopPropagation(); try { location.reload() } catch {} },
      }))
    }
    if (st === 'error') {
      bubble.append(h('button', {
        class: 'dshu-btn ghost', text: '重试',
        onclick: (event) => { event.stopPropagation(); error = null; runCheck() },
      }))
      bubble.append(h('button', {
        class: 'dshu-btn ghost', text: '刷新',
        onclick: (event) => { event.stopPropagation(); try { location.reload() } catch {} },
      }))
    }
    return bubble
  }

  /** 完全隐藏后的贴边热区：平时不可见，悬停渗出一点残影，点击恢复。 */
  function buildPeek() {
    const peek = h('button', { class: 'dshu-peek', title: '显示 DSH 更新挂件', 'aria-label': '显示 DSH 更新挂件' }, h('i'))
    peek.addEventListener('click', (event) => { event.stopPropagation(); showWidget() })
    return peek
  }

  function cleanLog(lines) {
    // 把 /Users/<name>、/home/<name> 之类缩成 ~，避免不同机器上路径太长
    return (Array.isArray(lines) ? lines : [])
      .map((line) => String(line).replace(/^\[[^\]]+\]\s*/, '').replace(/\/(?:Users|home)\/[^/\s]+/g, '~'))
      .filter(Boolean)
      .slice(-4)
  }

  function buildPanel() {
    const rows = [
      ['当前版本', state?.installed],
      ['可用版本', state?.latest],
      ['通道', state?.channel],
      ['自动更新', state?.autoApply ? `开${state?.quietHours ? `（${state.quietHours.join(':00–')}:00）` : ''}` : '关（仅提醒）'],
      ['上次检查', state?.checkedAt ? new Date(state.checkedAt).toLocaleString() : '—'],
    ]
    if (state?.lastApplied) {
      const { from, to, ok, at } = state.lastApplied
      rows.push(['上次更新', `${from} → ${to}${ok === false ? '（失败）' : ''}${at ? ` · ${new Date(at).toLocaleString()}` : ''}`])
    }
    const log = cleanLog(state?.log)
    return h('div', {},
      h('div', { class: 'dshu-title' },
        h('strong', { text: 'DSH 更新' }),
        h('button', { class: 'dshu-close', text: '×', title: '收起', onclick: () => { panelOpen = false; paint(true) } }),
      ),
      ...rows.map(([label, value]) => h('div', { class: 'dshu-row' },
        h('span', { text: label }),
        h('span', { text: value === null || value === undefined || value === '' ? '—' : String(value) }),
      )),
      log.length ? h('div', { class: 'dshu-sep' }) : null,
      log.length ? h('div', { class: 'dshu-log', text: log.join('\n') }) : null,
      h('div', { class: 'dshu-hint', text: installing() ? '更新进行中，服务会短暂断开后自动恢复' : '更新会重启 dsh-web，页面稍后需刷新' }),
      h('div', { class: 'dshu-actions' },
        h('button', { class: 'dshu-btn ghost', text: '隐藏挂件', onclick: () => hideWidget() }),
        h('button', { class: 'dshu-btn ghost', text: '检查更新', onclick: () => runCheck() }),
        hasUpdate() ? h('button', { class: 'dshu-btn primary', text: '更新', onclick: () => onUpdate() }) : null,
      ),
    )
  }

  function paint(force) {
    if (!root) return
    const st = chipState()
    const md = hidden ? 'hidden' : mode()
    const sig = [st, md, hidden ? 1 : 0, state?.installed, state?.latest, panelOpen, hoverOpen, confirmingUntil > Date.now(),
      error ? 1 : 0, installing() ? 1 : 0, justUpdated ? 1 : 0, pos.side, Math.round(pos.y ?? -1), (state?.log || []).length].join('|')
    if (!force && sig === signature) return
    signature = sig
    root.dataset.mode = md
    root.dataset.side = pos.side
    root.dataset.theme = theme
    panelEl.dataset.theme = theme
    root.style.display = 'flex'
    if (md === 'hidden') {
      root.replaceChildren(buildPeek())
      bubbleEl = null
      if (!dragging) applyPos()
      panelEl.style.display = 'none'
      return
    }
    root.replaceChildren(buildBubble())
    bubbleEl = root.firstElementChild
    if (!dragging) applyPos()
    if (panelOpen) {
      panelEl.replaceChildren(buildPanel())
      placePanel()
    } else {
      panelEl.style.display = 'none'
    }
  }

  // ───────────────────────── 数据 ─────────────────────────

  async function json(url, init) {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...init })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
    return body
  }

  function scheduleReload() {
    justUpdated = true
    reloadDeferred = false
    hoverOpen = true
    paint(true)
    const el = typeof document === 'undefined' ? null : document.activeElement
    const typing = Boolean(el) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true)
    if (typing) {
      reloadDeferred = true
      paint(true)
      return
    }
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => { try { location.reload() } catch {} }, 2600)
  }

  async function refresh() {
    try {
      const next = await json(STATUS)
      state = next
      if (next.applying !== true) busyUntil = 0
      if (next.lastApplied && next.lastApplied.ok === false && next.applying !== true && pendingTarget) {
        pendingTarget = null
        applyStartedAt = 0
        error = next.lastApplied.error || '更新失败（已回滚）'
      }
      if (installing() && applyStartedAt && Date.now() - applyStartedAt > APPLY_TIMEOUT_MS) {
        error = '更新超时：服务可能没起来，可刷新页面或查看日志'
        timedOut = true
        busyUntil = 0
        applyStartedAt = 0
        pendingTarget = null
      }
      if (timedOut && !installing() && !pendingTarget) timedOut = false
      if (error || installing() || justUpdated) hoverOpen = true
      if (pendingTarget && next.installed === pendingTarget && next.applying !== true) {
        pendingTarget = null
        applyStartedAt = 0
        scheduleReload()
      }
      paint(false)
      schedule(installing() ? 1200 : 60000)
    } catch (err) {
      error = err?.message || String(err)
      hoverOpen = true
      paint(true)
      schedule(installing() ? 1200 : 15000)
    }
  }

  async function runCheck() {
    error = null
    paint(true)
    try {
      await json(CHECK, { method: 'POST' })
      setTimeout(refresh, 1500)
    } catch (err) {
      error = err?.message || String(err)
      paint(true)
    }
  }

  async function onUpdate() {
    if (Date.now() >= confirmingUntil) {
      confirmingUntil = Date.now() + 6000
      paint(true)
      setTimeout(() => paint(true), 6300)
      return
    }
    confirmingUntil = 0
    busyUntil = Date.now() + 8 * 60 * 1000
    hoverOpen = true
    try {
      await json(APPLY, { method: 'POST' })
    } catch (err) {
      busyUntil = 0
      error = err?.message || String(err)
      paint(true)
      return
    }
    pendingTarget = state?.latest || null
    applyStartedAt = Date.now()
    timedOut = false
    panelOpen = true
    paint(true)
    schedule(1200)
  }

  function toast(text, ms = 3600) {
    let el = document.querySelector('.dshu-toast')
    if (!el) {
      el = h('div', { class: 'dshu-toast' })
      document.body.append(el)
    }
    el.textContent = text
    el.dataset.show = '1'
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => { el.dataset.show = '0' }, ms)
  }

  function hideWidget() {
    hidden = true
    saveHidden(true)
    panelOpen = false
    hoverOpen = false
    paint(true)
    toast('已隐藏 · 恢复：把鼠标移到屏幕侧边（或在地址后加 ?dshUpdater=show）', 5200)
  }

  function showWidget() {
    hidden = false
    saveHidden(false)
    panelOpen = false
    hoverOpen = true
    paint(true)
    applyPos()
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(refresh, ms)
  }

  function onDocClick(event) {
    if (!panelOpen) return
    if (root && root.contains(event.target)) return
    if (panelEl && panelEl.contains(event.target)) return
    panelOpen = false
    hoverOpen = false
    paint(true)
  }
  function onKey(event) {
    if (event.key === 'Escape' && (panelOpen || hoverOpen)) {
      panelOpen = false
      hoverOpen = false
      paint(true)
    }
  }

  function onSettingsChanged() {
    hidden = readHidden()
    theme = readTheme()
    if (hidden) { panelOpen = false; hoverOpen = false }
    paint(true)
  }

  function mount() {
    if (!document.getElementById(STYLE_ID)) document.head.append(h('style', { id: STYLE_ID, text: CSS }))
    root = h('div', { id: ROOT_ID })
    panelEl = h('div', { id: PANEL_ID })
    document.body.append(root, panelEl)
    pos = readPos() || { side: 'right', y: null }
    hidden = readHidden()
    theme = readTheme()
    // 兜底恢复入口：?dshUpdater=show
    try {
      const url = new URL(location.href)
      if (url.searchParams.get('dshUpdater') === 'show') {
        hidden = false
        saveHidden(false)
        url.searchParams.delete('dshUpdater')
        history.replaceState(null, '', url.pathname + url.search + url.hash)
      }
    } catch {}
    root.addEventListener('pointerenter', expandNow)
    root.addEventListener('pointerleave', scheduleCollapse)
    panelEl.addEventListener('pointerenter', expandNow)
    panelEl.addEventListener('pointerleave', scheduleCollapse)
    document.addEventListener('click', onDocClick, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('dsh-updater:settings-changed', onSettingsChanged)
    requestAnimationFrame(() => {
      paint(true)
      applyPos({ keepY: pos.y !== null })
    })
    refresh()
  }

  function destroy() {
    if (timer) clearTimeout(timer)
    if (reloadTimer) clearTimeout(reloadTimer)
    cancelCollapse()
    timer = null
    document.removeEventListener('click', onDocClick, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', onResize)
    window.removeEventListener('dsh-updater:settings-changed', onSettingsChanged)
    document.getElementById(STYLE_ID)?.remove()
    root?.remove()
    panelEl?.remove()
    root = null
    panelEl = null
    bubbleEl = null
  }

  window.__dshUpdaterUi = { destroy, refresh }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})()
