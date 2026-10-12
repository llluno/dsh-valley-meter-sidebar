/**
 * Client-half test: loads lib/client.js the way the DSH ModuleLoader does,
 * asserts the slot contributions it publishes, then renders the component tree
 * with a minimal React shim and canned host data so the 24h geometry, the local
 * time conversion and the compact-rail switch can all be checked exactly.
 *
 *   TZ=Asia/Shanghai node test/client.test.mjs
 */
process.env.TZ = 'Asia/Shanghai'
if (new Date().getTimezoneOffset() !== -480) {
  console.error('this test needs a Beijing clock; run it as: TZ=Asia/Shanghai node test/client.test.mjs')
  process.exit(2)
}

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

// ---------------------------------------------------------------- minimal React
let hookIndex = 0
let canned = {}

function createElement(type, props, ...children) {
  const flat = []
  const push = (child) => {
    if (Array.isArray(child)) child.forEach(push)
    else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child)
  }
  children.forEach(push)
  return { type, props: props ?? {}, children: flat }
}

const React = {
  createElement,
  useState(initial) {
    const index = hookIndex
    hookIndex += 1
    if (index in canned) return [canned[index], () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useRef(initial) {
    return { current: typeof initial === 'function' ? initial() : initial }
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {}
}

// ------------------------------------------------------- load the client bundle
let captured
globalThis.window = { __ModuleLoader__: { load: (bundle) => (captured = bundle) } }
const requested = []
await import('../lib/client.js')
if (captured === undefined) {
  console.error('lib/client.js did not call window.__ModuleLoader__.load')
  process.exit(1)
}
const plugin = captured.factory((specifier) => {
  requested.push(specifier)
  if (specifier === 'react') return React
  throw new Error(`unexpected module request: ${specifier}`)
})

// ------------------------------------------------------------- fake client ctx
const registry = []
const localeDicts = {}
const disposers = []
const interpolate = (template, vars) =>
  typeof template !== 'string' ? '' : template.replace(/\{(\w+)\}/g, (match, key) => (vars !== null && typeof vars === 'object' && key in vars ? String(vars[key]) : match))
const ctx = {
  locale: {
    register(ns, locale, dict) {
      localeDicts[locale] = dict
      return () => {}
    },
    bind(ns) {
      return (key, vars) => interpolate(localeDicts.zh?.[key] ?? key, vars)
    }
  },
  slots: {
    inject(owner, factory) {
      const dispose = factory()
      disposers.push(dispose)
      return () => {}
    },
    register(options, Component) {
      registry.push({ options, Component })
      return () => {}
    }
  },
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return () => {}
  }
}
// ------------------------------------------------------- fake DOM stylesheet
// The bundle must own its <style> explicitly (the module loader claims and then
// deletes untagged style tags), so the harness has to observe document.head.
const styleTags = []
globalThis.document = {
  head: {
    appendChild(tag) {
      styleTags.push(tag)
      return tag
    }
  },
  createElement(tagName) {
    if (tagName !== 'style') throw new Error(`unexpected createElement: ${tagName}`)
    return {
      dataset: {},
      textContent: '',
      remove() {
        const index = styleTags.indexOf(this)
        if (index >= 0) styleTags.splice(index, 1)
      }
    }
  },
  querySelector(selector) {
    const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector)
    if (match === null) throw new Error(`unexpected selector: ${selector}`)
    return styleTags.find((tag) => tag.dataset.pluginCss === match[1]) ?? null
  }
}

plugin.apply(ctx)

// ------------------------------------------------------------- tree inspection
const walk = (node, visit) => {
  if (node === null || typeof node !== 'object') return
  visit(node)
  // Expand function components in place so their output is inspectable too.
  if (typeof node.type === 'function') {
    walk(node.type(node.props), visit)
    return
  }
  node.children.forEach((child) => walk(child, visit))
}
const findAll = (tree, className) => {
  const found = []
  walk(tree, (node) => {
    const value = node.props?.className
    if (typeof value === 'string' && value.split(' ').includes(className)) found.push(node)
  })
  return found
}
const findOne = (tree, className) => {
  const found = findAll(tree, className)
  if (found.length !== 1) throw new Error(`expected exactly one .${className}, found ${found.length}`)
  return found[0]
}
const textOf = (node) => (typeof node === 'string' ? node : node.children.map(textOf).join(''))

const STAMP = Date.parse('2026-08-17T07:00:00Z')
const CALENDAR = {
  ok: true,
  stale: false,
  years: [2026],
  sources: ['https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json'],
  fetchedAtMs: Date.parse('2026-08-17T06:00:00Z'),
  error: null
}
const peakOf = (overrides = {}) => ({
  inPeak: true,
  offPeakAllDay: false,
  offPeakReason: null,
  holidayName: null,
  workdayName: null,
  weekend: false,
  nextAtMs: Date.parse('2026-08-17T10:00:00Z'),
  nextIntoPeak: false,
  weekendRuleActive: true,
  calendar: CALENDAR,
  ...overrides
})
const snapshot = (overrides = {}) => ({
  ok: true,
  nowMs: STAMP,
  windows: [
    { start: 1, end: 4 },
    { start: 6, end: 10 }
  ],
  peak: peakOf(),
  balance: { ok: true, currency: 'CNY', total: 42.5, granted: 0, toppedUp: 42.5, available: true, atMs: Date.parse('2026-08-17T06:59:00Z'), error: null },
  display: { pollSec: 20, refreshSec: 300, peakColor: '#e08a3c', valleyColor: '#4d7fd6', topUpUrl: 'https://platform.deepseek.com/top_up', currency: 'CNY' },
  offline: false,
  receivedAtMs: STAMP,
  ...overrides
})

/** Render one component with the given canned hook values. */
const render = (Component, props, values) => {
  canned = values
  hookIndex = 0
  return Component(props)
}

console.log('module shape')
check('loads under the package id', () => {
  if (captured.id !== 'dsh-valley-meter-sidebar') throw new Error(`bundle id was ${captured.id}`)
})
check('requests only react', () => {
  if (requested.length !== 1 || requested[0] !== 'react') throw new Error(`requested ${JSON.stringify(requested)}`)
})
check('publishes name and client services', () => {
  if (plugin.name !== 'valley-meter-sidebar') throw new Error(`name was ${plugin.name}`)
  if (JSON.stringify(plugin.inject) !== JSON.stringify(['slots', 'locale'])) throw new Error(`inject was ${JSON.stringify(plugin.inject)}`)
})

console.log('slot contributions')
check('registers the panel row and the main page', () => {
  const slots = registry.map((entry) => entry.options.name)
  if (JSON.stringify(slots) !== JSON.stringify(['sidebar.panellist', 'main'])) throw new Error(`registered ${JSON.stringify(slots)}`)
})
check('the row is the last panel entry and carries a label thunk', () => {
  const { options } = registry[0]
  if (options.id !== 'valley-meter-sidebar') throw new Error(`id was ${options.id}`)
  if (options.order !== 100) throw new Error(`order was ${options.order}`)
  if (typeof options.label !== 'function') throw new Error('label is not a thunk')
  if (options.label() !== '峰谷电表') throw new Error(`label resolved to ${options.label()}`)
})
check('the main page is keyed by the same id', () => {
  const { options } = registry[1]
  if (options.key !== 'valley-meter-sidebar') throw new Error(`key was ${options.key}`)
})
check('registers both locale dictionaries', () => {
  if (typeof localeDicts.zh?.panel !== 'string' || typeof localeDicts.en?.panel !== 'string') throw new Error(`saw ${Object.keys(localeDicts)}`)
})

console.log('strip: wide sidebar')
const wide = render(registry[0].Component, { size: 16, active: false }, { 0: snapshot(), 1: STAMP })
check('root is a plain span so it can live inside the panel-row button', () => {
  if (wide.type !== 'span') throw new Error(`root was <${wide.type}>`)
  if (wide.props.className !== 'vmx-root') throw new Error(`class was ${wide.props.className}`)
})
check('phase colour comes from the light cartoon theme while in peak', () => {
  if (wide.props.style['--vmx-phase'] !== '#ffb35c') throw new Error(`saw ${wide.props.style['--vmx-phase']}`)
  if (wide.props.style['--vmx-phase-soft'] !== 'rgba(255, 179, 92, 0.17)') throw new Error(`soft tint was ${wide.props.style['--vmx-phase-soft']}`)
  if (wide.props.style['--vmx-ink'] !== 'rgb(97, 68, 35)') throw new Error(`ink was ${wide.props.style['--vmx-ink']}`)
})
check('the rounded strip background and the anchor-aware row rules ship in the owned stylesheet', () => {
  const css = styleTags[0].textContent
  if (!/\.vmx-root\{[^}]*border-radius:14px/.test(css)) throw new Error('root has no rounded box')
  if (!/\.vmx-root\{[^}]*background:var\(--vmx-phase-soft\)/.test(css)) throw new Error('root has no tinted background')
  // The slot arrives through a display:contents anchor div, so these must be
  // descendant selectors — direct-child ones silently never match.
  if (!css.includes('button:has(.vmx-root) > span:has(.vmx-root)')) throw new Error('no descendant stretch rule')
  if (!css.includes('button:has(.vmx-root) > span:not(:has(.vmx-root))')) throw new Error('no title-hiding rule')
  if (css.includes('button:has(> span > .vmx-root)')) throw new Error('direct-child rule revived')
})
check('badge reads 峰', () => {
  if (textOf(findOne(wide, 'vmx-badge')) !== '峰') throw new Error(`saw ${textOf(findOne(wide, 'vmx-badge'))}`)
})
check('peak segments land on Beijing 09:00-12:00 and 14:00-18:00', () => {
  const segments = findAll(wide, 'vmx-seg').map((node) => [node.props.style.left, node.props.style.width])
  const expected = [
    ['37.5%', '12.5%'],
    ['58.333333333333336%', '16.666666666666664%']
  ]
  if (JSON.stringify(segments) !== JSON.stringify(expected)) throw new Error(`saw ${JSON.stringify(segments)}`)
})
check('the now marker sits at local 15:00', () => {
  const marker = findOne(wide, 'vmx-marker')
  if (marker.props.style.left !== '62.5%') throw new Error(`saw ${marker.props.style.left}`)
})
check('ticks run 00/06/12/18/24', () => {
  const ticks = textOf(findOne(wide, 'vmx-ticks'))
  if (ticks !== '0006121824') throw new Error(`saw ${ticks}`)
})
check('balance renders as ¥ 42.50', () => {
  const balance = findOne(wide, 'vmx-bal')
  if (textOf(balance) !== '¥42.50') throw new Error(`saw ${textOf(balance)}`)
})
check('the tooltip carries phase, countdown and balance', () => {
  const title = wide.props.title
  if (typeof title !== 'string') throw new Error('no title')
  for (const fragment of ['峰谷电表', '峰', '3h00m', 'CNY 42.50']) {
    if (!title.includes(fragment)) throw new Error(`title ${JSON.stringify(title)} lacks ${fragment}`)
  }
})
check('the stylesheet is owned in document.head under our own bundle id', () => {
  if (styleTags.length !== 1) throw new Error(`saw ${styleTags.length} style tags`)
  const tag = styleTags[0]
  if (tag.dataset.plugin !== 'dsh-valley-meter-sidebar') throw new Error(`data-plugin was ${tag.dataset.plugin}`)
  if (tag.dataset.pluginCss !== 'dsh-valley-meter-sidebar/styles.css') throw new Error(`data-plugin-css was ${tag.dataset.pluginCss}`)
  if (!tag.textContent.includes('.vmx-track')) throw new Error('owned tag has no track rule')
})
check('no anonymous <style> is left inside the component tree', () => {
  walk(wide, (node) => {
    if (node.type === 'style') throw new Error('anonymous <style> found in the tree')
  })
})
check('the stylesheet heals itself after a host-side sweep', () => {
  // Mirrors `removeOwnedStyles` in dsh-client-modules: the tag vanishes from head.
  styleTags.splice(0)
  render(registry[0].Component, { size: 16 }, { 0: snapshot(), 1: STAMP })
  if (styleTags.length !== 1) throw new Error(`after the sweep there are ${styleTags.length} tags`)
  if (styleTags[0].dataset.plugin !== 'dsh-valley-meter-sidebar') throw new Error('healed tag is untagged')
})

console.log('strip: off-peak and failure states')
const valley = render(registry[0].Component, { size: 16 }, { 0: snapshot({ peak: peakOf({ inPeak: false, nextIntoPeak: true }) }), 1: STAMP })
check('off-peak uses the valley colour and the 谷 badge', () => {
  if (valley.props.style['--vmx-phase'] !== '#7ecbff') throw new Error(`saw ${valley.props.style['--vmx-phase']}`)
  if (textOf(findOne(valley, 'vmx-badge')) !== '谷') throw new Error(`saw ${textOf(findOne(valley, 'vmx-badge'))}`)
})
const weekend = render(registry[0].Component, { size: 16 }, {
  0: snapshot({ peak: peakOf({ inPeak: false, offPeakAllDay: true, offPeakReason: 'weekend', weekend: true, nextAtMs: null, nextIntoPeak: null }) }),
  1: STAMP
})
check('a rest day badges 谷, tags 周末 and draws no peak segments', () => {
  if (textOf(findOne(weekend, 'vmx-badge')) !== '谷') throw new Error(`saw ${textOf(findOne(weekend, 'vmx-badge'))}`)
  if (textOf(findOne(weekend, 'vmx-tag')) !== '周末') throw new Error(`saw ${textOf(findOne(weekend, 'vmx-tag'))}`)
  if (findAll(weekend, 'vmx-seg').length !== 0) throw new Error('peak segments survived on a rest day')
  if (findOne(weekend, 'vmx-marker') === undefined) throw new Error('the now marker vanished')
  if (weekend.props.title.includes('后')) throw new Error('unexpected countdown')
})
const holiday = render(registry[0].Component, { size: 16 }, {
  0: snapshot({ peak: peakOf({ inPeak: false, offPeakAllDay: true, offPeakReason: 'holiday', holidayName: '国庆节', nextAtMs: null, nextIntoPeak: null }) }),
  1: STAMP
})
check('a statutory holiday tags its name and explains the off-peak price', () => {
  const tag = findOne(holiday, 'vmx-tag')
  if (textOf(tag) !== '国庆节') throw new Error(`saw ${textOf(tag)}`)
  if (!tag.props.className.includes('vmx-tag-holiday')) throw new Error(`class was ${tag.props.className}`)
  if (!tag.props.title.includes('低谷价')) throw new Error(`title was ${tag.props.title}`)
  if (findAll(holiday, 'vmx-seg').length !== 0) throw new Error('peak segments survived on a holiday')
})
const makeup = render(registry[0].Component, { size: 16 }, {
  0: snapshot({ peak: peakOf({ inPeak: false, offPeakAllDay: true, offPeakReason: 'weekend', weekend: true, workdayName: '国庆节', nextAtMs: null, nextIntoPeak: null }) }),
  1: STAMP
})
check('a 调休 makeup workday is labelled and still bills off-peak', () => {
  const tag = findOne(makeup, 'vmx-tag')
  if (textOf(tag) !== '调休上班') throw new Error(`saw ${textOf(tag)}`)
  if (!tag.props.className.includes('vmx-tag-makeup')) throw new Error(`class was ${tag.props.className}`)
  if (!tag.props.title.includes('国庆节')) throw new Error(`title was ${tag.props.title}`)
  if (findAll(makeup, 'vmx-seg').length !== 0) throw new Error('peak segments survived on a makeup weekend')
})
check('an ordinary weekday carries no day tag', () => {
  if (findAll(wide, 'vmx-tag').length !== 0) throw new Error('unexpected day tag on a workday')
})
const broken = render(registry[0].Component, { size: 16 }, { 0: snapshot({ balance: { ok: false, currency: 'CNY', total: null, error: 'credential DEEPSEEK_API_KEY is not configured' } }), 1: STAMP })
check('a failed balance falls back to a dimmed ¥ --', () => {
  const balance = findOne(broken, 'vmx-bal')
  if (textOf(balance) !== '¥--') throw new Error(`saw ${textOf(balance)}`)
  if (!balance.props.className.includes('vmx-err')) throw new Error(`class was ${balance.props.className}`)
  if (!broken.props.title.includes('DEEPSEEK_API_KEY')) throw new Error('error missing from title')
})
const offline = render(registry[0].Component, { size: 16 }, { 0: null, 1: STAMP })
check('before the first response it still renders placeholders', () => {
  if (textOf(findOne(offline, 'vmx-badge')) !== '--') throw new Error(`saw ${textOf(findOne(offline, 'vmx-badge'))}`)
  if (textOf(findOne(offline, 'vmx-bal')) !== '¥--') throw new Error(`saw ${textOf(findOne(offline, 'vmx-bal'))}`)
})

console.log('strip: collapsed rail')
const rail = render(registry[0].Component, { size: 18, active: false }, { 0: snapshot(), 1: STAMP })
check('collapses to a single phase dot', () => {
  if (rail.props.className !== 'vmx-root') throw new Error(`class was ${rail.props.className}`)
  if (findAll(rail, 'vmx-dot').length !== 1) throw new Error('no dot')
  if (findAll(rail, 'vmx-badge').length !== 0 || findAll(rail, 'vmx-bal').length !== 0) throw new Error('wide content rendered in the rail')
  if (rail.props.style['--vmx-phase'] !== '#ffb35c') throw new Error('dot has no phase colour')
})

console.log('main page')
const page = render(registry[1].Component, {}, { 0: snapshot(), 1: STAMP, 2: false })
check('renders the locale-bound title and both peak windows in local time', () => {
  if (textOf(findOne(page, 'vmx-page-title')) !== '峰谷电表') throw new Error(`saw ${textOf(findOne(page, 'vmx-page-title'))}`)
  const body = textOf(page)
  if (!body.includes('09:00-12:00  14:00-18:00')) throw new Error(`windows missing from ${body}`)
})
check('lists phase, next switch, balance and refresh time', () => {
  const body = textOf(page)
  for (const fragment of ['当前时段', '峰', '下次切换', '18:00', '3h00m', '账户余额', 'CNY 42.50', '余额更新于', '14:59']) {
    if (!body.includes(fragment)) throw new Error(`page lacks ${fragment}`)
  }
})
/** The `dl.vmx-rows` entries as `[label, value, title]`. */
const rowsOf = (tree) => {
  const dl = findOne(tree, 'vmx-rows')
  const pairs = []
  for (let index = 0; index < dl.children.length; index += 2) {
    pairs.push([textOf(dl.children[index]), textOf(dl.children[index + 1]), dl.children[index + 1].props?.title])
  }
  return pairs
}
check('lists the day type and the holiday-data source', () => {
  const rows = rowsOf(page)
  const find = (label) => rows.find(([key]) => key === label)
  const day = find('今日')
  if (day === undefined || day[1] !== '工作日') throw new Error(`day row was ${JSON.stringify(day)}`)
  const calendar = find('节假日数据')
  if (calendar === undefined) throw new Error('no holiday-data row')
  if (calendar[1] !== '2026 · cdn.jsdelivr.net · 14:00') throw new Error(`calendar row was ${JSON.stringify(calendar)}`)
})
check('reports unavailable holiday data instead of pretending', () => {
  const bare = render(registry[1].Component, {}, { 0: snapshot({ peak: peakOf({ calendar: { ok: false, stale: true, years: [], sources: [], fetchedAtMs: null, error: 'offline' } }) }), 1: STAMP, 2: false })
  const calendar = rowsOf(bare).find(([label]) => label === '节假日数据')
  if (calendar === undefined || calendar[1] !== '不可用') throw new Error(`calendar row was ${JSON.stringify(calendar)}`)
  if (calendar[2] !== 'offline') throw new Error(`error title was ${calendar[2]}`)
})
check('draws the large track', () => {
  if (findAll(page, 'vmx-track-lg').length !== 1) throw new Error('no large track')
  if (findAll(page, 'vmx-seg').length !== 2) throw new Error('wrong segment count')
})
check('paints no peak segments on a rest day either', () => {
  const rest = render(registry[1].Component, {}, {
    0: snapshot({ peak: peakOf({ inPeak: false, offPeakAllDay: true, offPeakReason: 'weekend', weekend: true, nextAtMs: null, nextIntoPeak: null }) }),
    1: STAMP,
    2: false
  })
  if (findAll(rest, 'vmx-seg').length !== 0) throw new Error('peak segments survived on a rest day')
  const day = rowsOf(rest).find(([label]) => label === '今日')
  if (day === undefined || day[1] !== '周末') throw new Error(`day row was ${JSON.stringify(day)}`)
})
check('the large track carries the phase colours so the bar is actually painted', () => {
  if (page.props.style['--vmx-peak'] !== '#ffb35c') throw new Error(`--vmx-peak was ${page.props.style['--vmx-peak']}`)
  if (page.props.style['--vmx-valley'] !== '#7ecbff') throw new Error(`--vmx-valley was ${page.props.style['--vmx-valley']}`)
})
check('lists every colour theme and marks the active one', () => {
  const swatches = findAll(page, 'vmx-swatch')
  if (swatches.length !== 15) throw new Error(`saw ${swatches.length} swatches`)
  const active = findAll(page, 'vmx-swatch-on')
  if (active.length !== 1) throw new Error(`saw ${active.length} active swatches`)
  if (active[0].props['aria-label'] !== '糖果') throw new Error(`active was ${active[0].props['aria-label']}`)
  if (textOf(findOne(page, 'vmx-schemes-label')) !== '配色主题 · 糖果') throw new Error(`picker label was ${textOf(findOne(page, 'vmx-schemes-label'))}`)
})
check('each swatch previews its peak and valley colours', () => {
  const halvesOf = (swatch) => swatch.children.filter((child) => child?.props?.className === 'vmx-sw-half').map((child) => child.props.style.background)
  const swatches = findAll(page, 'vmx-swatch')
  if (JSON.stringify(halvesOf(swatches[0])) !== JSON.stringify(['#ffb35c', '#7ecbff'])) throw new Error(`candy swatch was ${JSON.stringify(halvesOf(swatches[0]))}`)
  if (JSON.stringify(halvesOf(swatches.at(-1))) !== JSON.stringify(['#e08a3c', '#4d7fd6'])) throw new Error(`custom swatch was ${JSON.stringify(halvesOf(swatches.at(-1)))}`)
})

check('disposing the plugin removes the stylesheet it owns', () => {
  // The single ctx.effect cleanup is the last disposer registered by apply.
  const cleanup = disposers.at(-1)
  if (typeof cleanup !== 'function') throw new Error('no effect cleanup registered')
  if (styleTags.length !== 1) throw new Error(`precondition: ${styleTags.length} style tags`)
  cleanup()
  if (styleTags.length !== 0) throw new Error(`style tag survived disposal (${styleTags.length} left)`)
})

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
