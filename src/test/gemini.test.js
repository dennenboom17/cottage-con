import { describe, it, expect, vi, beforeEach } from 'vitest'
import { askGemini, geminiVision, lookupBGG } from '../App.jsx'

const geminiReply = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] })
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
const errResponse = (status, message = '') => ({
  ok: false, status,
  json: async () => ({ error: { message } }),
  text: async () => message,
})
const stubFetch = (impl) => { const f = vi.fn(impl); vi.stubGlobal('fetch', f); return f }
const sentBody = (fetchMock) => JSON.parse(fetchMock.mock.calls[0][1].body)

beforeEach(() => {
  // the app logs liberally; keep test output readable
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('askGemini', () => {
  it('returns the model text and posts history + prompt with the system instruction', async () => {
    const f = stubFetch(async () => okResponse(geminiReply('Arr, hello')))
    const history = [{ role: 'user', parts: [{ text: 'earlier' }] }, { role: 'model', parts: [{ text: 'reply' }] }]

    await expect(askGemini('hi there', history)).resolves.toBe('Arr, hello')

    const [url, init] = f.mock.calls[0]
    expect(url).toContain('generateContent')
    expect(init.method).toBe('POST')
    const body = sentBody(f)
    expect(body.system_instruction.parts[0].text).toContain('Cottage Con')
    expect(body.contents).toHaveLength(3)
    expect(body.contents.at(-1)).toEqual({ role: 'user', parts: [{ text: 'hi there' }] })
  })

  it('reports a network failure in plain language', async () => {
    stubFetch(async () => { throw new TypeError('Failed to fetch') })
    await expect(askGemini('x')).rejects.toThrow(/Network error reaching Gemini/)
  })

  it.each([
    [400, 'bad field', /Bad request: bad field/],
    [401, '', /API key invalid or missing permissions/],
    [403, '', /API key invalid or missing permissions/],
    [404, '', /Model not found/],
    [429, '', /Rate limit exceeded/],
    [500, 'boom', /Gemini API error 500: boom/],
  ])('maps HTTP %i to a helpful message', async (status, detail, expected) => {
    stubFetch(async () => errResponse(status, detail))
    await expect(askGemini('x')).rejects.toThrow(expected)
  })

  it('survives an error body that is not JSON', async () => {
    stubFetch(async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json') } }))
    await expect(askGemini('x')).rejects.toThrow(/Gemini API error 502/)
  })

  it('throws when the model returns no text', async () => {
    stubFetch(async () => okResponse({ candidates: [] }))
    await expect(askGemini('x')).rejects.toThrow(/empty response/)
  })
})

describe('geminiVision', () => {
  const dataUrl = 'data:image/png;base64,QUJDRA=='

  it('splits the data URL into mime type and base64 payload', async () => {
    const f = stubFetch(async () => okResponse(geminiReply('NAME: Azul')))
    await expect(geminiVision(dataUrl, 'what is this?', 'Scan failed')).resolves.toBe('NAME: Azul')

    const parts = sentBody(f).contents[0].parts
    expect(parts[0]).toEqual({ inline_data: { mime_type: 'image/png', data: 'QUJDRA==' } })
    expect(parts[1]).toEqual({ text: 'what is this?' })
  })

  it('asks for deterministic, short output', async () => {
    const f = stubFetch(async () => okResponse(geminiReply('ok')))
    await geminiVision(dataUrl, 'p', 'x')
    expect(sentBody(f).generationConfig).toEqual({ maxOutputTokens: 64, temperature: 0 })
  })

  it('falls back to image/jpeg when the data URL has no mime type', async () => {
    const f = stubFetch(async () => okResponse(geminiReply('ok')))
    await geminiVision('data:;base64,AAAA', 'p', 'x')
    expect(sentBody(f).contents[0].parts[0].inline_data.mime_type).toBe('image/jpeg')
  })

  it('uses the caller-supplied label in the error so each screen keeps its own wording', async () => {
    stubFetch(async () => errResponse(503))
    await expect(geminiVision(dataUrl, 'p', 'Scan failed')).rejects.toThrow('Scan failed: 503')
    await expect(geminiVision(dataUrl, 'p', 'AI scan failed')).rejects.toThrow('AI scan failed: 503')
  })

  it('returns "" rather than throwing when the response has no text', async () => {
    stubFetch(async () => okResponse({ candidates: [{ content: { parts: [] } }] }))
    await expect(geminiVision(dataUrl, 'p', 'x')).resolves.toBe('')
  })
})

describe('lookupBGG', () => {
  const full = [
    'NAME: Wingspan', 'MINP: 1', 'MAXP: 5', 'TIME: 70', 'WEIGHT: 2.4',
    'RATING: 8.1', 'YEAR: 2019', 'BGG_ID: 266192', 'DESC: A bird-collecting engine builder.',
  ].join('\n')

  it('parses the structured reply into a game record', async () => {
    stubFetch(async () => okResponse(geminiReply(full)))
    await expect(lookupBGG('Wingspan')).resolves.toEqual({
      name: 'Wingspan',
      minPlayers: '1', maxPlayers: '5',
      minPlaytime: '70', maxPlaytime: '70',
      weight: '2.4', rating: '8.1', year: '2019',
      description: 'A bird-collecting engine builder.',
      bggUrl: 'https://boardgamegeek.com/boardgame/266192',
    })
  })

  it('joins multi-part replies before parsing', async () => {
    const body = { candidates: [{ content: { parts: [{ text: 'NAME: Azul\nMINP: 2\n' }, { text: 'MAXP: 4\nBGG_ID: 230802' }] } }] }
    stubFetch(async () => okResponse(body))
    const g = await lookupBGG('Azul')
    expect(g).toMatchObject({ name: 'Azul', minPlayers: '2', maxPlayers: '4' })
    expect(g.bggUrl).toBe('https://boardgamegeek.com/boardgame/230802')
  })

  it('falls back to a BGG search URL when the id is 0 or missing', async () => {
    stubFetch(async () => okResponse(geminiReply('NAME: Obscure Game\nBGG_ID: 0')))
    const g = await lookupBGG('Obscure Game')
    expect(g.bggUrl).toBe('https://boardgamegeek.com/search/boardgame?q=Obscure%20Game')
  })

  it('strips player-count noise from the name before asking', async () => {
    const f = stubFetch(async () => okResponse(geminiReply(full)))
    await lookupBGG('Wingspan MINP 1 MAXP 5')
    expect(sentBody(f).contents[0].parts[0].text).toContain('"Wingspan"')
    await lookupBGG('Catan 3-4 players')
    expect(JSON.parse(f.mock.calls[1][1].body).contents[0].parts[0].text).toContain('"Catan"')
  })

  it('returns null without calling the API for a blank name', async () => {
    const f = stubFetch(async () => okResponse(geminiReply(full)))
    await expect(lookupBGG('   ')).resolves.toBeNull()
    await expect(lookupBGG()).resolves.toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('returns null when the reply has no NAME', async () => {
    stubFetch(async () => okResponse(geminiReply("Sorry, I don't know that game.")))
    await expect(lookupBGG('???')).resolves.toBeNull()
  })

  it('returns null on an HTTP error or a thrown network error', async () => {
    stubFetch(async () => errResponse(429, 'slow down'))
    await expect(lookupBGG('Wingspan')).resolves.toBeNull()
    stubFetch(async () => { throw new Error('offline') })
    await expect(lookupBGG('Wingspan')).resolves.toBeNull()
  })
})

describe('Gemini API key configuration', () => {
  it('tells the developer how to fix a missing key instead of calling the API', async () => {
    vi.stubEnv('VITE_GEMINI_API_KEY', '')
    vi.resetModules()
    const f = stubFetch(async () => okResponse(geminiReply('should not be reached')))
    const { askGemini: freshAskGemini } = await import('../App.jsx')

    await expect(freshAskGemini('hi')).rejects.toThrow(/VITE_GEMINI_API_KEY in \.env\.local/)
    expect(f).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('sends the configured key to Google', async () => {
    const f = stubFetch(async () => okResponse(geminiReply('ok')))
    await askGemini('hi')
    expect(f.mock.calls[0][0]).toContain('key=test-key')
  })
})
