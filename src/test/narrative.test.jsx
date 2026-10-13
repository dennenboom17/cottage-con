import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NarrativeDossier, NarrativeManager, CaptainsLog, NARRATIVE_ROLES, NARRATIVE_FACTIONS } from '../App.jsx'

describe('narrative data', () => {
  it('gives every role a valid faction and a complete briefing', () => {
    const roles = Object.entries(NARRATIVE_ROLES)
    expect(roles.length).toBeGreaterThan(0)
    for (const [key, r] of roles) {
      expect(NARRATIVE_FACTIONS[r.faction], `${key} faction`).toBeTruthy()
      for (const field of ['title', 'subtitle', 'icon', 'cover', 'secret', 'suspectHint']) {
        expect(r[field], `${key}.${field}`).toBeTruthy()
      }
      expect(r.objectives.length, `${key} objectives`).toBeGreaterThan(0)
    }
  })

  it('uses every faction at least once', () => {
    const used = new Set(Object.values(NARRATIVE_ROLES).map(r => r.faction))
    for (const f of Object.keys(NARRATIVE_FACTIONS)) expect(used.has(f), f).toBe(true)
  })
})

describe('NarrativeDossier', () => {
  const role = NARRATIVE_ROLES.rebel_spy
  const faction = NARRATIVE_FACTIONS[role.faction]
  const me = { uid: 'u1' }

  it('tells a player with no role that nothing has been issued', () => {
    render(<NarrativeDossier ctx={{ authUser: me, profile: { name: 'Ana' }, users: { u1: { name: 'Ana' } } }} />)
    expect(screen.getByText('No Dossier Assigned')).toBeInTheDocument()
  })

  it('keeps the briefing sealed until opened, then lets the player seal it again', async () => {
    const user = userEvent.setup()
    render(<NarrativeDossier ctx={{ authUser: me, profile: {}, users: { u1: { narrativeRole: 'rebel_spy' } } }} />)

    expect(screen.getByText(new RegExp(faction.name))).toBeInTheDocument()
    expect(screen.queryByText(role.secret)).not.toBeInTheDocument()
    expect(screen.queryByText(role.title)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /open your dossier/i }))
    expect(screen.getByText(role.title)).toBeInTheDocument()
    expect(screen.getByText(role.secret)).toBeInTheDocument()
    for (const obj of role.objectives) expect(screen.getByText(obj)).toBeInTheDocument()
    expect(screen.getByText(role.suspectHint)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /seal dossier/i }))
    expect(screen.queryByText(role.secret)).not.toBeInTheDocument()
  })

  it('shows a role assigned after sign-in, even though the loaded profile predates it (regression)', () => {
    // `profile` is read once at login; the Engine Room writes to the users collection afterwards.
    render(<NarrativeDossier ctx={{ authUser: me, profile: { name: 'Ana' }, users: { u1: { name: 'Ana', narrativeRole: 'smuggler' } } }} />)
    expect(screen.queryByText('No Dossier Assigned')).not.toBeInTheDocument()
    expect(screen.getByText(new RegExp(NARRATIVE_FACTIONS[NARRATIVE_ROLES.smuggler.faction].name))).toBeInTheDocument()
  })

  it("never shows another player's role", () => {
    render(<NarrativeDossier ctx={{
      authUser: me, profile: {},
      users: { u1: { name: 'Ana' }, u2: { name: 'Ben', narrativeRole: 'rebel_spy' } },
    }} />)
    expect(screen.getByText('No Dossier Assigned')).toBeInTheDocument()
    expect(screen.queryByText(role.secret)).not.toBeInTheDocument()
  })
})

describe('NarrativeManager', () => {
  const users = { u1: { name: 'Ana' }, u2: { name: 'Ben', narrativeRole: 'smuggler' } }
  const setup = (over = {}) => {
    const ctx = { users, doAssignNarrativeRole: vi.fn().mockResolvedValue(), showToast: vi.fn(), ...over }
    render(<NarrativeManager ctx={ctx} />)
    return ctx
  }

  it('lists every crew member with their current role or a no-role note', () => {
    setup()
    expect(screen.getByText('Ana')).toBeInTheDocument()
    expect(screen.getByText('No role assigned')).toBeInTheDocument()
    // The same label also appears as a dropdown option, so ignore <option> matches
    const label = `${NARRATIVE_ROLES.smuggler.icon} ${NARRATIVE_ROLES.smuggler.title}`
    expect(screen.getAllByText(label).filter(el => el.tagName !== 'OPTION')).toHaveLength(1)
  })

  it('assigns the chosen role to that crew member only', async () => {
    const user = userEvent.setup()
    const ctx = setup()
    const [anaSelect] = screen.getAllByRole('combobox')
    await user.selectOptions(anaSelect, 'rebel_spy')
    expect(ctx.doAssignNarrativeRole).toHaveBeenCalledTimes(1)
    expect(ctx.doAssignNarrativeRole).toHaveBeenCalledWith('u1', 'rebel_spy')
  })

  it('clears a role when "No role" is picked', async () => {
    const user = userEvent.setup()
    const ctx = setup()
    const benSelect = screen.getAllByRole('combobox')[1]
    await user.selectOptions(benSelect, '')
    expect(ctx.doAssignNarrativeRole).toHaveBeenCalledWith('u2', null)
  })

  it('groups the role options under their faction', () => {
    setup()
    const [select] = screen.getAllByRole('combobox')
    for (const f of Object.values(NARRATIVE_FACTIONS)) {
      expect(within(select).getByRole('group', { name: `${f.icon} ${f.name}` })).toBeInTheDocument()
    }
  })

  it('randomly assigns a valid role to everyone, quietly, then shows one toast', async () => {
    const user = userEvent.setup()
    const ctx = setup()
    await user.click(screen.getByRole('button', { name: /randomly assign all/i }))
    expect(ctx.doAssignNarrativeRole).toHaveBeenCalledTimes(2)
    for (const [id, key, quiet] of ctx.doAssignNarrativeRole.mock.calls) {
      expect(['u1', 'u2']).toContain(id)
      expect(NARRATIVE_ROLES[key]).toBeTruthy()
      expect(quiet).toBe(true)
    }
    const keys = ctx.doAssignNarrativeRole.mock.calls.map(c => c[1])
    expect(new Set(keys).size).toBe(2) // fewer crew than roles, so no one shares a role
    expect(ctx.showToast).toHaveBeenCalledTimes(1)
  })
})

describe('Personal Log dossier', () => {
  const role = NARRATIVE_ROLES.rebel_spy
  const baseCtx = (users) => ({
    authUser: { uid: 'u1' },
    profile: { id: 'u1', name: 'Ana', email: 'ana@example.com' },
    users, games: {}, food: {}, supplies: {}, deckHands: {},
    doUpdateProfile: vi.fn(), doLogout: vi.fn(), showToast: vi.fn(),
  })

  it('puts the sealed dossier above the profile form', () => {
    render(<CaptainsLog ctx={baseCtx({ u1: { narrativeRole: 'rebel_spy' } })} />)
    const open = screen.getByRole('button', { name: /open your dossier/i })
    const profileForm = screen.getByText('Display name')
    expect(open.compareDocumentPosition(profileForm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText(role.secret)).not.toBeInTheDocument()
  })

  it('unlocks in place without hiding the rest of the log', async () => {
    const user = userEvent.setup()
    render(<CaptainsLog ctx={baseCtx({ u1: { narrativeRole: 'rebel_spy' } })} />)
    await user.click(screen.getByRole('button', { name: /open your dossier/i }))
    expect(screen.getByText(role.secret)).toBeInTheDocument()
    expect(screen.getByText('Display name')).toBeInTheDocument()
    expect(screen.getByText(/My Contributions/)).toBeInTheDocument()
  })

  it('shows a locked card when no role has been issued yet', () => {
    render(<CaptainsLog ctx={baseCtx({ u1: { name: 'Ana' } })} />)
    expect(screen.getByText('No Dossier Assigned')).toBeInTheDocument()
  })

  it('is not capped to a narrow column, so it matches the width of the other pages', () => {
    const { container } = render(<CaptainsLog ctx={baseCtx({ u1: {} })} />)
    expect(container.firstChild.style.maxWidth).toBe('')
  })
})
