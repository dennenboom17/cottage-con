import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDoc } from 'firebase/firestore'
import {
  CrewAssistant, NARRATIVE_ROLES, NARRATIVE_FACTIONS, FACTION_LORE, ROLE_LORE, RUMORS, RUMOR_CHANCE,
  RUMOR_TEMPLATES, pickRumors, fillRumors, buildLoreContext, resetBggMatcher,
} from '../App.jsx'

const sectionOf = (text, name) => text.split(/\n(?==== )/).find((p) => p.startsWith(`=== ${name}`)) || ''
const OLD_WORDS = /\b(empire|imperial|rebel|rebels|rebellion|emperor|galactic|space)\b/i

describe('chat lore data', () => {
  it('describes every faction and every role, and nothing else', () => {
    expect(Object.keys(FACTION_LORE).sort()).toEqual(Object.keys(NARRATIVE_FACTIONS).sort())
    expect(Object.keys(ROLE_LORE).sort()).toEqual(Object.keys(NARRATIVE_ROLES).sort())
  })

  it('gives each role its own public reputation, which repeats no private text', () => {
    const seen = new Set()
    for (const [key, lore] of Object.entries(ROLE_LORE)) {
      const r = NARRATIVE_ROLES[key]
      expect(lore.length, key).toBeGreaterThan(20)
      expect(seen.has(lore), `${key} duplicates another role's lore`).toBe(false)
      seen.add(lore)
      for (const private_ of [r.secret, r.subtitle, r.suspectHint, ...r.objectives, ...r.tips]) expect(lore, key).not.toContain(private_)
    }
  })

  it('keeps lore and rumours in the steampunk voice', () => {
    for (const text of [...Object.values(FACTION_LORE), ...Object.values(ROLE_LORE), ...RUMORS]) expect(text).not.toMatch(OLD_WORDS)
  })

  it('has enough distinct rumours that do not name a player or a role key', () => {
    expect(RUMORS.length).toBeGreaterThanOrEqual(8)
    expect(new Set(RUMORS).size).toBe(RUMORS.length)
    for (const r of RUMORS) {
      expect(r).not.toMatch(/\{|\}/)
      for (const key of Object.keys(NARRATIVE_ROLES).filter((k) => k.includes('_'))) expect(r).not.toContain(key)
    }
  })
})

describe('pickRumors', () => {
  it('returns n distinct rumours from the pool', () => {
    for (let i = 0; i < 20; i++) {
      const got = pickRumors(3, () => Math.random())
      expect(got).toHaveLength(3)
      expect(new Set(got).size).toBe(3)
      for (const g of got) expect(RUMORS).toContain(g)
    }
  })

  it('is driven by the random source and never asks for more than the pool holds', () => {
    expect(pickRumors(1, () => 0)).toEqual([RUMORS[0]])
    expect(pickRumors(1, () => 0.999)).toEqual([RUMORS.at(-1)])
    expect(pickRumors(5, () => 0, ['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('fillRumors', () => {
  const crew = ['Ann', 'Ben', 'Cora', 'Dev']
  const titles = Object.values(NARRATIVE_ROLES).map((r) => r.title)
  // mulberry32: small, deterministic and well mixed even for neighbouring seeds
  const seeded = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

  it('fills every template, naming only crew members and roles from the roster', () => {
    const out = fillRumors(crew, seeded(7))
    expect(out).toHaveLength(RUMOR_TEMPLATES.length)
    for (const r of out) {
      expect(r, r).not.toMatch(/[{}]/)
      const named = crew.filter((n) => r.includes(n))
      expect(named.length, r).toBeLessThanOrEqual(2)
    }
  })

  it('never pairs a name with a role, so a rumour cannot claim who holds what', () => {
    for (const t of RUMOR_TEMPLATES) expect(/\{[ab]\}/.test(t) && /\{[rs]\}/.test(t), t).toBe(false)
    for (let seed = 1; seed < 40; seed++) {
      for (const r of fillRumors(crew, seeded(seed))) {
        if (crew.some((n) => r.includes(n))) for (const title of titles) expect(r, r).not.toContain(title)
      }
    }
  })

  it('uses two different people when a rumour needs two', () => {
    const two = ['I saw {a} and {b} meeting downstairs.']
    for (let seed = 1; seed < 40; seed++) {
      const [r] = fillRumors(crew, seeded(seed), two)
      const named = crew.filter((n) => r.includes(n))
      expect(named, r).toHaveLength(2)
    }
  })

  it('draws roles from the whole roster, not just the ones in play', () => {
    const seen = new Set()
    for (let seed = 1; seed < 400; seed++) for (const r of fillRumors(crew, seeded(seed), ['The {r} was seen in the kitchen.'])) seen.add(titles.find((t) => r.includes(t)))
    expect(seen.size).toBeGreaterThan(titles.length - 3)
  })

  it('skips templates the crew is too small for, and copes with an empty crew', () => {
    const solo = fillRumors(['Ann'], seeded(3))
    expect(solo.length).toBeLessThan(RUMOR_TEMPLATES.length)
    expect(solo.some((r) => r.includes('Ann'))).toBe(true)
    const none = fillRumors([], seeded(3))
    expect(none.length).toBeGreaterThan(0)
    for (const r of none) expect(r).not.toMatch(/[{}]/)
    expect(fillRumors([null, '', undefined], seeded(3))).toEqual(none)
  })

  it('knows nothing about assignments: the same draws give the same rumours whoever holds which role', () => {
    // fillRumors takes only names, so any two crews with the same names get identical rumours
    expect(fillRumors(crew, seeded(11))).toEqual(fillRumors([...crew], seeded(11)))
  })

  it('keeps the steampunk voice', () => {
    for (const t of RUMOR_TEMPLATES) expect(t).not.toMatch(OLD_WORDS)
  })
})

describe('buildLoreContext', () => {
  const ctxFor = (role, rand) => buildLoreContext(role, rand).join('\n')

  it('lists every faction and every role title with its public line', () => {
    const text = ctxFor(null, () => 0)
    for (const [k, f] of Object.entries(NARRATIVE_FACTIONS)) expect(text).toContain(`${f.name}: ${FACTION_LORE[k]}`)
    for (const [k, r] of Object.entries(NARRATIVE_ROLES)) expect(text).toContain(`${r.title} (${NARRATIVE_FACTIONS[r.faction].short}): ${ROLE_LORE[k]}`)
  })

  it('shares the asker\'s own briefing and nobody else\'s private text', () => {
    const text = ctxFor('smuggler', () => 0)
    const mine = NARRATIVE_ROLES.smuggler
    expect(sectionOf(text, 'YOUR OWN BRIEFING')).toContain(mine.secret)
    mine.objectives.forEach((o) => expect(text).toContain(o))
    for (const [k, r] of Object.entries(NARRATIVE_ROLES)) {
      if (k === 'smuggler') continue
      expect(text, `${k} secret`).not.toContain(r.secret)
      for (const o of r.objectives) expect(text, `${k} objective`).not.toContain(o)
      for (const t of r.tips) expect(text, `${k} tip`).not.toContain(t)
      if (k.includes('_')) expect(text, `${k} key`).not.toContain(k)
    }
  })

  it('says so when the asker has no role', () => {
    expect(sectionOf(ctxFor(null, () => 0), 'YOUR OWN BRIEFING')).toContain('no secret role')
  })

  it('mixes crew-named rumours into the pool, and never names the asker', () => {
    const crew = ['Ben', 'Cora']
    const all = new Set()
    for (let i = 0; i < 300; i++) {
      const mill = sectionOf(buildLoreContext(null, () => Math.random(), crew).join('\n'), 'RUMOUR MILL')
      mill.split('\n').filter((l) => l.startsWith('- ')).forEach((l) => all.add(l.slice(2)))
    }
    expect([...all].some((r) => r.includes('Ben') || r.includes('Cora'))).toBe(true)
    expect([...all].some((r) => !RUMORS.includes(r))).toBe(true)
  })

  it('puts two rumours in the rumour mill and decides, from chance, whether to volunteer one', () => {
    const text = ctxFor(null, () => 0)
    const mill = sectionOf(text, 'RUMOUR MILL')
    expect(RUMORS.filter((r) => mill.includes(r))).toHaveLength(2)
    expect(text).toContain('UNPROMPTED RUMOUR: yes')
    expect(ctxFor(null, () => RUMOR_CHANCE + 0.001)).toContain('UNPROMPTED RUMOUR: no')
    expect(ctxFor(null, () => 0.999)).toContain('UNPROMPTED RUMOUR: no')
  })
})

describe('the crew assistant and the lore', () => {
  const reply = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => text })
  const requestText = (f) => JSON.parse(f.mock.calls.at(-1)[1].body).contents.at(-1).parts[0].text
  const systemText = (f) => JSON.parse(f.mock.calls[0][1].body).system_instruction.parts[0].text
  const mkCtx = (users) => ({
    profile: { name: 'Ann Lee' }, authUser: { uid: 'me' }, users,
    games: {}, food: {}, supplies: {}, voyageMenu: {}, deckHands: {}, receipts: {}, itinerary: {},
  })
  const ask = async (ctx, q) => {
    const user = userEvent.setup()
    render(<CrewAssistant ctx={ctx} />)
    await user.click(screen.getByLabelText('Open crew assistant'))
    await user.type(screen.getByPlaceholderText(/Ask anything/), `${q}{Enter}`)
    await screen.findByText('ok')
  }
  let f

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    resetBggMatcher()
    getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) })
    f = vi.fn(async () => reply('ok'))
    vi.stubGlobal('fetch', f)
  })
  afterEach(() => { resetBggMatcher(); vi.restoreAllMocks() })

  it('sends the factions, the gazetteer, the rumour mill and the asker\'s own briefing with every question', async () => {
    await ask(mkCtx({ me: { id: 'me', name: 'Ann Lee', narrativeRole: 'rebel_spy' } }), 'Tell me about the League')
    const req = requestText(f)
    for (const name of ['FACTIONS', 'ROLE GAZETTEER', 'YOUR OWN BRIEFING', 'RUMOUR MILL']) expect(req).toContain(`=== ${name}`)
    expect(req).toContain(NARRATIVE_ROLES.rebel_spy.secret)
    expect(req).toContain(FACTION_LORE.rebellion)
  })

  it('never ties a role to a crew member, whoever is asking', async () => {
    await ask(mkCtx({
      me: { id: 'me', name: 'Ann Lee', narrativeRole: 'rebel_spy' },
      u2: { id: 'u2', name: 'Benedict', narrativeRole: 'arms_dealer' },
      u3: { id: 'u3', name: 'Cora', narrativeRole: 'imperial_mole' },
    }), 'Who is the arms dealer?')
    const req = requestText(f)
    expect(req).not.toContain('arms_dealer')
    expect(req).not.toContain('imperial_mole')
    expect(req).not.toContain(NARRATIVE_ROLES.arms_dealer.secret)
    expect(req).not.toContain(NARRATIVE_ROLES.imperial_mole.secret)
    // the crew list carries names and ranks only
    expect(sectionOf(req, 'CREW')).not.toMatch(/arms dealer|gunsmith|informant|narrative/i)
  })

  it('names other crew members in rumours but never the asker', async () => {
    // 0.999 always takes the last candidate, which puts the asker (listed last) first in line to be named
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    await ask(mkCtx({
      u2: { id: 'u2', name: 'Benedict' },
      u3: { id: 'u3', name: 'Cora' },
      me: { id: 'me', name: 'Ann Lee' },
    }), 'Any gossip?')
    const mill = sectionOf(requestText(f), 'RUMOUR MILL')
    expect(mill).toContain('awfully polite')
    expect(mill).toContain('Cora')
    expect(mill).toContain('Benedict')
    expect(mill).not.toContain('Ann')
  })

  it('tells the model how to treat factions, roles and rumours', async () => {
    await ask(mkCtx({ me: { id: 'me', name: 'Ann Lee' } }), 'Any gossip?')
    const sys = systemText(f)
    expect(sys).toContain('RUMOUR MILL')
    expect(sys).toMatch(/NEVER say, hint at, confirm or deny which crew member holds a role/)
    expect(sys).toMatch(/never invent one/)
    expect(sys).toMatch(/never add a name or role to one/)
    expect(sys).toContain('UNPROMPTED RUMOUR')
    expect(sys).toContain('Overheard:')
    // the game-tip rule must still be the last word for game answers
    expect(sys).toContain('CLOSING TIP')
  })

  it('draws fresh rumours for each question', async () => {
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0)
    const user = userEvent.setup()
    render(<CrewAssistant ctx={mkCtx({ me: { id: 'me', name: 'Ann Lee' } })} />)
    await user.click(screen.getByLabelText('Open crew assistant'))
    await user.type(screen.getByPlaceholderText(/Ask anything/), 'Rumours?{Enter}')
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    rnd.mockReturnValue(0.999)
    await user.type(screen.getByPlaceholderText(/Ask anything/), 'More?{Enter}')
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(2))
    const mill = (i) => sectionOf(JSON.parse(f.mock.calls[i][1].body).contents.at(-1).parts[0].text, 'RUMOUR MILL')
    expect(mill(0)).toContain(RUMORS[0])
    expect(mill(0)).not.toEqual(mill(1))
  })
})
