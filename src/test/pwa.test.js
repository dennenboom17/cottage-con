import fs from 'node:fs'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, vi } from 'vitest'

// Tests run from the project root (`npm test`); import.meta.url is not a file: URL under Vitest's jsdom environment
const ROOT = pathToFileURL(`${process.cwd()}/`)
const PUBLIC = new URL('public/', ROOT)
const read = (url) => fs.readFileSync(url, 'utf8')
const readJson = (name) => JSON.parse(read(new URL(name, PUBLIC)))
const pngSize = (url) => { const b = fs.readFileSync(url); return [b.readUInt32BE(16), b.readUInt32BE(20)] }

// ── the service worker, run for real in a sandbox ───────────────────────────────
const ORIGIN = 'https://cottagecon.test'

function loadSW(fetchImpl) {
  const stores = new Map() // cache name -> Map(url -> Response)
  const handlers = {}
  const precached = []
  const keyOf = (r) => (typeof r === 'string' ? new URL(r, ORIGIN).href : r.url)
  const caches = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map())
      const m = stores.get(name)
      return {
        addAll: async (reqs) => { for (const r of reqs) { precached.push(r); m.set(keyOf(r), await fetchImpl(r)) } },
        put: async (r, res) => { m.set(keyOf(r), res) },
        match: async (r) => m.get(keyOf(r)),
      }
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (r) => { for (const m of stores.values()) if (m.has(keyOf(r))) return m.get(keyOf(r)) },
  }
  class SWRequest extends Request { constructor(u, init) { super(new URL(u, ORIGIN).href, init) } }
  const self = { addEventListener: (type, fn) => { handlers[type] = fn }, skipWaiting: vi.fn(), clients: { claim: vi.fn() } }
  vm.runInNewContext(read(new URL('sw.js', PUBLIC)), { self, caches, fetch: fetchImpl, URL, Request: SWRequest, Promise })
  return { stores, handlers, self, precached }
}

const lifecycle = async (sw, type) => { let p; sw.handlers[type]({ waitUntil: (x) => { p = x } }); await p }
const page = (text, status = 200) => new Response(text, { status })

// Dispatches a fetch event; `handled` is false when the worker stepped aside and left it to the browser.
async function doFetch(sw, url, { method = 'GET', mode = 'cors' } = {}) {
  let responded
  sw.handlers.fetch({ request: { url: new URL(url, ORIGIN).href, method, mode }, respondWith: (p) => { responded = p } })
  if (responded === undefined) return { handled: false }
  return { handled: true, response: await responded }
}
const textOf = async (r) => (r ? r.text() : undefined)
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('service worker: install and activate', () => {
  it('precaches the live page, manifest and icons straight from the network, never the retired paths', async () => {
    const sw = loadSW(async () => page('fresh'))
    await lifecycle(sw, 'install')

    const [name] = [...sw.stores.keys()]
    expect(name).not.toBe('cottage-con-v2') // a new name is what makes the update replace the old caches
    const cached = [...sw.stores.get(name).keys()]
    for (const path of ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']) {
      expect(cached).toContain(new URL(path, ORIGIN).href)
    }
    expect(cached.some((u) => u.includes('/icons/') || u.endsWith('/manifest.json'))).toBe(false)
    expect(sw.precached.length).toBeGreaterThan(0)
    for (const r of sw.precached) expect(r.cache, r.url).toBe('reload') // bypass the browser HTTP cache
    expect(sw.self.skipWaiting).toHaveBeenCalled()
  })

  it('deletes every older cache on activation and takes over open pages', async () => {
    const sw = loadSW(async () => page('fresh'))
    sw.stores.set('cottage-con-v2', new Map([[`${ORIGIN}/index.html`, page('old page')]]))
    sw.stores.set('something-else', new Map())
    await lifecycle(sw, 'install')
    const current = [...sw.stores.keys()].find((k) => k !== 'cottage-con-v2' && k !== 'something-else')

    await lifecycle(sw, 'activate')
    expect([...sw.stores.keys()]).toEqual([current])
    expect(sw.self.clients.claim).toHaveBeenCalled()
  })
})

describe('service worker: fetching', () => {
  it('serves a new page after a deploy instead of the cached one, and refreshes the cache', async () => {
    const sw = loadSW(async () => page('new page'))
    await lifecycle(sw, 'install')
    const cache = sw.stores.get([...sw.stores.keys()][0])
    cache.set(`${ORIGIN}/`, page('old page')) // what an installed app has from before the deploy

    const { response } = await doFetch(sw, '/', { mode: 'navigate' })
    expect(await textOf(response)).toBe('new page')
    await tick()
    expect(await textOf(cache.get(`${ORIGIN}/`))).toBe('new page')
  })

  it('shows the new manifest and icons after a deploy, not cached copies', async () => {
    let live = 'new icon'
    const sw = loadSW(async () => page(live))
    await lifecycle(sw, 'install')
    live = 'newer icon'
    for (const path of ['/icon-192.png', '/manifest.webmanifest', '/apple-touch-icon.png', '/favicon.svg']) {
      const { response } = await doFetch(sw, path)
      expect(await textOf(response), path).toBe('newer icon')
    }
  })

  it('falls back to the cache when offline: the app shell for any page, and the cached icon', async () => {
    let online = true
    const sw = loadSW(async () => { if (!online) throw new TypeError('offline'); return page('shell') })
    await lifecycle(sw, 'install')
    online = false

    const nav = await doFetch(sw, '/games', { mode: 'navigate' })
    expect(await textOf(nav.response)).toBe('shell')
    const icon = await doFetch(sw, '/icon-192.png')
    expect(await textOf(icon.response)).toBe('shell')
  })

  it('answers nothing for an uncached resource while offline, rather than throwing', async () => {
    const sw = loadSW(async () => { throw new TypeError('offline') })
    sw.stores.set('cottage-con-v3', new Map())
    const out = await doFetch(sw, '/never-seen.png')
    expect(out.handled).toBe(true)
    expect(out.response).toBeUndefined()
  })

  it('serves content-hashed /assets/ from the cache without touching the network', async () => {
    const net = vi.fn(async () => page('from network'))
    const sw = loadSW(net)
    sw.stores.set('cottage-con-v3', new Map([[`${ORIGIN}/assets/index-abc123.js`, page('cached bundle')]]))
    const { response } = await doFetch(sw, '/assets/index-abc123.js')
    expect(await textOf(response)).toBe('cached bundle')
    expect(net).not.toHaveBeenCalled()
  })

  it('fetches and remembers a /assets/ file it has not seen', async () => {
    const net = vi.fn(async () => page('new bundle'))
    const sw = loadSW(net)
    const { response } = await doFetch(sw, '/assets/index-def456.js')
    expect(await textOf(response)).toBe('new bundle')
    expect(net).toHaveBeenCalledTimes(1)
    await tick()
    expect(sw.stores.get('cottage-con-v3').has(`${ORIGIN}/assets/index-def456.js`)).toBe(true)
  })

  it('does not cache failed responses', async () => {
    const sw = loadSW(async () => page('nope', 500))
    const { response } = await doFetch(sw, '/api-ish')
    expect(response.status).toBe(500)
    await tick()
    expect(sw.stores.get('cottage-con-v3')?.has(`${ORIGIN}/api-ish`) ?? false).toBe(false)
  })

  it('leaves non-GET, Firebase, Google, CDN and messaging-worker requests to the browser', async () => {
    const sw = loadSW(async () => page('x'))
    expect((await doFetch(sw, '/x', { method: 'POST' })).handled).toBe(false)
    expect((await doFetch(sw, 'https://firestore.googleapis.com/v1/x')).handled).toBe(false)
    expect((await doFetch(sw, 'https://cdn.jsdelivr.net/npm/x.css')).handled).toBe(false)
    expect((await doFetch(sw, 'https://fonts.gstatic.com/x.woff2')).handled).toBe(false)
    expect((await doFetch(sw, '/firebase-messaging-sw.js')).handled).toBe(false)
  })
})

// ── manifests and icons ──────────────────────────────────────────────────────────
describe('manifests and icons', () => {
  const live = readJson('manifest.webmanifest')
  const legacy = readJson('manifest.json') // installs made before the move still point at this URL

  it.each([['manifest.webmanifest', live], ['manifest.json', legacy]])('%s only lists icon files that exist, at their stated size', (_n, manifest) => {
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) {
      const file = new URL(icon.src.replace(/^\//, ''), PUBLIC)
      expect(fs.existsSync(file), icon.src).toBe(true)
      const [w, h] = pngSize(file)
      expect(icon.sizes, icon.src).toBe(`${w}x${h}`)
    }
  })

  it('keeps the legacy manifest.json on the same icons and colours as the live manifest', () => {
    expect(legacy.icons).toEqual(live.icons)
    expect(legacy.theme_color).toBe(live.theme_color)
    expect(legacy.background_color).toBe(live.background_color)
    expect(legacy.start_url).toBe(live.start_url)
  })

  it('has index.html link the live manifest, with iOS and favicon icons that exist', () => {
    const html = read(new URL('index.html', ROOT))
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"')
    for (const m of html.matchAll(/<link rel="(?:apple-touch-icon|icon)"[^>]*href="([^"]+)"/g)) {
      expect(fs.existsSync(new URL(m[1].replace(/^\//, ''), PUBLIC)), m[1]).toBe(true)
    }
    expect(html).toContain('apple-touch-icon.png')
  })

  it('shows the new art at every legacy /icons/ path, so old links, caches and notifications upgrade too', () => {
    for (const n of [72, 96, 144, 152, 192, 512]) {
      const fresh = fs.readFileSync(new URL(`icon-${n}.png`, PUBLIC))
      const old = fs.readFileSync(new URL(`icons/icon-${n}.png`, PUBLIC))
      expect(old.equals(fresh), `icons/icon-${n}.png`).toBe(true)
    }
    for (const n of [128, 384]) expect(pngSize(new URL(`icons/icon-${n}.png`, PUBLIC))).toEqual([n, n])
  })

  it('no longer points anything at the legacy /icons/ folder', () => {
    for (const rel of ['src/App.jsx', 'public/sw.js', 'public/firebase-messaging-sw.js']) {
      expect(read(new URL(rel, ROOT)), rel).not.toMatch(/\/icons\/icon/)
    }
  })

  it('makes browsers revalidate the manifests and legacy icons on every load', () => {
    const { hosting } = JSON.parse(read(new URL('firebase.json', ROOT)))
    const cacheControl = (source) => hosting.headers.find((h) => h.source === source)?.headers.find((x) => x.key === 'Cache-Control')?.value
    for (const source of ['/sw.js', '/manifest.webmanifest', '/manifest.json', '/icons/**']) {
      expect(cacheControl(source), source).toBe('no-cache')
    }
  })
})
