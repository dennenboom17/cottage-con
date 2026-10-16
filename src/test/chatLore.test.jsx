import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDoc } from 'firebase/firestore'
import {
  CrewAssistant, NARRATIVE_ROLES, NARRATIVE_FACTIONS, FACTION_LORE, ROLE_LORE, RUMORS, RUMOR_CHANCE,
  pickRumors, buildLoreContext, resetBggMatcher,
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

  it('tells the model how to treat factions, roles and rumours', async () => {
    await ask(mkCtx({ me: { id: 'me', name: 'Ann Lee' } }), 'Any gossip?')
    const sys = systemText(f)
    expect(sys).toContain('RUMOUR MILL')
    expect(sys).toMatch(/NEVER say, hint at, confirm or deny which crew member holds a role/)
    expect(sys).toMatch(/never invent one/)
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
    expect(mill(1)).toContain(RUMORS.at(-1))
    expect(mill(0)).not.toEqual(mill(1))
  })
})
