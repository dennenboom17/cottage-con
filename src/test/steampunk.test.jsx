import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDoc } from 'firebase/firestore'
import {
  NARRATIVE_ROLES, NARRATIVE_FACTIONS, requiredRoles, resolveWin, unachievableWin, evaluateClaim, pickRandomRoles,
  CrewAssistant, OnboardingModal, resetBggMatcher,
} from '../App.jsx'

const ORIGINAL_14 = [
  'imperial_security', 'imperial_agent', 'imperial_mole', 'imperial_arms_hunter', 'imperial_smuggler_hunter',
  'rebel_commander', 'rebel_recruit', 'rebel_pilot', 'rebel_spy', 'rebel_arms_buyer', 'rebel_black_market_agent',
  'smuggler', 'arms_dealer', 'information_broker',
]
const NEW_8 = ['fleet_commodore', 'admiralty_interrogator', 'ordnance_auditor', 'field_surgeon', 'telegraph_operator', 'boiler_saboteur', 'thief_taker', 'free_cities_consul']

const mk = (roles) => {
  const people = roles.map((r, i) => ({ id: `p${i}`, name: `Person ${i}`, narrativeRole: r }))
  return { people, users: Object.fromEntries(people.map(p => [p.id, p])) }
}
const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }

describe('the steampunk roster', () => {
  it('has 22 roles: the original 14 under their old keys, plus 8 new ones', () => {
    const keys = Object.keys(NARRATIVE_ROLES)
    expect(keys).toHaveLength(22)
    for (const k of [...ORIGINAL_14, ...NEW_8]) expect(keys, k).toContain(k)
  })

  it('splits them 8 Admiralty, 9 League and 5 Free Traders', () => {
    const count = (f) => Object.values(NARRATIVE_ROLES).filter(r => r.faction === f).length
    expect([count('empire'), count('rebellion'), count('independent')]).toEqual([8, 9, 5])
  })

  it('names the three factions', () => {
    expect(NARRATIVE_FACTIONS.empire).toMatchObject({ name: 'The Admiralty', short: 'Admiralty' })
    expect(NARRATIVE_FACTIONS.rebellion).toMatchObject({ name: "The Gearwrights' League", short: 'League' })
    expect(NARRATIVE_FACTIONS.independent).toMatchObject({ name: 'The Free Traders', short: 'Free Trader' })
  })

  it('gives the original roles their steampunk titles', () => {
    const titles = Object.fromEntries(ORIGINAL_14.map(k => [k, NARRATIVE_ROLES[k].title]))
    expect(titles).toEqual({
      imperial_security: 'Admiralty Constable-General', imperial_agent: 'Admiralty Intelligencer', imperial_mole: 'Clockwork Informant',
      imperial_arms_hunter: 'Ordnance Inspector', imperial_smuggler_hunter: 'Aerodrome Customs Officer',
      rebel_commander: 'Cell Foreman', rebel_recruit: 'Disillusioned Stoker', rebel_pilot: 'Skyskiff Pilot', rebel_spy: 'Cipher Clerk',
      rebel_arms_buyer: 'League Quartermaster', rebel_black_market_agent: 'League Provisioner',
      smuggler: 'Aether Smuggler', arms_dealer: 'Freelance Gunsmith', information_broker: 'Penny-Press Informant',
    })
  })

  it('puts each new role on the side it belongs to', () => {
    const side = (k) => NARRATIVE_ROLES[k].faction
    expect(['fleet_commodore', 'admiralty_interrogator', 'ordnance_auditor'].map(side)).toEqual(['empire', 'empire', 'empire'])
    expect(['field_surgeon', 'telegraph_operator', 'boiler_saboteur'].map(side)).toEqual(['rebellion', 'rebellion', 'rebellion'])
    expect(['thief_taker', 'free_cities_consul'].map(side)).toEqual(['independent', 'independent'])
  })
})

describe('no space-opera wording is left for players to read', () => {
  const FORBIDDEN = /\b(empire|imperial|rebel|rebels|rebellion|emperor|galactic|jedi|sith|stormtroopers?|space)\b/i
  const texts = (r) => [
    r.title, r.subtitle, r.cover, r.secret, r.suspectHint, ...r.objectives, ...r.tips,
    r.win.text, r.win.proofHint, ...(r.win.slots || []).flatMap(s => [s.label, s.addText]),
  ].filter(Boolean)

  it('in any role', () => {
    for (const [key, r] of Object.entries(NARRATIVE_ROLES)) {
      for (const t of texts(r)) expect(t, `${key}: "${t}"`).not.toMatch(FORBIDDEN)
    }
  })

  it('in the faction names', () => {
    for (const f of Object.values(NARRATIVE_FACTIONS)) {
      expect(f.name).not.toMatch(FORBIDDEN)
      expect(f.short).not.toMatch(FORBIDDEN)
    }
  })

  it('in what a resolved win says, at any crew size', () => {
    for (const size of [4, 8, 12, 20]) {
      const crew = mk(Object.keys(NARRATIVE_ROLES).slice(0, 22).concat(Object.keys(NARRATIVE_ROLES)).slice(0, size))
      for (const p of crew.people) {
        const w = resolveWin(p.narrativeRole, crew.people, p.id)
        for (const t of [w.text, ...w.slots.map(s => s.label)]) expect(t, `${p.narrativeRole} @${size}`).not.toMatch(FORBIDDEN)
      }
    }
  })

  it('in the welcome tour, which names the factions but not the old ones', () => {
    window.matchMedia = vi.fn(() => ({ matches: false }))
    render(<OnboardingModal ctx={{ profile: { name: 'Ann Lee', onboarded: false }, doUpdateProfile: vi.fn() }} />)
    const text = document.body.textContent
    expect(text).toContain("The Admiralty, the Gearwrights' League, and the Free Traders")
    expect(text).not.toMatch(FORBIDDEN)
  })
})

describe('the chat assistant is a sky-pirate automaton now', () => {
  const reply = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => text })
  const ctx = { profile: { name: 'Ann Lee' }, authUser: { uid: 'me' }, users: { me: { id: 'me', name: 'Ann Lee' } }, games: {}, food: {}, supplies: {}, voyageMenu: {}, deckHands: {}, receipts: {}, itinerary: {} }
  beforeEach(() => { resetBggMatcher(); getDoc.mockResolvedValue({ exists: () => false, data: () => ({}) }); vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => resetBggMatcher())

  it('greets the player in character', async () => {
    render(<CrewAssistant ctx={ctx} />)
    await userEvent.setup().click(screen.getByLabelText('Open crew assistant'))
    expect(screen.getByText(/Sky-pirate automaton at your service/)).toBeInTheDocument()
    expect(screen.queryByText(/space pirate/i)).not.toBeInTheDocument()
  })

  it('tells the model what it is', async () => {
    const f = vi.fn(async () => reply('ok'))
    vi.stubGlobal('fetch', f)
    const user = userEvent.setup()
    render(<CrewAssistant ctx={ctx} />)
    await user.click(screen.getByLabelText('Open crew assistant'))
    await user.type(screen.getByPlaceholderText(/Ask anything/), "What's for dinner tonight?{Enter}")
    await screen.findByText('ok')
    const sys = JSON.parse(f.mock.calls[0][1].body).system_instruction.parts[0].text
    expect(sys).toContain('witty sky-pirate automaton')
    expect(sys).not.toMatch(/space pirate/i)
  })
})

describe('the 8 new roles', () => {
  const win = (k) => NARRATIVE_ROLES[k].win
  const roleSlots = (k) => win(k).slots.map(s => s.role)

  it('have the Fleet Commodore identify the Skyskiff Pilot and the Cell Foreman', () => {
    expect(win('fleet_commodore').type).toBe('identify')
    expect(roleSlots('fleet_commodore')).toEqual(['rebel_pilot', 'rebel_commander'])
  })

  it('have the Interrogator and Auditor each identify the one role they hunt', () => {
    expect(roleSlots('admiralty_interrogator')).toEqual(['rebel_spy'])
    expect(roleSlots('ordnance_auditor')).toEqual(['arms_dealer'])
    expect(win('admiralty_interrogator').type).toBe('identify')
    expect(win('ordnance_auditor').type).toBe('identify')
  })

  it('have the Field Surgeon meet the League Provisioner, and the Telegraph Operator meet the Foreman and the Clerk', () => {
    expect(win('field_surgeon').type).toBe('meet')
    expect(roleSlots('field_surgeon')).toEqual(['rebel_black_market_agent'])
    expect(win('telegraph_operator').type).toBe('meet')
    expect(roleSlots('telegraph_operator')).toEqual(['rebel_commander', 'rebel_spy'])
  })

  it('have the Boiler Saboteur and the Thief-Taker hunt the Constable-General', () => {
    expect(roleSlots('boiler_saboteur')).toEqual(['imperial_security'])
    expect(roleSlots('thief_taker')).toEqual(['rebel_commander', 'imperial_security'])
    expect(win('thief_taker').type).toBe('identify')
  })

  it('always arrive with the roles their win needs, transitively', () => {
    expect([...requiredRoles('ordnance_auditor')].sort()).toEqual(['arms_dealer', 'rebel_arms_buyer'])
    expect([...requiredRoles('field_surgeon')].sort()).toEqual(['rebel_black_market_agent', 'smuggler'])
    expect([...requiredRoles('fleet_commodore')].sort()).toEqual(['rebel_commander', 'rebel_pilot'])
    expect(requiredRoles('free_cities_consul')).toEqual([])
  })

  it('are never dealt without their targets, at any group size', () => {
    for (let count = 1; count <= 26; count++) {
      for (let seed = 1; seed <= 120; seed++) {
        const picks = pickRandomRoles(count, NARRATIVE_ROLES, seeded(seed * 17 + count))
        for (const k of picks.filter(p => NEW_8.includes(p))) {
          for (const t of requiredRoles(k)) expect(picks, `count ${count} seed ${seed}: ${k} needs ${t}`).toContain(t)
        }
      }
    }
  })

  it('can all be completed when every role is in play', () => {
    for (const size of [22, 24, 26]) {
      const crew = mk(pickRandomRoles(size, NARRATIVE_ROLES, seeded(size)))
      for (const p of crew.people) expect(unachievableWin(p.narrativeRole, crew.people, p.id), `${p.narrativeRole} @${size}`).toBeNull()
    }
  })
})

describe('the Consul of the Free Cities', () => {
  const consulCrew = (extra) => mk(['free_cities_consul', ...extra])

  it('asks for exactly one member of each faction, however big the game', () => {
    const big = consulCrew(Array.from({ length: 19 }, (_, i) => ['rebel_pilot', 'imperial_agent', 'smuggler'][i % 3]))
    const w = resolveWin('free_cities_consul', big.people, 'p0')
    expect(w.slots.map(s => s.faction)).toEqual(['empire', 'rebellion', 'independent'])
    expect(w.text).toBe('Meet one member of each faction.')
    const small = consulCrew(['imperial_agent', 'rebel_pilot', 'smuggler'])
    expect(resolveWin('free_cities_consul', small.people, 'p0').slots).toHaveLength(3)
  })

  it('is judged on one person from each side, and never the Consul themself', () => {
    const crew = consulCrew(['imperial_agent', 'rebel_pilot', 'smuggler', 'imperial_mole'])
    const slots = resolveWin('free_cities_consul', crew.people, 'p0').slots
    expect(evaluateClaim('free_cities_consul', ['p1', 'p2', 'p3'], crew.users, 'p0', slots).ok).toBe(true)
    expect(evaluateClaim('free_cities_consul', ['p4', 'p2', 'p3'], crew.users, 'p0', slots).ok).toBe(true) // any Admiralty member will do
    expect(evaluateClaim('free_cities_consul', ['p1', 'p1', 'p3'], crew.users, 'p0', slots).ok).toBe(false)
    expect(evaluateClaim('free_cities_consul', ['p2', 'p1', 'p3'], crew.users, 'p0', slots).ok).toBe(false) // wrong sides
    expect(evaluateClaim('free_cities_consul', ['p1', 'p2', 'p0'], crew.users, 'p0', slots).ok).toBe(false)
  })

  it('is flagged when a faction is missing, since nobody on that side can be met', () => {
    const noLeague = consulCrew(['imperial_agent', 'smuggler'])
    expect(unachievableWin('free_cities_consul', noLeague.people, 'p0')).toBe('it needs 1 League member but only 0 are assigned')
    const loneTrader = consulCrew(['imperial_agent', 'rebel_pilot'])
    expect(unachievableWin('free_cities_consul', loneTrader.people, 'p0')).toBe('it needs 1 Free Trader member but only 0 are assigned')
    const fine = consulCrew(['imperial_agent', 'rebel_pilot', 'smuggler'])
    expect(unachievableWin('free_cities_consul', fine.people, 'p0')).toBeNull()
  })
})
