/**
 * dsh-valley-meter-sidebar — host half.
 *
 * Publishes the DeepSeek peak/valley state and the account balance over one
 * loopback-only HTTP route that the client half polls. Everything here rides
 * shipped host services (`webServer` for the route, `credentials` for the API
 * key), so the plugin needs no runtime dependency of its own.
 *
 * Tariff rules (DeepSeek's published off-peak discount schedule, modelled on the
 * upstream https://github.com/uckkk/dsh-valley-meter plugin):
 *
 * - Beijing Monday-Friday is a work day; Saturday/Sunday is a rest day.
 * - Every `windows` range on a work day is peak **unless** that date is a Chinese
 *   statutory holiday (see ./holidays.js).
 * - Every rest day — weekend, statutory holiday, and a 调休 makeup workday that
 *   falls on a weekend — is billed off-peak all day.
 * - `windows` are declared in **UTC** hours (Beijing 09:00-12:00 / 14:00-18:00 is
 *   UTC 01:00-04:00 / 06:00-10:00).
 * - The rest-day rule only applies from {@link WEEKEND_OFFPEAK_FROM_MS} onward.
 *
 * @module dsh-valley-meter-sidebar
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_HOLIDAY_URLS, createCalendar, holidayUrl } from './holidays.js'

/** Stable cordis plugin name. */
export const name = 'valley-meter-sidebar'

/** Host services required before the route can mount. `credentials` is resolved lazily. */
export const inject = ['webServer']

/** Milliseconds of the Beijing/UTC offset (China has no DST). */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** Instant the rest-day all-day off-peak policy takes effect (Beijing 2026-08-23 00:00). */
export const WEEKEND_OFFPEAK_FROM_MS = Date.parse('2026-08-23T00:00:00+08:00')

/** Default peak windows, in UTC hours: 01:00-04:00 and 06:00-10:00 UTC = Beijing 09:00-12:00 and 14:00-18:00. */
export const DEFAULT_WINDOWS = Object.freeze([
  Object.freeze({ start: 1, end: 4 }),
  Object.freeze({ start: 6, end: 10 })
])

/** Route the client half polls. */
export const STATE_ROUTE = '/api/valley-meter/state'

/** Cache/refresh floor, so a hostile or buggy caller cannot spin the balance API. */
const MIN_REFRESH_SEC = 30

/** Client poll floor for the local route (it costs nothing upstream). */
const MIN_POLL_SEC = 10

/** Balance request timeout. */
const BALANCE_TIMEOUT_MS = 15000

/** Longest forward scan for the next peak/valley switch (holiday blocks are long). */
export const NEXT_SWITCH_HORIZON_MS = 21 * 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** Answer as JSON with a content type the browser fetch layer accepts. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(value) {
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Whether a URL hostname names the loopback authority. */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: loopback socket AND loopback Host header. The
 * socket address is authoritative; `X-Forwarded-For` is never trusted. The
 * route reads and forwards the user's API key, so a non-loopback caller must
 * never reach it.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

/** Normalize one peak window; `undefined` when it is not a usable hour range. */
function normalizeWindow(value) {
  if (value === null || typeof value !== 'object') return undefined
  const start = Number(value.start)
  const end = Number(value.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  if (start < 0 || end > 24 || end <= start) return undefined
  return { start, end }
}

/** Coerce one finite positive number, else the fallback. */
function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** An `https:` base URL, else the fallback (the API key is only ever sent over TLS). */
function httpsEndpoint(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' ? `${url.protocol}//${url.host}` : fallback
  } catch {
    return fallback
  }
}

/**
 * Valid holiday-data URL templates. Each must carry a `{year}` placeholder and
 * resolve to a real http(s) URL, so a self-hosted mirror is fine but a typo is
 * not silently used.
 */
function holidayUrls(value) {
  const list = (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
    .filter((item) => {
      if (!item.includes('{year}')) return false
      try {
        const protocol = new URL(holidayUrl(item, 2026)).protocol
        return protocol === 'https:' || protocol === 'http:'
      } catch {
        return false
      }
    })
  return list.length > 0 ? list : [...DEFAULT_HOLIDAY_URLS]
}

/** Resolve the entry config into the shape the route logic reads. */
export function resolveConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const windows = Array.isArray(source.windows) ? source.windows.map(normalizeWindow).filter(Boolean) : []
  const refreshSec = Math.max(MIN_REFRESH_SEC, positiveNumber(source.refreshSec, 300))
  return {
    endpoint: httpsEndpoint(source.endpoint, 'https://api.deepseek.com'),
    envName: typeof source.envName === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(source.envName) ? source.envName : 'DEEPSEEK_API_KEY',
    refreshSec,
    pollSec: Math.max(MIN_POLL_SEC, positiveNumber(source.pollSec, 20)),
    currency: typeof source.currency === 'string' && source.currency !== '' ? source.currency : 'CNY',
    weekendOffPeak: source.weekendOffPeak !== false,
    windows: windows.length > 0 ? windows : DEFAULT_WINDOWS.map((window) => ({ ...window })),
    holidayUrls: holidayUrls(source.holidayUrl ?? source.holidayUrls),
    holidays: Array.isArray(source.holidays) ? source.holidays : [],
    workdays: Array.isArray(source.workdays) ? source.workdays : [],
    holidayCacheHours: Math.min(168, positiveNumber(source.holidayCacheHours, 12)),
    peakColor: typeof source.peakColor === 'string' && source.peakColor !== '' ? source.peakColor : '#e08a3c',
    valleyColor: typeof source.valleyColor === 'string' && source.valleyColor !== '' ? source.valleyColor : '#4d7fd6',
    topUpUrl: httpsEndpoint(source.topUpUrl, 'https://platform.deepseek.com/top_up')
  }
}

/** `<DSH_HOME>/storages/valley-meter-sidebar/<name>`, falling back to `~/.dsh`. */
function storageFile(name) {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  return join(home, 'storages', 'valley-meter-sidebar', name)
}

const pad2 = (value) => String(value).padStart(2, '0')

/**
 * Beijing civil parts at one instant. China has no DST, so shifting the epoch and
 * reading UTC fields is exact regardless of the host timezone.
 * @returns {{date: string, year: number, weekday: number, hour: number, minute: number}}
 */
export function beijingParts(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  return {
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    year,
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes()
  }
}

/** Beijing weekday predicate at one instant. */
export function isBeijingWeekend(ms) {
  const { weekday } = beijingParts(ms)
  return weekday === 0 || weekday === 6
}

/** Whether the rest-day all-day off-peak policy covers one instant. */
export function isWeekendOffPeakAt(ms, config) {
  return config.weekendOffPeak === true && ms >= WEEKEND_OFFPEAK_FROM_MS && isBeijingWeekend(ms)
}

/** One date's calendar verdict, tolerating a missing calendar. */
function lookupDay(calendar, date) {
  if (calendar === undefined || calendar === null || typeof calendar.lookup !== 'function') return { holiday: null, workday: null }
  try {
    return calendar.lookup(date) ?? { holiday: null, workday: null }
  } catch {
    return { holiday: null, workday: null }
  }
}

/** Whether one instant sits inside a peak window (UTC hours), ignoring the day type. */
function isPeakWindowAt(ms, config) {
  const hours = (ms % DAY_MS) / 3600000
  return config.windows.some((window) => hours >= window.start && hours < window.end)
}

/**
 * The day-type block: what kind of day it is and whether it is off-peak all day.
 * @returns {{parts: object, weekend: boolean, holiday: object|null, workday: object|null, restDay: boolean, offPeakAllDay: boolean, reason: 'holiday'|'weekend'|null}}
 */
export function offPeakDayInfo(ms, config, calendar) {
  const parts = beijingParts(ms)
  const weekend = parts.weekday === 0 || parts.weekday === 6
  const day = lookupDay(calendar, parts.date)
  const restDay = weekend || day.holiday !== null
  const policyActive = config.weekendOffPeak === true && ms >= WEEKEND_OFFPEAK_FROM_MS
  return {
    parts,
    weekend,
    holiday: day.holiday,
    workday: day.workday,
    restDay,
    offPeakAllDay: policyActive && restDay,
    reason: day.holiday !== null ? 'holiday' : weekend ? 'weekend' : null
  }
}

/** Whether one instant is billed at the peak price. */
export function isPeakAt(ms, config, calendar) {
  if (offPeakDayInfo(ms, config, calendar).offPeakAllDay) return false
  return isPeakWindowAt(ms, config)
}

/**
 * Next instant the peak/valley phase flips, scanning forward one minute at a
 * time — exact at the boundary and cheap enough to run per request. The day type
 * is resolved once per Beijing day.
 * @returns {{ at: number, intoPeak: boolean } | undefined}
 */
export function nextSwitch(nowMs, config, calendar) {
  const current = isPeakAt(nowMs, config, calendar)
  const step = 60000
  let date = null
  let restDayOffPeak = false
  for (let at = Math.floor(nowMs / step) * step + step; at <= nowMs + NEXT_SWITCH_HORIZON_MS; at += step) {
    const parts = beijingParts(at)
    if (parts.date !== date) {
      date = parts.date
      const weekend = parts.weekday === 0 || parts.weekday === 6
      const holiday = lookupDay(calendar, date).holiday !== null
      restDayOffPeak = config.weekendOffPeak === true && at >= WEEKEND_OFFPEAK_FROM_MS && (weekend || holiday)
    }
    const peak = restDayOffPeak ? false : isPeakWindowAt(at, config)
    if (peak !== current) return { at, intoPeak: !current }
  }
  return undefined
}

/** The phase block the client renders. */
export function computePeak(nowMs, config, calendar) {
  const info = offPeakDayInfo(nowMs, config, calendar)
  const switching = nextSwitch(nowMs, config, calendar)
  return {
    inPeak: info.offPeakAllDay ? false : isPeakWindowAt(nowMs, config),
    offPeakAllDay: info.offPeakAllDay,
    offPeakReason: info.offPeakAllDay ? info.reason : null,
    holidayName: info.holiday?.name ?? null,
    workdayName: info.workday?.name ?? null,
    weekend: info.weekend,
    nextAtMs: switching === undefined ? null : switching.at,
    nextIntoPeak: switching === undefined ? null : switching.intoPeak,
    weekendRuleActive: config.weekendOffPeak === true && nowMs >= WEEKEND_OFFPEAK_FROM_MS,
    calendar: calendar?.snapshot?.(nowMs) ?? null
  }
}

/** Coerce a wire number, keeping `null` for "absent". */
function wireNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Host half entry point.
 * @param ctx - host plugin context carrying `webServer` (and, at request time, `credentials`).
 * @param config - raw entry config from the profile patch row.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  /** Last successful balance, so a later failure still has something honest to show. */
  let cache = { atMs: 0, value: null, error: null }
  let inflight = undefined

  /**
   * Chinese statutory-holiday calendar. It is primed from the on-disk cache (so a
   * restart already knows the holidays) and refreshed in the background; the
   * route never waits on the network and degrades to the weekday rule when the
   * data is unavailable.
   */
  const calendar = createCalendar({
    urls: settings.holidayUrls,
    storagePath: storageFile('holidays.json'),
    refreshMs: settings.holidayCacheHours * 60 * 60 * 1000,
    extraHolidays: settings.holidays,
    extraWorkdays: settings.workdays,
    onWarn: (message) => ctx.logger?.debug?.(`valley-meter-sidebar: ${message}`)
  })

  /** Resolve the API key for one operation (never cached across operations). */
  const resolveKey = async () => {
    const credentials = ctx.get('credentials', false)
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(settings.envName)
        if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== '') return resolved.value
      } catch (error) {
        ctx.logger?.debug?.(`valley-meter-sidebar: credential lookup failed: ${error?.message ?? error}`)
      }
    }
    const ambient = process.env[settings.envName]
    return typeof ambient === 'string' && ambient !== '' ? ambient : undefined
  }

  /** One `GET /user/balance` round trip, normalized to the wire shape. */
  const fetchBalance = async () => {
    const key = await resolveKey()
    if (key === undefined) throw new Error(`credential ${settings.envName} is not configured`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS)
    try {
      const response = await fetch(`${settings.endpoint}/user/balance`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: controller.signal
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`balance request failed: HTTP ${response.status}${text === '' ? '' : ` ${text.slice(0, 180)}`}`)
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error('balance response was not JSON')
      }
      const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
      const pick = infos.find((info) => info?.currency === settings.currency) ?? infos[0]
      if (pick === undefined) throw new Error('balance response carried no balance_infos entry')
      return {
        ok: true,
        currency: typeof pick.currency === 'string' ? pick.currency : settings.currency,
        total: wireNumber(pick.total_balance),
        granted: wireNumber(pick.granted_balance),
        toppedUp: wireNumber(pick.topped_up_balance),
        available: body?.is_available !== false,
        atMs: Date.now(),
        error: null
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Balance state with a TTL cache; `force` bypasses it (the manual refresh path). */
  const balanceState = async (force) => {
    const nowMs = Date.now()
    if (!force && cache.value !== null && nowMs - cache.atMs < settings.refreshSec * 1000) {
      return { ...cache.value, cached: true }
    }
    if (inflight !== undefined) return inflight
    inflight = (async () => {
      try {
        const value = await fetchBalance()
        cache = { atMs: Date.now(), value, error: null }
        return value
      } catch (error) {
        const message = error?.message ?? String(error)
        cache = { ...cache, error: message }
        return {
          ok: false,
          currency: cache.value?.currency ?? settings.currency,
          total: cache.value?.total ?? null,
          granted: cache.value?.granted ?? null,
          toppedUp: cache.value?.toppedUp ?? null,
          available: cache.value?.available ?? false,
          atMs: cache.value?.atMs ?? null,
          error: message
        }
      } finally {
        inflight = undefined
      }
    })()
    return inflight
  }

  const handle = async (request, response) => {
    if (!isLoopbackRequest(request)) {
      writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' })
      return
    }
    if (request.method !== 'GET') {
      writeJson(response, 405, { ok: false, error: `method not allowed: ${request.method}` })
      return
    }
    let force = false
    try {
      force = new URL(request.url ?? STATE_ROUTE, 'http://localhost').searchParams.get('refresh') === '1'
    } catch {
      force = false
    }
    const nowMs = Date.now()
    // A long-running host can outlive its calendar data (new year, failed first
    // fetch): kick a refresh in the background, never block the response on it.
    if (!calendar.covers(nowMs)) void calendar.refresh(nowMs)
    try {
      writeJson(response, 200, {
        ok: true,
        nowMs,
        peak: computePeak(nowMs, settings, calendar),
        windows: settings.windows,
        balance: await balanceState(force),
        display: {
          refreshSec: settings.refreshSec,
          pollSec: settings.pollSec,
          peakColor: settings.peakColor,
          valleyColor: settings.valleyColor,
          topUpUrl: settings.topUpUrl,
          currency: settings.currency
        }
      })
    } catch (error) {
      ctx.logger?.warn?.(`valley-meter-sidebar: state request failed: ${error?.message ?? error}`)
      writeJson(response, 500, { ok: false, error: error?.message ?? String(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: STATE_ROUTE, handler: handle }), 'valley-meter-sidebar: state route')

  ctx.effect(() => {
    let stopped = false
    const refresh = () => {
      if (!stopped) void calendar.refresh(Date.now())
    }
    refresh()
    const timer = setInterval(refresh, Math.min(settings.holidayCacheHours * 60 * 60 * 1000, 6 * 60 * 60 * 1000))
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, 'valley-meter-sidebar: holiday calendar')
}
