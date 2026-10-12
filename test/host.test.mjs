/**
 * Host-half smoke test: pure tariff logic (peak windows, the rest-day rule) and
 * the loopback fence. Everything runs offline — the holiday calendar is fed a
 * fake transport.
 *   node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_WINDOWS,
  WEEKEND_OFFPEAK_FROM_MS,
  beijingParts,
  computePeak,
  isBeijingWeekend,
  isLoopbackAddress,
  isLoopbackHostname,
  isPeakAt,
  isWeekendOffPeakAt,
  nextSwitch,
  resolveConfig
} from '../lib/index.js'
import { DEFAULT_HOLIDAY_URLS, createCalendar, holidayUrl, normalizeDayList, parseYearPayload } from '../lib/holidays.js'

const config = resolveConfig({})
let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}
const checkAsync = async (label, fn) => {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

/** UTC epoch for a given UTC date/time. */
const utc = (iso) => Date.parse(iso)

console.log('resolveConfig')
check('falls back to the documented defaults', () => {
  assert.deepEqual(config.windows, DEFAULT_WINDOWS.map((w) => ({ ...w })))
  assert.equal(config.endpoint, 'https://api.deepseek.com')
  assert.equal(config.envName, 'DEEPSEEK_API_KEY')
  // The balance TTL is deliberately long (an account endpoint, not a token spend).
  assert.equal(config.refreshSec, 300)
  assert.equal(config.pollSec, 20)
  assert.equal(config.currency, 'CNY')
  assert.equal(config.weekendOffPeak, true)
  assert.deepEqual(config.holidayUrls, [...DEFAULT_HOLIDAY_URLS])
  assert.equal(config.holidayCacheHours, 12)
  assert.deepEqual(config.holidays, [])
  assert.deepEqual(config.workdays, [])
})
check('rejects a plain-http endpoint and a bad env name', () => {
  const patched = resolveConfig({ endpoint: 'http://evil.test', envName: '9bad' })
  assert.equal(patched.endpoint, 'https://api.deepseek.com')
  assert.equal(patched.envName, 'DEEPSEEK_API_KEY')
})
check('clamps the cache TTL and the poll interval to their floors', () => {
  const patched = resolveConfig({ refreshSec: 1, pollSec: 1, windows: [{ start: 2, end: 3 }] })
  assert.equal(patched.refreshSec, 30)
  assert.equal(patched.pollSec, 10)
  assert.deepEqual(patched.windows, [{ start: 2, end: 3 }])
})
check('drops malformed windows and keeps the defaults', () => {
  assert.deepEqual(resolveConfig({ windows: [{ start: 5, end: 5 }, { start: -1, end: 2 }, null] }).windows, DEFAULT_WINDOWS.map((w) => ({ ...w })))
})
check('accepts a custom holiday source and drops a placeholder-less one', () => {
  assert.deepEqual(resolveConfig({ holidayUrl: 'https://mirror.test/h-{year}.json' }).holidayUrls, ['https://mirror.test/h-{year}.json'])
  assert.deepEqual(resolveConfig({ holidayUrls: ['https://mirror.test/fixed.json', 'not a url {year}'] }).holidayUrls, [...DEFAULT_HOLIDAY_URLS])
})

console.log('peak windows (UTC hours)')
check('Monday 01:00Z is peak', () => assert.equal(isPeakAt(utc('2026-08-17T01:00:00Z'), config), true))
check('Monday 03:59Z is peak', () => assert.equal(isPeakAt(utc('2026-08-17T03:59:59Z'), config), true))
check('Monday 04:00Z is valley', () => assert.equal(isPeakAt(utc('2026-08-17T04:00:00Z'), config), false))
check('Monday 06:00Z is peak', () => assert.equal(isPeakAt(utc('2026-08-17T06:00:00Z'), config), true))
check('Monday 10:00Z is valley', () => assert.equal(isPeakAt(utc('2026-08-17T10:00:00Z'), config), false))
check('Monday 23:00Z is valley', () => assert.equal(isPeakAt(utc('2026-08-17T23:00:00Z'), config), false))
check('Monday 00:30Z is valley', () => assert.equal(isPeakAt(utc('2026-08-17T00:30:00Z'), config), false))

console.log('Beijing clock')
check('shifts the epoch to Beijing civil parts', () => {
  assert.deepEqual(beijingParts(utc('2026-10-10T02:00:00Z')), { date: '2026-10-10', year: 2026, weekday: 6, hour: 10, minute: 0 })
  // 16:30Z is already the next Beijing day.
  assert.equal(beijingParts(utc('2026-10-09T16:30:00Z')).date, '2026-10-10')
})

console.log('next switch')
check('from Monday 02:00Z the next switch is 04:00Z into valley', () => {
  const next = nextSwitch(utc('2026-08-17T02:00:00Z'), config)
  assert.equal(new Date(next.at).toISOString(), '2026-08-17T04:00:00.000Z')
  assert.equal(next.intoPeak, false)
})
check('from Monday 05:00Z the next switch is 06:00Z into peak', () => {
  const next = nextSwitch(utc('2026-08-17T05:00:00Z'), config)
  assert.equal(new Date(next.at).toISOString(), '2026-08-17T06:00:00.000Z')
  assert.equal(next.intoPeak, true)
})
check('from Monday 12:00Z the next switch is Tuesday 01:00Z into peak', () => {
  const next = nextSwitch(utc('2026-08-17T12:00:00Z'), config)
  assert.equal(new Date(next.at).toISOString(), '2026-08-18T01:00:00.000Z')
  assert.equal(next.intoPeak, true)
})

console.log('weekend all-day off-peak rule')
check('2026-08-23 is a Beijing Sunday', () => {
  assert.equal(new Date(WEEKEND_OFFPEAK_FROM_MS).toISOString(), '2026-08-22T16:00:00.000Z')
  assert.equal(isBeijingWeekend(WEEKEND_OFFPEAK_FROM_MS), true)
  assert.equal(isBeijingWeekend(utc('2026-08-17T04:00:00Z')), false)
})
check('the rule is inert before its start instant', () => {
  // 2026-08-16 is a Beijing Sunday but precedes the policy start, so the windows still apply.
  assert.equal(isBeijingWeekend(utc('2026-08-16T02:00:00Z')), true)
  assert.equal(isWeekendOffPeakAt(utc('2026-08-16T02:00:00Z'), config), false)
  assert.equal(isPeakAt(utc('2026-08-16T02:00:00Z'), config), true)
})
check('peak hours on the 2026-08-23 Beijing Sunday are off-peak', () => {
  const sundayPeakHour = utc('2026-08-23T02:00:00Z')
  assert.equal(isBeijingWeekend(sundayPeakHour), true)
  assert.equal(isWeekendOffPeakAt(sundayPeakHour, config), true)
  assert.equal(isPeakAt(sundayPeakHour, config), false)
  const peak = computePeak(sundayPeakHour, config)
  assert.equal(peak.inPeak, false)
  assert.equal(peak.offPeakAllDay, true)
  assert.equal(peak.offPeakReason, 'weekend')
  assert.equal(peak.weekendRuleActive, true)
})
check('weekendOffPeak:false disables the rule', () => {
  const strict = resolveConfig({ weekendOffPeak: false })
  assert.equal(isPeakAt(utc('2026-08-23T02:00:00Z'), strict), true)
  assert.equal(isWeekendOffPeakAt(utc('2026-08-23T02:00:00Z'), strict), false)
})

console.log('statutory holidays')
// Fixture standing in for the real holiday-cn payload: 国庆节 2026-10-01..07 off,
// and 2026-10-10 (a Saturday) turned into a makeup workday.
const HOLIDAYS_2026 = {
  year: 2026,
  papers: ['fixture'],
  days: [
    { name: '元旦', date: '2026-01-01', isOffDay: true },
    { name: '国庆节', date: '2026-10-01', isOffDay: true },
    { name: '国庆节', date: '2026-10-02', isOffDay: true },
    { name: '国庆节', date: '2026-10-03', isOffDay: true },
    { name: '国庆节', date: '2026-10-04', isOffDay: true },
    { name: '国庆节', date: '2026-10-05', isOffDay: true },
    { name: '国庆节', date: '2026-10-06', isOffDay: true },
    { name: '国庆节', date: '2026-10-07', isOffDay: true },
    { name: '国庆节', date: '2026-10-10', isOffDay: false }
  ]
}
// The 2027 paper is the one that covers 2026-12-31.
const HOLIDAYS_2027 = { year: 2027, papers: ['fixture'], days: [{ name: '元旦', date: '2026-12-31', isOffDay: true }] }

/** The holiday fixture as a plain `lookup` stand-in, for the tariff predicates. */
const nationalDay = {
  lookup(date) {
    if (date >= '2026-10-01' && date <= '2026-10-07') return { holiday: { name: '国庆节' }, workday: null }
    if (date === '2026-10-10') return { holiday: null, workday: { name: '国庆节' } }
    return { holiday: null, workday: null }
  }
}

check('a holiday swallows the weekday peak windows', () => {
  const inside = utc('2026-10-01T02:00:00Z') // Thursday 10:00 Beijing
  assert.equal(isPeakAt(inside, config, nationalDay), false)
  const peak = computePeak(inside, config, nationalDay)
  assert.equal(peak.offPeakAllDay, true)
  assert.equal(peak.offPeakReason, 'holiday')
  assert.equal(peak.holidayName, '国庆节')
  assert.equal(peak.inPeak, false)
})
check('the first workday after the holiday is peak again', () => {
  assert.equal(isPeakAt(utc('2026-10-08T02:00:00Z'), config, nationalDay), true) // Thursday
  assert.equal(isPeakAt(utc('2026-10-12T01:00:00Z'), config, nationalDay), true) // Monday 09:00
})
check('a 调休 makeup Saturday is reported but still bills off-peak', () => {
  const makeup = utc('2026-10-10T02:00:00Z') // Saturday 10:00 Beijing
  assert.equal(isPeakAt(makeup, config, nationalDay), false)
  const peak = computePeak(makeup, config, nationalDay)
  assert.equal(peak.weekend, true)
  assert.equal(peak.workdayName, '国庆节')
  assert.equal(peak.holidayName, null)
  assert.equal(peak.offPeakAllDay, true)
  assert.equal(peak.offPeakReason, 'weekend')
})
check('next switch skips a whole holiday block', () => {
  // Friday 2026-10-09 18:30 Beijing -> Monday 2026-10-12 09:00 Beijing.
  const afterWork = nextSwitch(utc('2026-10-09T10:30:00Z'), config, nationalDay)
  assert.equal(new Date(afterWork.at).toISOString(), '2026-10-12T01:00:00.000Z')
  assert.equal(afterWork.intoPeak, true)
  // Wednesday 2026-09-30 18:30 Beijing -> Thursday 2026-10-08 09:00 Beijing.
  const beforeHoliday = nextSwitch(utc('2026-09-30T10:30:00Z'), config, nationalDay)
  assert.equal(new Date(beforeHoliday.at).toISOString(), '2026-10-08T01:00:00.000Z')
})
check('without calendar data the plain weekday rule still applies', () => {
  assert.equal(isPeakAt(utc('2026-10-01T02:00:00Z'), config), true)
  assert.equal(computePeak(utc('2026-10-01T02:00:00Z'), config).holidayName, null)
})

console.log('holiday payload parsing')
check('normalizes date lists and payloads', () => {
  assert.deepEqual([...normalizeDayList(['2026-10-01', { date: '2026-10-02', name: 'X' }, 'nope', null]).entries()], [
    ['2026-10-01', ''],
    ['2026-10-02', 'X']
  ])
  assert.equal(parseYearPayload(null), undefined)
  assert.equal(parseYearPayload({ days: 'x' }), undefined)
  assert.equal(parseYearPayload({ year: 2026, days: [] }), undefined)
  const parsed = parseYearPayload(HOLIDAYS_2026, 2026)
  assert.equal(parsed.year, 2026)
  assert.deepEqual(parsed.days.get('2026-10-10'), { name: '国庆节', isOffDay: false })
})
check('fills the {year} placeholder', () => {
  assert.equal(holidayUrl('https://x.test/{year}.json', 2026), 'https://x.test/2026.json')
})

console.log('holiday calendar')
await checkAsync('falls through the mirror list and answers lookups', async () => {
  const seen = []
  const calendar = createCalendar({
    urls: ['https://a.test/{year}.json', 'https://b.test/{year}.json'],
    storagePath: null,
    refreshMs: 60 * 60 * 1000,
    fetchJson: async (url) => {
      seen.push(url)
      if (url.startsWith('https://a.test')) throw new Error('mirror down')
      return HOLIDAYS_2026
    }
  })
  assert.equal(await calendar.ensure(2026), true)
  assert.deepEqual(seen, ['https://a.test/2026.json', 'https://b.test/2026.json'])
  assert.deepEqual(calendar.lookup('2026-10-01'), { holiday: { name: '国庆节' }, workday: null })
  assert.deepEqual(calendar.lookup('2026-10-10'), { holiday: null, workday: { name: '国庆节' } })
  assert.deepEqual(calendar.lookup('2026-10-09'), { holiday: null, workday: null })
  assert.equal(calendar.covers(utc('2026-10-01T00:00:00Z')), true)
  const snapshot = calendar.snapshot(utc('2026-10-01T00:00:00Z'))
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.stale, false)
  assert.deepEqual(snapshot.sources, ['https://b.test/2026.json'])
})
await checkAsync('consults the next year for late-December dates', async () => {
  const calendar = createCalendar({
    urls: ['https://a.test/{year}.json'],
    storagePath: null,
    fetchJson: async (url) => (url.endsWith('2027.json') ? HOLIDAYS_2027 : HOLIDAYS_2026)
  })
  await calendar.ensure(2026)
  assert.deepEqual(calendar.lookup('2026-12-31'), { holiday: null, workday: null })
  await calendar.ensure(2027)
  assert.deepEqual(calendar.lookup('2026-12-31'), { holiday: { name: '元旦' }, workday: null })
})
await checkAsync('records a failure instead of throwing, and honours config overrides', async () => {
  const offline = createCalendar({
    urls: ['https://a.test/{year}.json'],
    storagePath: null,
    fetchJson: async () => {
      throw new Error('offline')
    }
  })
  assert.equal(await offline.ensure(2026), false)
  assert.match(offline.snapshot(utc('2026-10-01T00:00:00Z')).error, /offline/)
  assert.deepEqual(offline.lookup('2026-10-01'), { holiday: null, workday: null })

  const overridden = createCalendar({
    urls: ['https://a.test/{year}.json'],
    storagePath: null,
    fetchJson: async () => HOLIDAYS_2026,
    extraHolidays: ['2026-11-11', { date: '2026-11-12', name: '自定假日' }],
    extraWorkdays: ['2026-11-14']
  })
  assert.deepEqual(overridden.lookup('2026-11-11'), { holiday: { name: '' }, workday: null })
  assert.deepEqual(overridden.lookup('2026-11-12'), { holiday: { name: '自定假日' }, workday: null })
  assert.deepEqual(overridden.lookup('2026-11-14'), { holiday: null, workday: { name: '' } })
})
await checkAsync('starts from the on-disk cache when the network is gone', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'valley-meter-holidays-'))
  const storagePath = join(directory, 'holidays.json')
  try {
    const warm = createCalendar({ urls: ['https://a.test/{year}.json'], storagePath, fetchJson: async () => HOLIDAYS_2026 })
    assert.equal(await warm.ensure(2026), true)
    const cold = createCalendar({
      urls: ['https://a.test/{year}.json'],
      storagePath,
      fetchJson: async () => {
        throw new Error('offline')
      }
    })
    assert.deepEqual(cold.lookup('2026-10-01'), { holiday: { name: '国庆节' }, workday: null })
    assert.equal(isPeakAt(utc('2026-10-01T02:00:00Z'), config, cold), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
await checkAsync('ignores a corrupt cache file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'valley-meter-holidays-'))
  const storagePath = join(directory, 'holidays.json')
  try {
    writeFileSync(storagePath, '{ not json', 'utf8')
    const calendar = createCalendar({ urls: ['https://a.test/{year}.json'], storagePath, fetchJson: async () => HOLIDAYS_2026 })
    assert.deepEqual(calendar.lookup('2026-10-01'), { holiday: null, workday: null })
    assert.equal(await calendar.ensure(2026), true)
    assert.deepEqual(calendar.lookup('2026-10-01'), { holiday: { name: '国庆节' }, workday: null })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

console.log('computePeak')
check('reports the current phase and the coming switch', () => {
  const peak = computePeak(utc('2026-08-17T07:00:00Z'), config)
  assert.equal(peak.inPeak, true)
  assert.equal(peak.offPeakAllDay, false)
  assert.equal(peak.offPeakReason, null)
  assert.equal(new Date(peak.nextAtMs).toISOString(), '2026-08-17T10:00:00.000Z')
  assert.equal(peak.nextIntoPeak, false)
  assert.equal(peak.calendar, null)
})

console.log('loopback fence')
check('accepts loopback addresses', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true, address)
})
check('rejects everything else', () => {
  for (const address of ['10.0.0.1', '192.168.1.5', '8.8.8.8', '::ffff:10.0.0.1', '127.0.0.256', '127.0.0', 'localhost', undefined]) {
    assert.equal(isLoopbackAddress(address), false, String(address))
  }
})
check('hostnames', () => {
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('evil.test'), false)
  assert.equal(isLoopbackHostname('localhost.evil.test'), false)
})

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
