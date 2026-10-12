/**
 * Chinese statutory-holiday calendar for the tariff logic.
 *
 * Peak pricing only covers Beijing Monday-Friday 09:00-12:00 / 14:00-18:00 *and*
 * only when that date is not a statutory holiday; every rest day — weekend,
 * statutory holiday, and the makeup workdays (调休) that land on a weekend — is
 * billed off-peak all day. Deciding that needs a real calendar, not `getDay()`,
 * because a Thursday inside 国庆节 is off-peak while a Saturday that the State
 * Council turned into a workday still is.
 *
 * Data comes from [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn),
 * which scrapes the State Council announcement into
 * `{year, papers, days:[{name, date, isOffDay}]}`. `isOffDay:false` marks a
 * 调休 makeup workday. The upstream README warns that late-December dates can be
 * covered by the *next* year's paper, so a date is looked up in its own year and
 * in the following one.
 *
 * Fetched payloads are cached in memory and on disk so an offline start still
 * knows the holidays, and a failed fetch degrades to the plain
 * weekend + window rule instead of breaking the route.
 *
 * @module dsh-valley-meter-sidebar/holidays
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Mirrors tried in order; `{year}` is replaced with the four-digit year. */
export const DEFAULT_HOLIDAY_URLS = Object.freeze([
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json'
])

/** How long a fetched year stays fresh before it is fetched again. */
export const HOLIDAY_REFRESH_MS = 12 * 60 * 60 * 1000

/** Per-mirror request timeout. */
const HOLIDAY_TIMEOUT_MS = 10000

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Whether a value looks like an ISO calendar date. */
export function isDateString(value) {
  return typeof value === 'string' && DATE_PATTERN.test(value)
}

/** The four-digit year of an ISO date string. */
export function yearOf(date) {
  const year = Number(String(date).slice(0, 4))
  return Number.isInteger(year) ? year : undefined
}

/** Normalize one `{date, name}`-ish value; returns `undefined` when unusable. */
function normalizeDay(value) {
  if (typeof value === 'string') return isDateString(value) ? { date: value, name: '' } : undefined
  if (value === null || typeof value !== 'object') return undefined
  if (!isDateString(value.date)) return undefined
  return { date: value.date, name: typeof value.name === 'string' ? value.name : '' }
}

/** Normalize a config-supplied date list into a `Map<date, name>`. */
export function normalizeDayList(value) {
  const map = new Map()
  for (const entry of Array.isArray(value) ? value : []) {
    const day = normalizeDay(entry)
    if (day !== undefined) map.set(day.date, day.name)
  }
  return map
}

/**
 * Normalize one holiday-cn year payload.
 * @returns {{year: number, days: Map<string, {name: string, isOffDay: boolean}>} | undefined}
 */
export function parseYearPayload(payload, fallbackYear) {
  if (payload === null || typeof payload !== 'object') return undefined
  if (!Array.isArray(payload.days)) return undefined
  const days = new Map()
  for (const entry of payload.days) {
    if (entry === null || typeof entry !== 'object') continue
    if (!isDateString(entry.date)) continue
    days.set(entry.date, {
      name: typeof entry.name === 'string' ? entry.name : '',
      isOffDay: entry.isOffDay === true
    })
  }
  if (days.size === 0) return undefined
  const year = Number.isInteger(payload.year) ? payload.year : fallbackYear
  return Number.isInteger(year) ? { year, days } : undefined
}

/** Default transport: one JSON GET with a timeout. */
async function defaultFetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HOLIDAY_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Fill a template's `{year}` placeholder. */
export function holidayUrl(template, year) {
  return String(template).replace(/\{year\}/g, String(year))
}

/**
 * Build a calendar. Every network call is injectable so tests stay offline.
 *
 * @param {object} [options]
 * @param {string[]} [options.urls] URL templates (each with a `{year}` placeholder).
 * @param {(url: string) => Promise<unknown>} [options.fetchJson] transport override.
 * @param {string|null} [options.storagePath] disk cache path; `null` disables the cache.
 * @param {number} [options.refreshMs] per-year freshness window.
 * @param {unknown} [options.extraHolidays] config dates always treated as rest days.
 * @param {unknown} [options.extraWorkdays] config dates treated as makeup workdays.
 * @param {(message: string) => void} [options.onWarn] diagnostic sink.
 */
export function createCalendar(options = {}) {
  const urls = Array.isArray(options.urls) && options.urls.length > 0 ? options.urls : DEFAULT_HOLIDAY_URLS
  const fetchJson = typeof options.fetchJson === 'function' ? options.fetchJson : defaultFetchJson
  const storagePath = options.storagePath === null ? null : options.storagePath
  const refreshMs = Number.isFinite(options.refreshMs) && options.refreshMs > 0 ? options.refreshMs : HOLIDAY_REFRESH_MS
  const onWarn = typeof options.onWarn === 'function' ? options.onWarn : () => {}
  const extraHolidays = normalizeDayList(options.extraHolidays)
  const extraWorkdays = normalizeDayList(options.extraWorkdays)

  /** @type {Map<number, {source: string, fetchedAtMs: number, days: Map<string, {name: string, isOffDay: boolean}>}>} */
  const years = new Map()
  const inflight = new Map()
  /** Per-year last failure. A missing *next* year is normal (the paper is published late in December), so only the year a decision actually needs is reported upward. */
  const errors = new Map()

  const dayOf = (year, date) => {
    const loaded = years.get(year)
    return loaded === undefined ? undefined : loaded.days.get(date)
  }

  /**
   * The calendar entry for one Beijing date.
   * @returns {{holiday: {name: string}|null, workday: {name: string}|null}}
   */
  function lookup(date) {
    if (!isDateString(date)) return { holiday: null, workday: null }
    if (extraHolidays.has(date)) return { holiday: { name: extraHolidays.get(date) ?? '' }, workday: null }
    const year = yearOf(date)
    // The next year's paper can cover late-December dates of this year.
    for (const candidate of [year, year + 1]) {
      const entry = dayOf(candidate, date)
      if (entry === undefined) continue
      return entry.isOffDay
        ? { holiday: { name: entry.name }, workday: null }
        : { holiday: null, workday: { name: entry.name } }
    }
    const extra = extraWorkdays.get(date)
    return { holiday: null, workday: extra === undefined ? null : { name: extra } }
  }

  function remember(year, source, days) {
    years.set(year, { source, fetchedAtMs: Date.now(), days })
    errors.delete(year)
  }

  function readCache() {
    if (storagePath === null || storagePath === undefined) return
    let parsed
    try {
      parsed = JSON.parse(readFileSync(storagePath, 'utf8'))
    } catch {
      return
    }
    const stored = parsed?.years
    if (stored === null || typeof stored !== 'object') return
    for (const [key, value] of Object.entries(stored)) {
      const year = Number(key)
      if (!Number.isInteger(year)) continue
      const normalized = parseYearPayload(value, year)
      if (normalized === undefined) continue
      years.set(year, {
        source: typeof value.source === 'string' ? value.source : 'cache',
        fetchedAtMs: Number.isFinite(value.fetchedAtMs) ? value.fetchedAtMs : 0,
        days: normalized.days
      })
    }
  }

  async function persist() {
    if (storagePath === null || storagePath === undefined || years.size === 0) return
    const body = { version: 1, years: {} }
    for (const [year, loaded] of years) {
      body.years[String(year)] = {
        source: loaded.source,
        fetchedAtMs: loaded.fetchedAtMs,
        days: [...loaded.days].map(([date, entry]) => ({ date, name: entry.name, isOffDay: entry.isOffDay }))
      }
    }
    try {
      await mkdir(dirname(storagePath), { recursive: true })
      const temporary = `${storagePath}.tmp`
      await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
      await rename(temporary, storagePath)
    } catch (cause) {
      onWarn(`holiday cache write failed: ${cause?.message ?? cause}`)
    }
  }

  function isFresh(loaded) {
    return loaded !== undefined && Date.now() - loaded.fetchedAtMs < refreshMs
  }

  /** Load one year unless it is already loaded and fresh; failures are recorded, never thrown. */
  function ensure(year) {
    if (!Number.isInteger(year)) return Promise.resolve(false)
    if (isFresh(years.get(year))) return Promise.resolve(true)
    const pending = inflight.get(year)
    if (pending !== undefined) return pending
    const task = (async () => {
      let lastError = null
      for (const template of urls) {
        const url = holidayUrl(template, year)
        try {
          const parsed = parseYearPayload(await fetchJson(url), year)
          if (parsed === undefined) throw new Error('payload carried no usable days')
          if (parsed.year !== year) throw new Error(`payload year ${parsed.year} != ${year}`)
          remember(year, url, parsed.days)
          await persist()
          return true
        } catch (cause) {
          lastError = cause
        }
      }
      const failure = `${year}: ${lastError?.message ?? lastError}`
      errors.set(year, failure)
      onWarn(`holiday fetch failed: ${failure}`)
      return false
    })()
    inflight.set(year, task)
    return task.finally(() => inflight.delete(year))
  }

  /** Ensure the years a tariff decision can need. */
  async function refresh(nowMs = Date.now()) {
    const year = new Date(nowMs).getUTCFullYear()
    await ensure(year)
    return ensure(year + 1)
  }

  /** Whether the calendar already knows the given instant's year. */
  function covers(nowMs = Date.now()) {
    return years.has(new Date(nowMs).getUTCFullYear())
  }

  /** Wire-safe metadata: no date lists, just where the data stands. */
  function snapshot(nowMs = Date.now()) {
    const year = new Date(nowMs).getUTCFullYear()
    const loaded = years.get(year)
    const sources = [...years.values()].map((entry) => entry.source)
    return {
      ok: loaded !== undefined,
      stale: !isFresh(loaded),
      years: [...years.keys()].sort(),
      sources,
      fetchedAtMs: loaded === undefined ? null : loaded.fetchedAtMs,
      error: errors.get(year) ?? null
    }
  }

  readCache()

  return { lookup, ensure, refresh, covers, snapshot, years }
}
