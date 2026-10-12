/**
 * dsh-valley-meter-sidebar — client half.
 *
 * Renders one permanent status strip as a row in the left sidebar's panel list,
 * which in the DSH shell sits directly above the workspace region: a 24h
 * peak/valley timeline on the left, the account balance on the right. Clicking
 * the strip opens the full meter panel; clicking the balance opens the top-up
 * page.
 *
 * Everything is plain React from the loader's shared `require('react')`, and
 * all data comes from the host route `/api/valley-meter/state`.
 *
 * Several layout choices are forced by the row the slot renders into. The real
 * DOM is
 *
 *   button.panelRow
 *     > span.panelGlyph[aria-hidden="true"]
 *         > div[data-slot="sidebar.panellist"][style="display:contents"]
 *             > span.vmx-root
 *     > span.panelTitle        (only while the sidebar is wide)
 *
 * because the renderer wraps every slot in a `display:contents` anchor div
 * (dsh-client-ui-renderer boundRenderSlot/SlotOutlet). That extra level means
 * the component must (a) stretch the glyph span and hide the sibling title
 * through descendant `:has()` rules — direct-child selectors cannot see through
 * the anchor — and (b) stop click propagation on the balance so the row's own
 * navigation still works.
 *
 * @module dsh-valley-meter-sidebar/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-valley-meter-sidebar',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PLUGIN_ID = 'valley-meter-sidebar'
    const NAMESPACE = 'valley-meter'
    const ENDPOINT = '/api/valley-meter/state'
    /** Last panel row, i.e. flush against the workspace region above it. */
    const PANEL_ORDER = 100
    const DAY_MINUTES = 1440
    const TICKS = [0, 360, 720, 1080, 1440]
    /**
     * Floor for the local route poll. Polling `/api/valley-meter/state` costs
     * nothing (the host answers the upstream balance call from its own cache),
     * so this only bounds chatter with the host — `pollSec` is the setting.
     */
    const MIN_POLL_SEC = 10
    const SCHEME_KEY = 'dsh-valley-meter-sidebar:scheme'
    const DEFAULT_DISPLAY = {
      pollSec: 20,
      refreshSec: 300,
      peakColor: '#e08a3c',
      valleyColor: '#4d7fd6',
      topUpUrl: 'https://platform.deepseek.com/top_up',
      currency: 'CNY'
    }

    /**
     * Colour themes, light/cartoon first. `custom` has no colours of its own —
     * it follows the host's `peakColor`/`valleyColor` config, which keeps those
     * two settings meaningful now that the page owns the palette.
     */
    const SCHEMES = [
      { id: 'candy', zh: '糖果', en: 'Candy', peak: '#ffb35c', valley: '#7ecbff' },
      { id: 'mint', zh: '薄荷', en: 'Mint', peak: '#ffd166', valley: '#5fd6a8' },
      { id: 'sakura', zh: '樱花', en: 'Sakura', peak: '#ff9fc0', valley: '#a9b6ff' },
      { id: 'crayon', zh: '蜡笔', en: 'Crayon', peak: '#ff8f6b', valley: '#63c7d8' },
      { id: 'onedark', zh: 'One Dark', en: 'One Dark', peak: '#e5c07b', valley: '#61afef' },
      { id: 'dracula', zh: '德古拉', en: 'Dracula', peak: '#ffb86c', valley: '#bd93f9' },
      { id: 'nord', zh: '北境', en: 'Nord', peak: '#ebcb8b', valley: '#88c0d0' },
      { id: 'tokyo', zh: '东京夜', en: 'Tokyo Night', peak: '#e0af68', valley: '#7aa2f7' },
      { id: 'gruvbox', zh: '复古', en: 'Gruvbox', peak: '#d79921', valley: '#83a598' },
      { id: 'solarized', zh: '日光', en: 'Solarized', peak: '#b58900', valley: '#268bd2' },
      { id: 'amber', zh: '琥珀黛蓝', en: 'Amber', peak: '#d9964a', valley: '#4a6fa5' },
      { id: 'ochre', zh: '赭石天青', en: 'Ochre', peak: '#c8843c', valley: '#3f8f9d' },
      { id: 'crimson', zh: '绛纱墨青', en: 'Crimson', peak: '#cf6a5c', valley: '#3d6b70' },
      { id: 'pantone', zh: '靛墨潘通', en: 'Pantone', peak: '#ff8a5c', valley: '#5b6ee1' },
      { id: 'custom', zh: '自定义', en: 'Custom' }
    ]

    const ZH = {
      'panel': '峰谷电表',
      'phase.peak': '峰',
      'phase.valley': '谷',
      'phase.unknown': '--',
      'day.weekend': '周末',
      'day.workday': '工作日',
      'day.makeup': '调休上班',
      'day.holiday': '法定节假日',
      'field.phase': '当前时段',
      'field.day': '今日',
      'field.nextSwitch': '下次切换',
      'field.balance': '账户余额',
      'field.updated': '余额更新于',
      'field.windows': '高峰时段',
      'field.calendar': '节假日数据',
      'field.scheme': '配色主题',
      'calendar.unavailable': '不可用',
      'calendar.stale': '待更新',
      'nextIn': '{time} 后',
      'refresh': '刷新余额',
      'refreshing': '刷新中…',
      'error.offline': '无法连接主机服务',
      'error.noBalance': '余额不可用',
      'tip.balance': '查看余额与充值',
      'tip.makeup': '调休上班日：全天按低谷价计费',
      'tip.holiday': '法定节假日：全天按低谷价计费'
    }

    const EN = {
      'panel': 'Peak meter',
      'phase.peak': 'Peak',
      'phase.valley': 'Off-peak',
      'phase.unknown': '--',
      'day.weekend': 'Weekend',
      'day.workday': 'Workday',
      'day.makeup': 'Makeup workday',
      'day.holiday': 'Public holiday',
      'field.phase': 'Current phase',
      'field.day': 'Today',
      'field.nextSwitch': 'Next switch',
      'field.balance': 'Balance',
      'field.updated': 'Balance updated',
      'field.windows': 'Peak windows',
      'field.calendar': 'Holiday data',
      'field.scheme': 'Colour theme',
      'calendar.unavailable': 'unavailable',
      'calendar.stale': 'stale',
      'nextIn': 'in {time}',
      'refresh': 'Refresh balance',
      'refreshing': 'Refreshing…',
      'error.offline': 'Host service unreachable',
      'error.noBalance': 'Balance unavailable',
      'tip.balance': 'Open balance and top-up',
      'tip.makeup': 'Makeup workday: off-peak pricing all day',
      'tip.holiday': 'Public holiday: off-peak pricing all day'
    }

    const CSS = `
.vmx-root{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;min-width:0;padding:4px 8px;border:1.5px solid var(--vmx-phase-line);border-radius:14px;background:var(--vmx-phase-soft);box-shadow:inset 0 1px 0 rgba(255,255,255,.45);font-size:11px;line-height:1;color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none}
/* The slot arrives through a display:contents anchor div, so stretch whichever
   row span holds us and hide the row's own title text. */
button:has(.vmx-root) > span:has(.vmx-root),button:has(.vmx-root) > span:first-of-type{flex:1 1 auto;min-width:0;container-type:inline-size}
button:has(.vmx-root) > span:not(:has(.vmx-root)),button:has(.vmx-root) > span + span{display:none}
.vmx-badge{flex:none;box-sizing:border-box;padding:2px 6px;border-radius:999px;font-size:10px;font-weight:700;line-height:1.2;letter-spacing:.02em;color:var(--vmx-ink);background:var(--vmx-phase);box-shadow:inset 0 -1px 0 rgba(0,0,0,.12)}
.vmx-tag{flex:none;box-sizing:border-box;max-width:7.5em;padding:1px 6px;overflow:hidden;border:1px solid var(--vmx-phase-line);border-radius:999px;font-size:9px;line-height:1.25;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.vmx-time{display:flex;flex-direction:column;justify-content:center;gap:4px;flex:1 1 auto;min-width:0}
.vmx-track{position:relative;height:8px;border-radius:999px;background:var(--vmx-valley-soft);box-shadow:inset 0 1px 2px rgba(0,0,0,.12)}
.vmx-seg{position:absolute;top:0;bottom:0;background:var(--vmx-peak);border-radius:999px}
.vmx-marker{position:absolute;top:-1px;bottom:-1px;width:3px;margin-left:-1.5px;border-radius:999px;background:var(--dsw-alias-label-primary)}
.vmx-ticks{display:flex;justify-content:space-between;font-size:8px;line-height:1;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.vmx-bal{flex:none;display:inline-flex;align-items:baseline;gap:1px;font-weight:600;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.vmx-bal:hover{color:var(--dsw-alias-link)}
.vmx-sym{font-size:10px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.vmx-bal.vmx-err,.vmx-bal.vmx-err .vmx-sym{color:var(--dsw-alias-label-dimmed)}
/* Collapsed 56px rail: the round badge box around the phase dot. */
.vmx-root:has(> .vmx-dot){width:auto;padding:4px;border-radius:12px;justify-content:center}
.vmx-dot{display:block;width:11px;height:11px;border-radius:50%;background:var(--vmx-phase);box-shadow:inset 0 -1px 0 rgba(0,0,0,.15)}
@container (max-width:210px){.vmx-ticks{display:none}}
@container (max-width:170px){.vmx-tag{display:none}}
@container (max-width:150px){.vmx-badge{display:none}}
.vmx-page{display:flex;flex-direction:column;gap:16px;padding:28px 32px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow:auto}
.vmx-page-title{margin:0;font-size:15px;font-weight:600}
.vmx-card{display:flex;flex-direction:column;gap:16px;box-sizing:border-box;max-width:640px;padding:18px 20px;border:1.5px solid var(--vmx-phase-line);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);box-shadow:inset 0 1px 0 rgba(255,255,255,.35)}
.vmx-card-head{display:flex;align-items:center;gap:10px}
.vmx-card-head .vmx-tag{max-width:none;font-size:11px;padding:2px 8px}
.vmx-card-track{display:flex;flex-direction:column;gap:6px}
.vmx-track.vmx-track-lg{height:14px;border-radius:999px}
.vmx-track.vmx-track-lg .vmx-seg{border-radius:999px}
.vmx-track.vmx-track-lg .vmx-marker{width:4px;margin-left:-2px}
.vmx-ticks.vmx-ticks-lg{font-size:10px}
.vmx-rows{display:flex;flex-direction:column;gap:8px;margin:0}
.vmx-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
.vmx-row dt{color:var(--dsw-alias-label-secondary)}
.vmx-row dd{margin:0;font-variant-numeric:tabular-nums;text-align:right}
.vmx-error{color:var(--dsw-alias-state-error-primary)}
.vmx-schemes{display:flex;flex-direction:column;gap:8px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2)}
.vmx-schemes-label{color:var(--dsw-alias-label-secondary)}
.vmx-swatches{display:flex;flex-wrap:wrap;gap:6px}
.vmx-swatch{display:inline-flex;box-sizing:border-box;width:36px;height:22px;padding:0;overflow:hidden;border:1.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:0 0;cursor:pointer}
.vmx-swatch:hover{border-color:var(--dsw-alias-label-tertiary)}
.vmx-swatch-on{border-color:var(--dsw-alias-label-primary);box-shadow:0 0 0 1.5px var(--dsw-alias-label-primary)}
.vmx-sw-half{flex:1 1 50%}
.vmx-btn{align-self:flex-start;box-sizing:border-box;padding:6px 12px;border:1.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.vmx-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.vmx-btn[disabled]{color:var(--dsw-alias-label-dimmed);cursor:default}
`

    let translate = undefined

    /** Substitute `{name}` placeholders in a locale template. */
    function interpolate(template, vars) {
      if (typeof template !== 'string') return String(template ?? '')
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
    }

    /** Minimal translator used before (or without) the locale service. */
    function makeT(dict) {
      return (key, vars) => interpolate(dict[key] ?? key, vars)
    }

    /** Best-effort language pick for the fallback translator. */
    function detectLanguage() {
      const language = typeof document === 'undefined' ? '' : document.documentElement?.lang ?? ''
      return language.toLowerCase().startsWith('en') ? 'en' : 'zh'
    }

    const t = (key, vars) => (translate ?? makeT(detectLanguage() === 'en' ? EN : ZH))(key, vars)

    // ------------------------------------------------------------- colour utils

    /** `#rgb`/`#rrggbb` as `[r,g,b]`, or `null` when unparseable. */
    function parseHex(value) {
      if (typeof value !== 'string') return null
      const raw = value.trim().replace(/^#/, '')
      const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
      if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
      return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
    }

    /** The same colour at an alpha, e.g. `rgba(255, 179, 92, 0.16)`. */
    function rgba(value, alpha) {
      const rgb = parseHex(value)
      return rgb === null ? value : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
    }

    /** Mix a colour toward black — used for text that must sit on its own tint. */
    function shade(value, amount) {
      const rgb = parseHex(value)
      if (rgb === null) return value
      const keep = 1 - Math.max(0, Math.min(1, amount))
      return `rgb(${rgb.map((channel) => Math.round(channel * keep)).join(', ')})`
    }

    /** Readable text colour on a solid fill: dark ink for light fills, white otherwise. */
    function inkOn(value) {
      const rgb = parseHex(value)
      if (rgb === null) return '#fff'
      const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255
      return luminance > 0.62 ? shade(value, 0.62) : '#ffffff'
    }

    function schemeById(id) {
      return SCHEMES.find((scheme) => scheme.id === id) ?? SCHEMES[0]
    }

    function schemeName(scheme) {
      return detectLanguage() === 'en' ? scheme.en ?? scheme.id : scheme.zh ?? scheme.id
    }

    /** The stored theme, falling back to the light cartoon default. */
    function readSchemeId() {
      try {
        const stored = window.localStorage?.getItem(SCHEME_KEY)
        if (SCHEMES.some((scheme) => scheme.id === stored)) return stored
      } catch (error) {
        // Private mode / sandboxed frame: the palette simply does not persist.
      }
      return SCHEMES[0].id
    }

    let schemeId = readSchemeId()
    const schemeListeners = new Set()

    function setSchemeId(next) {
      if (next === schemeId || !SCHEMES.some((scheme) => scheme.id === next)) return
      schemeId = next
      try {
        window.localStorage?.setItem(SCHEME_KEY, next)
      } catch (error) {
        // Ignore: in-memory switch still applies to the mounted views.
      }
      for (const listener of [...schemeListeners]) {
        try {
          listener()
        } catch (error) {
          // A dead component must not break the other subscribers.
        }
      }
    }

    /** Subscribe a component to the shared theme so the strip and page agree. */
    function useScheme() {
      const [id, setId] = React.useState(() => schemeId)
      React.useEffect(() => {
        const listener = () => setId(schemeId)
        schemeListeners.add(listener)
        listener()
        return () => {
          schemeListeners.delete(listener)
        }
      }, [])
      return id
    }

    /** The phase colour, from the active theme (or the host colours for `custom`). */
    function themeColors(scheme, display) {
      if (scheme.id === 'custom') {
        return { peak: display.peakColor ?? DEFAULT_DISPLAY.peakColor, valley: display.valleyColor ?? DEFAULT_DISPLAY.valleyColor }
      }
      return { peak: scheme.peak, valley: scheme.valley }
    }

    /** The CSS custom properties every strip/page subtree carries. */
    function themeVars(peak, display, scheme) {
      const { peak: peakColor, valley: valleyColor } = themeColors(scheme, display)
      const phase = peak?.offPeakAllDay === true ? valleyColor : peak?.inPeak === true ? peakColor : valleyColor
      return {
        '--vmx-peak': peakColor,
        '--vmx-valley': valleyColor,
        '--vmx-valley-soft': rgba(valleyColor, 0.38),
        '--vmx-phase': phase,
        '--vmx-phase-soft': rgba(phase, 0.17),
        '--vmx-phase-line': rgba(phase, 0.45),
        '--vmx-ink': inkOn(phase)
      }
    }

    // ------------------------------------------------------------------ helpers

    /** Two-decimal money, or `null` when the host has no usable number. */
    function formatMoney(value) {
      if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed.toFixed(2) : null
    }

    /** Compact `1h05m` / `5m20s` / `12s` duration. */
    function formatDuration(ms) {
      const total = Math.max(0, Math.round(Number(ms) / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
      if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
      return `${seconds}s`
    }

    /** Local `HH:MM` for an instant. */
    function formatClock(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value)) return '--'
      const date = new Date(value)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    /** Local minutes from midnight for a UTC hour of day. */
    function toLocalMinutes(utcHours) {
      const raw = utcHours * 60 - new Date().getTimezoneOffset()
      return ((raw % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES
    }

    /**
     * Peak coverage as local minutes. Windows that wrap past local midnight are
     * split, so each range satisfies `from < to`.
     */
    function localPeakRanges(windows) {
      const ranges = []
      for (const window of Array.isArray(windows) ? windows : []) {
        const start = Number(window?.start)
        const end = Number(window?.end)
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue
        const from = toLocalMinutes(start)
        const to = toLocalMinutes(end)
        if (to > from) ranges.push({ from, to })
        else if (to < from) {
          ranges.push({ from, to: DAY_MINUTES })
          ranges.push({ from: 0, to })
        } else {
          ranges.push({ from: 0, to: DAY_MINUTES })
        }
      }
      return ranges.sort((a, b) => a.from - b.from)
    }

    /** Peak segments as `{left, width}` percentages of the local day. */
    function dayPeakSegments(windows) {
      return localPeakRanges(windows).map((range) => ({
        left: (range.from / DAY_MINUTES) * 100,
        width: ((range.to - range.from) / DAY_MINUTES) * 100
      }))
    }

    /** Human `HH:MM-HH:MM` list of the peak windows on the local clock. */
    function describeWindows(windows) {
      const pad = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`
      return localPeakRanges(windows).map((range) => `${pad(range.from)}-${pad(range.to)}`).join('  ')
    }

    /** Percentage of the local day elapsed at an instant. */
    function progressPercent(atMs) {
      const value = Number(atMs)
      const date = new Date(Number.isFinite(value) ? value : Date.now())
      const minutes = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
      return (minutes / DAY_MINUTES) * 100
    }

    /**
     * Peak/valley label. Rest days are off-peak all day, so the badge only ever
     * reads 峰 or 谷 — why the day is off-peak lives in its own {@link dayTag} chip.
     */
    function phaseLabel(peak) {
      if (peak === null || peak === undefined) return t('phase.unknown')
      return peak.inPeak === true ? t('phase.peak') : t('phase.valley')
    }

    /** A non-empty string, else `null`. */
    function text(value) {
      return typeof value === 'string' && value.trim() !== '' ? value : null
    }

    /**
     * The day-type chip: a statutory holiday's name, 调休上班 for a makeup
     * workday, or 周末. Ordinary weekdays carry no chip.
     * @returns {{kind: string, text: string, title?: string} | null}
     */
    function dayTag(peak) {
      if (peak === null || peak === undefined) return null
      const holiday = text(peak.holidayName)
      if (holiday !== null) return { kind: 'holiday', text: holiday, title: `${holiday} · ${t('tip.holiday')}` }
      const workday = text(peak.workdayName)
      if (workday !== null) {
        return {
          kind: 'makeup',
          text: t('day.makeup'),
          title: peak.offPeakAllDay === true ? `${workday} · ${t('tip.makeup')}` : workday
        }
      }
      if (peak.weekend === true) return { kind: 'weekend', text: t('day.weekend') }
      return null
    }

    /** Hostname of the first calendar source, for the diagnostics row. */
    function sourceHost(sources) {
      const first = Array.isArray(sources) ? sources.find((item) => text(item) !== null) : undefined
      if (first === undefined) return null
      try {
        return new URL(first).hostname
      } catch {
        return null
      }
    }

    /** The 5 clock labels of the rail. */
    function tickLabels(size) {
      return TICKS.map((minutes) =>
        h(
          'span',
          { key: minutes },
          minutes === DAY_MINUTES ? '24' : String(minutes / 60).padStart(2, '0')
        )
      )
    }

    /**
     * Poll the host route: immediately, then on a self-adjusting timer taken
     * from the host's `pollSec`, paused while the document is hidden, plus a
     * cheap 30s clock so the marker and countdown stay live between polls.
     * @returns {{snapshot: object|null, nowMs: number, refresh: (force?: boolean) => Promise<void>}}
     */
    function useMeter() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [clock, setClock] = React.useState(() => Date.now())
      const intervalRef = React.useRef(DEFAULT_DISPLAY.pollSec)

      const load = React.useCallback(async (force) => {
        try {
          const response = await fetch(force === true ? `${ENDPOINT}?refresh=1` : ENDPOINT, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (body !== null && typeof body === 'object' && body.ok === true) {
            // `pollSec` paces this loop; `refreshSec` is the host's upstream TTL.
            const pollSec = Number(body.display?.pollSec ?? body.display?.refreshSec)
            if (Number.isFinite(pollSec)) intervalRef.current = Math.max(MIN_POLL_SEC, pollSec)
            setSnapshot({ ...body, offline: false, receivedAtMs: Date.now() })
            return
          }
          const message = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`
          setSnapshot((previous) => (previous === null ? { ok: false, error: message } : { ...previous, offline: true, error: message, receivedAtMs: Date.now() }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setSnapshot((previous) => (previous === null ? { ok: false, error: message } : { ...previous, offline: true, error: message, receivedAtMs: Date.now() }))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        let timer = undefined
        const schedule = () => {
          if (!alive) return
          timer = setTimeout(() => {
            void tick(false)
          }, intervalRef.current * 1000)
        }
        const tick = async (force) => {
          if (!alive) return
          if (!force && typeof document !== 'undefined' && document.hidden) {
            schedule()
            return
          }
          await load(force)
          schedule()
        }
        void tick(true)
        const onVisibility = () => {
          if (typeof document !== 'undefined' && !document.hidden) void load(false)
        }
        document.addEventListener('visibilitychange', onVisibility)
        const clockTimer = setInterval(() => setClock(Date.now()), 30000)
        return () => {
          alive = false
          if (timer !== undefined) clearTimeout(timer)
          clearInterval(clockTimer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load])

      // Extrapolate the host clock with the local one so the marker moves smoothly.
      const nowMs = Number.isFinite(snapshot?.nowMs) ? snapshot.nowMs + Math.max(0, clock - (snapshot.receivedAtMs ?? clock)) : clock
      return { snapshot, nowMs, refresh: load }
    }

    /**
     * The 24h rail: peak segments on a valley ground plus a now marker. A rest
     * day carries no segments at all, because the whole day bills off-peak.
     */
    function Track(props) {
      const segments = props.offPeakAllDay === true ? [] : dayPeakSegments(props.windows)
      return h(
        'span',
        { className: props.size === 'lg' ? 'vmx-track vmx-track-lg' : 'vmx-track', 'aria-hidden': 'true' },
        segments.map((segment, index) => h('span', { key: index, className: 'vmx-seg', style: { left: `${segment.left}%`, width: `${segment.width}%` } })),
        h('span', { className: 'vmx-marker', style: { left: `${progressPercent(props.nowMs)}%` } })
      )
    }

    /** The theme picker shown on the panel page. */
    function SchemePicker(props) {
      const { display, active } = props
      return h(
        'div',
        { className: 'vmx-schemes' },
        h('span', { className: 'vmx-schemes-label' }, `${t('field.scheme')} · ${schemeName(schemeById(active))}`),
        h(
          'div',
          { className: 'vmx-swatches', role: 'group' },
          SCHEMES.map((scheme) => {
            const colors = themeColors(scheme, display)
            const on = scheme.id === active
            return h(
              'button',
              {
                key: scheme.id,
                type: 'button',
                className: on ? 'vmx-swatch vmx-swatch-on' : 'vmx-swatch',
                title: schemeName(scheme),
                'aria-label': schemeName(scheme),
                'aria-pressed': on,
                onClick: () => setSchemeId(scheme.id)
              },
              h('span', { className: 'vmx-sw-half', style: { background: colors.peak } }),
              h('span', { className: 'vmx-sw-half', style: { background: colors.valley } })
            )
          })
        )
      )
    }

    /** The permanent sidebar strip. */
    function Strip(props) {
      const { snapshot, nowMs } = useMeter()
      const active = useScheme()
      const display = snapshot?.display ?? DEFAULT_DISPLAY
      const scheme = schemeById(active)
      const peak = snapshot?.peak ?? null
      const compact = typeof props?.size === 'number' ? props.size >= 18 : false
      const balance = snapshot?.balance ?? null
      const amount = balance === null ? null : formatMoney(balance.total)
      const symbol = (balance?.currency ?? display.currency) === 'USD' ? '$' : '¥'
      const countdown = peak?.nextAtMs == null ? null : formatDuration(peak.nextAtMs - nowMs)
      // Either level can carry the reason the number is missing (a dead route vs
      // a dead balance call); both belong in the tooltip.
      const problem = snapshot?.error ?? balance?.error ?? null
      const tag = dayTag(peak)
      const summary = [
        t('panel'),
        `${phaseLabel(peak)}${countdown === null ? '' : ` · ${t('nextIn', { time: countdown })}`}`,
        tag === null ? null : tag.text,
        balance === null || amount === null ? t('error.noBalance') : `${balance.currency ?? display.currency} ${amount}`,
        problem
      ]
        .filter((line) => line !== null && line !== '')
        .join('\n')

      const openTopUp = (event) => {
        event.stopPropagation()
        event.preventDefault()
        const url = display.topUpUrl
        if (typeof url === 'string' && url !== '') window.open(url, '_blank', 'noopener,noreferrer')
      }

      if (compact) {
        return h('span', { className: 'vmx-root', style: themeVars(peak, display, scheme), title: summary }, h('style', null, CSS), h('span', { className: 'vmx-dot' }))
      }

      return h(
        'span',
        { className: 'vmx-root', style: themeVars(peak, display, scheme), title: summary },
        h('style', null, CSS),
        h('span', { className: 'vmx-badge' }, phaseLabel(peak)),
        tag === null ? null : h('span', { className: `vmx-tag vmx-tag-${tag.kind}`, title: tag.title }, tag.text),
        h(
          'span',
          { className: 'vmx-time' },
          h(Track, { windows: snapshot?.windows, peak, nowMs, display, offPeakAllDay: peak?.offPeakAllDay === true }),
          h('span', { className: 'vmx-ticks' }, tickLabels())
        ),
        h(
          'span',
          { className: amount === null ? 'vmx-bal vmx-err' : 'vmx-bal', title: t('tip.balance'), onClick: openTopUp },
          h('span', { className: 'vmx-sym' }, symbol),
          h('span', null, amount ?? '--')
        )
      )
    }

    /** The full panel behind the strip. */
    function MeterPage(props) {
      const { snapshot, nowMs, refresh } = useMeter()
      const [busy, setBusy] = React.useState(false)
      const active = useScheme()
      const display = snapshot?.display ?? DEFAULT_DISPLAY
      const scheme = schemeById(active)
      const peak = snapshot?.peak ?? null
      const balance = snapshot?.balance ?? null
      const amount = balance === null ? null : formatMoney(balance.total)
      const countdown = peak?.nextAtMs == null ? null : formatDuration(peak.nextAtMs - nowMs)
      const problem = snapshot?.error ?? balance?.error ?? null
      const onRefresh = async () => {
        setBusy(true)
        try {
          await refresh(true)
        } finally {
          setBusy(false)
        }
      }
      const tag = dayTag(peak)
      const calendar = peak?.calendar ?? null
      const dayText =
        tag !== null
          ? tag.text
          : peak === null
            ? '--'
            : peak.weekend === true
              ? t('day.weekend')
              : t('day.workday')
      const calendarText =
        calendar === null || calendar.ok !== true
          ? t('calendar.unavailable')
          : [
              Array.isArray(calendar.years) ? calendar.years.join(', ') : null,
              sourceHost(calendar.sources),
              calendar.fetchedAtMs == null ? null : formatClock(calendar.fetchedAtMs),
              calendar.stale === true ? t('calendar.stale') : null
            ]
              .filter((part) => text(part) !== null)
              .join(' · ') || t('calendar.unavailable')
      const rows = [
        { label: t('field.phase'), value: phaseLabel(peak) },
        { label: t('field.day'), value: dayText },
        { label: t('field.nextSwitch'), value: peak?.nextAtMs == null ? '--' : `${formatClock(peak.nextAtMs)} · ${t('nextIn', { time: countdown })}` },
        { label: t('field.windows'), value: describeWindows(snapshot?.windows) || '--' },
        { label: t('field.balance'), value: balance === null || amount === null ? t('error.noBalance') : `${balance.currency ?? display.currency} ${amount}` },
        { label: t('field.updated'), value: balance?.atMs == null ? '--' : formatClock(balance.atMs) },
        { label: t('field.calendar'), value: calendarText, title: text(calendar?.error) ?? undefined }
      ]
      return h(
        'div',
        { className: 'vmx-page', style: themeVars(peak, display, scheme) },
        h('style', null, CSS),
        h('h1', { className: 'vmx-page-title' }, t('panel')),
        h(
          'div',
          { className: 'vmx-card' },
          h(
            'div',
            { className: 'vmx-card-head' },
            h('span', { className: 'vmx-badge' }, phaseLabel(peak)),
            tag === null ? null : h('span', { className: `vmx-tag vmx-tag-${tag.kind}`, title: tag.title }, tag.text)
          ),
          h(
            'div',
            { className: 'vmx-card-track' },
            h(Track, { windows: snapshot?.windows, peak, nowMs, display, size: 'lg', offPeakAllDay: peak?.offPeakAllDay === true }),
            h('span', { className: 'vmx-ticks vmx-ticks-lg' }, tickLabels())
          ),
          h(
            'dl',
            { className: 'vmx-rows' },
            rows.flatMap((row) => [
              h('dt', { key: `${row.label}-k` }, row.label),
              h('dd', { key: `${row.label}-v`, title: row.title }, row.value)
            ])
          ),
          problem === null ? null : h('div', { className: 'vmx-error' }, problem),
          h(SchemePicker, { display, active }),
          h('button', { type: 'button', className: 'vmx-btn', disabled: busy, onClick: onRefresh }, busy ? t('refreshing') : t('refresh'))
        )
      )
    }

    /**
     * Client half entry point.
     * @param ctx - client plugin context carrying `slots` and `locale`.
     */
    function apply(ctx) {
      const disposers = []
      const push = (dispose) => {
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
        push(ctx.locale.register(NAMESPACE, 'zh', ZH))
        push(ctx.locale.register(NAMESPACE, 'en', EN))
        if (typeof ctx.locale.bind === 'function') translate = ctx.locale.bind(NAMESPACE)
      }
      push(
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PLUGIN_ID, order: PANEL_ORDER, label: () => t('panel') }, Strip)
        )
      )
      push(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PLUGIN_ID }, MeterPage)))
      ctx.effect(
        () => () => {
          for (const dispose of disposers.splice(0)) dispose()
        },
        'valley-meter-sidebar: sidebar strip'
      )
    }

    return { name: PLUGIN_ID, inject: ['slots', 'locale'], apply }
  }
})
