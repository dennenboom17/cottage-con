import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NarrativeDossier, NarrativeManager, CaptainsLog, NARRATIVE_ROLES, NARRATIVE_FACTIONS, pickRandomRoles } from '../App.jsx'

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

  it('pairs each buyer and hunter role with the independent they target, on the right side', () => {
    const expected = {
      rebel_arms_buyer: ['rebellion', 'Freelance Arms Dealer', 'arms_dealer'],
      rebel_black_market_agent: ['rebellion', 'Black Market Smuggler', 'smuggler'],
      imperial_arms_hunter: ['empire', 'Freelance Arms Dealer', 'arms_dealer'],
      imperial_smuggler_hunter: ['empire', 'Black Market Smuggler', 'smuggler'],
    }
    for (const [key, [faction, target, targetKey]] of Object.entries(expected)) {
      const r = NARRATIVE_ROLES[key]
      expect(r, key).toBeTruthy()
      expect(r.faction, `${key} faction`).toBe(faction)
      expect(r.objectives[0], `${key} first objective`).toContain(target)
      expect(r.requires, `${key} requires`).toBe(targetKey)
    }
    expect(NARRATIVE_ROLES.arms_dealer.title).toBe('Freelance Arms Dealer')
    expect(NARRATIVE_ROLES.smuggler.title).toBe('Black Market Smuggler')
  })

  it('gives every role a distinct icon and title', () => {
    const roles = Object.values(NARRATIVE_ROLES)
    expect(new Set(roles.map(r => r.icon)).size).toBe(roles.length)
    expect(new Set(roles.map(r => r.title)).size).toBe(roles.length)
  })

  it('only requires roles that exist and have no requirement of their own', () => {
    for (const [key, r] of Object.entries(NARRATIVE_ROLES)) {
      if (!r.requires) continue
      expect(NARRATIVE_ROLES[r.requires], `${key} requires ${r.requires}`).toBeTruthy()
      expect(NARRATIVE_ROLES[r.requires].requires, `${r.requires} must not chain`).toBeUndefined()
    }
  })

  it('uses every faction at least once', () => {
    const used = new Set(Object.values(NARRATIVE_ROLES).map(r => r.faction))
    for (const f of Object.keys(NARRATIVE_FACTIONS)) expect(used.has(f), f).toBe(true)
  })
})

describe('pickRandomRoles', () => {
  const total = Object.keys(NARRATIVE_ROLES).length
  const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  const targetsPresent = (picks) => picks.every(k => !NARRATIVE_ROLES[k].requires || picks.includes(NARRATIVE_ROLES[k].requires))

  it('never picks a buyer or hunter without the role it targets, for any group size', () => {
    for (let count = 0; count <= total + 6; count++) {
      for (let seed = 1; seed <= 150; seed++) {
        const picks = pickRandomRoles(count, NARRATIVE_ROLES, seeded(seed))
        expect(picks, `count ${count} seed ${seed}`).toHaveLength(count)
        expect(targetsPresent(picks), `count ${count} seed ${seed}: ${picks}`).toBe(true)
      }
    }
  })

  it('gives everyone a different role while the group is no larger than the role list', () => {
    for (let count = 1; count <= total; count++) {
      const picks = pickRandomRoles(count, NARRATIVE_ROLES, seeded(count * 7))
      expect(new Set(picks).size, `count ${count}`).toBe(count)
    }
  })

  it('can still hand out the paired roles (they are not simply excluded)', () => {
    const seen = new Set()
    for (let seed = 1; seed <= 200; seed++) pickRandomRoles(6, NARRATIVE_ROLES, seeded(seed)).forEach(k => seen.add(k))
    for (const k of ['rebel_arms_buyer', 'rebel_black_market_agent', 'imperial_arms_hunter', 'imperial_smuggler_hunter']) {
      expect(seen.has(k), k).toBe(true)
    }
  })

  it('repeats roles only once every role is in play', () => {
    const picks = pickRandomRoles(total + 5, NARRATIVE_ROLES, seeded(3))
    expect(new Set(picks).size).toBe(total)
    expect(picks).toHaveLength(total + 5)
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

  it('warns when an assigned role has nobody to target', () => {
    setup({ users: { u1: { name: 'Ana', narrativeRole: 'rebel_arms_buyer' }, u2: { name: 'Ben', narrativeRole: 'smuggler' } } })
    expect(screen.getByText(/No Freelance Arms Dealer is assigned/)).toBeInTheDocument()
  })

  it('does not warn once the targeted role is assigned to someone', () => {
    setup({ users: { u1: { name: 'Ana', narrativeRole: 'rebel_arms_buyer' }, u2: { name: 'Ben', narrativeRole: 'arms_dealer' } } })
    expect(screen.queryByText(/is assigned, so this role has nobody to target/)).not.toBeInTheDocument()
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
    for (const k of keys) {
      const need = NARRATIVE_ROLES[k].requires
      if (need) expect(keys, `${k} needs ${need}`).toContain(need)
    }
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

describe('Crew suspect board (inside the dossier)', () => {
  const me = { uid: 'u1' }
  const users = {
    u1: { name: 'Ana', narrativeRole: 'rebel_spy' },
    u2: { name: 'Ben', narrativeRole: 'smuggler' },
    u3: { name: 'Cleo', narrativeRole: 'imperial_agent' },
  }
  const renderOpen = async (over = {}) => {
    const user = userEvent.setup()
    const utils = render(<NarrativeDossier ctx={{ authUser: me, profile: {}, users, ...over }} />)
    await user.click(screen.getByRole('button', { name: /open your dossier/i }))
    return { user, ...utils }
  }

  beforeEach(() => localStorage.clear())

  it('stays hidden while the dossier is sealed', () => {
    render(<NarrativeDossier ctx={{ authUser: me, profile: {}, users }} />)
    expect(screen.queryByText(/Crew Suspect Board/)).not.toBeInTheDocument()
    expect(screen.queryByText('Ben')).not.toBeInTheDocument()
  })

  it('lists every other crew member but not the player, starting with nothing marked', async () => {
    await renderOpen()
    expect(screen.getByText(/Crew Suspect Board/)).toBeInTheDocument()
    expect(screen.getByText('Ben')).toBeInTheDocument()
    expect(screen.getByText('Cleo')).toBeInTheDocument()
    expect(screen.queryByLabelText('Guess role for Ana')).not.toBeInTheDocument()
    expect(screen.getByText('0 of 2 marked')).toBeInTheDocument()
  })

  it("never pre-fills or reveals anyone's real role", async () => {
    await renderOpen()
    expect(screen.getByLabelText('Guess role for Ben')).toHaveValue('')
    expect(screen.getByLabelText('Guess role for Cleo')).toHaveValue('')
  })

  it('records a guess, counts it, and offers every role grouped by faction', async () => {
    const { user } = await renderOpen()
    const select = screen.getByLabelText('Guess role for Ben')
    for (const f of Object.values(NARRATIVE_FACTIONS)) {
      expect(within(select).getByRole('group', { name: `${f.icon} ${f.name}` })).toBeInTheDocument()
    }
    expect(within(select).getAllByRole('option')).toHaveLength(Object.keys(NARRATIVE_ROLES).length + 1)
    await user.selectOptions(select, 'smuggler')
    expect(select).toHaveValue('smuggler')
    expect(screen.getByText('1 of 2 marked')).toBeInTheDocument()
  })

  it('can clear a guess back to unknown', async () => {
    const { user } = await renderOpen()
    const select = screen.getByLabelText('Guess role for Ben')
    await user.selectOptions(select, 'smuggler')
    await user.selectOptions(select, '')
    expect(select).toHaveValue('')
    expect(screen.getByText('0 of 2 marked')).toBeInTheDocument()
  })

  it('remembers guesses after the dossier is closed and reopened, and after a reload', async () => {
    const { user, unmount } = await renderOpen()
    await user.selectOptions(screen.getByLabelText('Guess role for Cleo'), 'imperial_security')
    await user.click(screen.getByRole('button', { name: /seal dossier/i }))
    await user.click(screen.getByRole('button', { name: /open your dossier/i }))
    expect(screen.getByLabelText('Guess role for Cleo')).toHaveValue('imperial_security')

    unmount()
    await renderOpen()
    expect(screen.getByLabelText('Guess role for Cleo')).toHaveValue('imperial_security')
  })

  it("keeps each player's guesses separate", async () => {
    const { user, unmount } = await renderOpen()
    await user.selectOptions(screen.getByLabelText('Guess role for Ben'), 'smuggler')
    unmount()
    await renderOpen({ authUser: { uid: 'u3' } })
    expect(screen.getByLabelText('Guess role for Ben')).toHaveValue('')
  })

  it('ignores corrupt or outdated saved data instead of crashing', async () => {
    localStorage.setItem('cc-role-guesses:u1', '{not json')
    const first = await renderOpen()
    expect(screen.getByLabelText('Guess role for Ben')).toHaveValue('')
    first.unmount()

    localStorage.setItem('cc-role-guesses:u1', JSON.stringify({ u2: 'role_that_was_removed' }))
    await renderOpen()
    expect(screen.getByLabelText('Guess role for Ben')).toHaveValue('')
    expect(screen.getByText('0 of 2 marked')).toBeInTheDocument()
  })

  it('still works when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    const { user } = await renderOpen()
    await user.selectOptions(screen.getByLabelText('Guess role for Ben'), 'smuggler')
    expect(screen.getByLabelText('Guess role for Ben')).toHaveValue('smuggler')
  })

  it('says so when nobody else has joined', async () => {
    await renderOpen({ users: { u1: { name: 'Ana', narrativeRole: 'rebel_spy' } } })
    expect(screen.getByText('No other crew have joined yet.')).toBeInTheDocument()
  })
})
