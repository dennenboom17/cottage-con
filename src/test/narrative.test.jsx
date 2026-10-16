import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDoc, setDoc } from 'firebase/firestore'
import { NarrativeDossier, NarrativeManager, CaptainsLog, NARRATIVE_ROLES, NARRATIVE_FACTIONS, pickRandomRoles, requiredRoles, scoreGuesses, nextSuspectScore, rankSuspectScores, recordSuspectCheck, SuspectLeaderboard, pickChatTip, HUSS_TIP, CrewAssistant, resetBggMatcher } from '../App.jsx'

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
      rebel_arms_buyer: ['rebellion', 'Freelance Gunsmith', 'arms_dealer'],
      rebel_black_market_agent: ['rebellion', 'Aether Smuggler', 'smuggler'],
      imperial_arms_hunter: ['empire', 'Freelance Gunsmith', 'arms_dealer'],
      imperial_smuggler_hunter: ['empire', 'Aether Smuggler', 'smuggler'],
    }
    for (const [key, [faction, target, targetKey]] of Object.entries(expected)) {
      const r = NARRATIVE_ROLES[key]
      expect(r, key).toBeTruthy()
      expect(r.faction, `${key} faction`).toBe(faction)
      expect(r.objectives[0], `${key} first objective`).toContain(target)
      expect([].concat(r.requires), `${key} requires`).toContain(targetKey)
    }
    expect(NARRATIVE_ROLES.arms_dealer.title).toBe('Freelance Gunsmith')
    expect(NARRATIVE_ROLES.smuggler.title).toBe('Aether Smuggler')
  })

  it('gives every role a distinct icon and title', () => {
    const roles = Object.values(NARRATIVE_ROLES)
    expect(new Set(roles.map(r => r.icon)).size).toBe(roles.length)
    expect(new Set(roles.map(r => r.title)).size).toBe(roles.length)
  })

  it('only requires roles that exist, and never itself', () => {
    for (const [key, r] of Object.entries(NARRATIVE_ROLES)) {
      for (const need of [].concat(r.requires || [])) {
        expect(NARRATIVE_ROLES[need], `${key} requires ${need}`).toBeTruthy()
        expect(need, `${key} must not require itself`).not.toBe(key)
      }
    }
  })

  it('gives every role at least three distinct, non-empty chat tips', () => {
    for (const [key, r] of Object.entries(NARRATIVE_ROLES)) {
      expect(r.tips.length, `${key} tips`).toBeGreaterThanOrEqual(3)
      expect(new Set(r.tips).size, `${key} distinct`).toBe(r.tips.length)
      for (const t of r.tips) expect(t.trim(), key).toBeTruthy()
    }
  })

  it('uses every faction at least once', () => {
    const used = new Set(Object.values(NARRATIVE_ROLES).map(r => r.faction))
    for (const f of Object.keys(NARRATIVE_FACTIONS)) expect(used.has(f), f).toBe(true)
  })
})

describe('requiredRoles', () => {
  it('lists a role\'s direct requirements', () => {
    expect(requiredRoles('rebel_recruit')).toEqual(['rebel_commander'])
    expect(requiredRoles('imperial_smuggler_hunter')).toEqual(['smuggler', 'rebel_black_market_agent'])
  })

  it('follows requirements transitively, so the hunter brings the dealer and the buyer', () => {
    expect([...requiredRoles('imperial_arms_hunter')].sort()).toEqual(['arms_dealer', 'rebel_arms_buyer'])
  })

  it('copes with a pair that require each other, and never lists the role itself', () => {
    expect(requiredRoles('smuggler')).toEqual(['rebel_black_market_agent'])
    expect(requiredRoles('rebel_black_market_agent')).toEqual(['smuggler'])
    for (const key of Object.keys(NARRATIVE_ROLES)) expect(requiredRoles(key)).not.toContain(key)
  })

  it('returns nothing for a role with no requirements, an unknown role, or a made-up cycle', () => {
    expect(requiredRoles('rebel_commander')).toEqual([])
    expect(requiredRoles('nope')).toEqual([])
    const roles = { a: { requires: 'b' }, b: { requires: ['c', 'ghost'] }, c: { requires: 'a' } }
    expect([...requiredRoles('a', roles)].sort()).toEqual(['b', 'c'])
  })
})

describe('pickRandomRoles', () => {
  const total = Object.keys(NARRATIVE_ROLES).length
  const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  const targetsPresent = (picks) => picks.every(k => requiredRoles(k).every(t => picks.includes(t)))

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

  it('hands out exactly the number asked for, with every requirement met, at every size', () => {
    for (let count = 0; count <= total + 3; count++) {
      for (let seed = 1; seed <= 300; seed++) {
        const picks = pickRandomRoles(count, NARRATIVE_ROLES, seeded(seed * 31 + count))
        expect(picks.length, `count ${count} seed ${seed}`).toBe(count)
        expect(targetsPresent(picks), `count ${count} seed ${seed}: ${picks}`).toBe(true)
      }
    }
  })

  it('works for a made-up role set with a chain and a cycle', () => {
    const roles = { a: {}, b: { requires: 'a' }, c: { requires: ['b'] }, d: { requires: 'e' }, e: { requires: 'd' }, f: {} }
    for (let count = 1; count <= 6; count++) {
      for (let seed = 1; seed <= 100; seed++) {
        const picks = pickRandomRoles(count, roles, seeded(seed))
        expect(picks).toHaveLength(count)
        for (const k of picks) for (const t of requiredRoles(k, roles)) expect(picks, `${k} needs ${t}`).toContain(t)
      }
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
    expect(screen.getByText(/No Freelance Gunsmith is assigned/)).toBeInTheDocument()
  })

  it('does not warn once the targeted role is assigned to someone', () => {
    setup({ users: { u1: { name: 'Ana', narrativeRole: 'rebel_arms_buyer' }, u2: { name: 'Ben', narrativeRole: 'arms_dealer' } } })
    expect(screen.queryByText(/is assigned, so this role has nobody to target/)).not.toBeInTheDocument()
  })

  it('warns when a win condition cannot be completed with the crew as assigned', () => {
    setup({ users: { u1: { name: 'Ana', narrativeRole: 'imperial_security' }, u2: { name: 'Ben', narrativeRole: 'rebel_spy' } } })
    expect(screen.getByText(/Win condition can't be completed: it needs 2 League members but only 1 is assigned/)).toBeInTheDocument()
  })

  it('does not warn when the win condition can be completed', () => {
    setup({ users: {
      u1: { name: 'Ana', narrativeRole: 'imperial_security' }, u2: { name: 'Ben', narrativeRole: 'rebel_spy' }, u3: { name: 'Cleo', narrativeRole: 'rebel_pilot' },
      u4: { name: 'Dan', narrativeRole: 'imperial_agent' }, // enough on each side for everyone's win to be possible
    } })
    expect(screen.queryByText(/Win condition can't be completed/)).not.toBeInTheDocument()
  })

  it('lists every missing required role, with the right grammar', () => {
    setup({ users: { u1: { name: 'Ana', narrativeRole: 'imperial_arms_hunter' } } })
    expect(screen.getByText(/No Freelance Gunsmith and League Quartermaster are assigned, so this role has nobody to target/)).toBeInTheDocument()
  })

  it('shows one warning per player: the missing target takes priority over the win-condition warning', () => {
    setup({ users: { u1: { name: 'Ana', narrativeRole: 'rebel_arms_buyer' } } })
    expect(screen.getByText(/No Freelance Gunsmith is assigned/)).toBeInTheDocument()
    expect(screen.queryByText(/Win condition can't be completed/)).not.toBeInTheDocument()
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
      for (const need of requiredRoles(k)) expect(keys, `${k} needs ${need}`).toContain(need)
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
    expect(screen.getByLabelText('Guess role for Ben')).toBeInTheDocument()
    expect(screen.getByLabelText('Guess role for Cleo')).toBeInTheDocument()
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
    expect(within(select).getAllByRole('option')).toHaveLength(Object.keys(NARRATIVE_ROLES).length + 2) // + Unknown, + Not playing
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

describe('scoreGuesses', () => {
  const users = {
    me: { narrativeRole: 'rebel_spy' },
    a: { narrativeRole: 'smuggler' },
    b: { narrativeRole: 'imperial_agent' },
    c: {},
  }

  it('counts only exact matches and excludes the player', () => {
    expect(scoreGuesses({ a: 'smuggler', b: 'rebel_spy', c: 'none' }, users, 'me')).toEqual({ correct: 2, total: 3 })
  })

  it('treats a crew member with no role as "none", and never as a role', () => {
    expect(scoreGuesses({ a: 'smuggler', b: 'imperial_agent', c: 'smuggler' }, users, 'me')).toEqual({ correct: 2, total: 3 })
  })

  it('counts missing guesses as wrong and an empty crew as 0 of 0', () => {
    expect(scoreGuesses({}, users, 'me')).toEqual({ correct: 0, total: 3 })
    expect(scoreGuesses({}, { me: {} }, 'me')).toEqual({ correct: 0, total: 0 })
  })
})

describe('Crew suspect board check', () => {
  const me = { uid: 'u1' }
  const users = {
    u1: { name: 'Ana', narrativeRole: 'rebel_spy' },
    u2: { name: 'Ben', narrativeRole: 'smuggler' },
    u3: { name: 'Cleo', narrativeRole: 'imperial_agent' },
  }

  // Stand-in for App + Firestore: `store` plays the suspectScores collection and outlives remounts, like the real one.
  let store, recorded
  function Harness({ u = users, authUser = me }) {
    const [scores, setScores] = React.useState(store)
    const doRecordSuspectCheck = async (result) => {
      recorded.push(result)
      store = { ...store, [authUser.uid]: nextSuspectScore(store[authUser.uid], result, 1000) }
      setScores(store)
    }
    return <NarrativeDossier ctx={{ authUser, profile: {}, users: u, suspectScores: scores, doRecordSuspectCheck }} />
  }
  const open = async (u = users, authUser = me) => {
    const user = userEvent.setup()
    const utils = render(<Harness u={u} authUser={authUser} />)
    await user.click(screen.getByRole('button', { name: /open your dossier/i }))
    return { user, ...utils }
  }
  const guess = (user, name, value) => user.selectOptions(screen.getByLabelText(`Guess role for ${name}`), value)
  const checkBtn = () => screen.getByRole('button', { name: /check my guesses/i })

  beforeEach(() => { localStorage.clear(); store = {}; recorded = [] })

  it('stays disabled until every crew member has a guess, and says how many are left', async () => {
    const { user } = await open()
    expect(checkBtn()).toBeDisabled()
    expect(screen.getByText(/2 to go/)).toBeInTheDocument()
    await guess(user, 'Ben', 'smuggler')
    expect(checkBtn()).toBeDisabled()
    expect(screen.getByText(/1 to go/)).toBeInTheDocument()
    await guess(user, 'Cleo', 'imperial_agent')
    expect(checkBtn()).toBeEnabled()
    expect(screen.queryByText(/to go/)).not.toBeInTheDocument()
  })

  it('does nothing when clicked before every guess is in', async () => {
    const { user } = await open()
    await guess(user, 'Ben', 'smuggler')
    await user.click(checkBtn())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText(/Checks made: 0/)).toBeInTheDocument()
    expect(recorded).toEqual([])
  })

  it('reports how many guesses are correct, and records that result for the leaderboard', async () => {
    const { user } = await open()
    await guess(user, 'Ben', 'smuggler')
    await guess(user, 'Cleo', 'imperial_security')
    await user.click(checkBtn())
    expect(screen.getByRole('status')).toHaveTextContent('1 of 2 correct')
    expect(screen.getByText(/Checks made: 1/)).toBeInTheDocument()
    expect(recorded).toEqual([{ correct: 1, total: 2 }])
  })

  it('celebrates when every guess is right', async () => {
    const { user } = await open()
    await guess(user, 'Ben', 'smuggler')
    await guess(user, 'Cleo', 'imperial_agent')
    await user.click(checkBtn())
    expect(screen.getByRole('status')).toHaveTextContent('All 2 correct')
  })

  it('gives only a count: it never says which guesses were right or wrong', async () => {
    const { user } = await open()
    await guess(user, 'Ben', 'smuggler')
    await guess(user, 'Cleo', 'imperial_security')
    await user.click(checkBtn())
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByLabelText('Guess role for Ben')).toHaveValue('smuggler')
    expect(screen.getByLabelText('Guess role for Cleo')).toHaveValue('imperial_security')
    expect(screen.queryByText(/wrong|incorrect/i)).not.toBeInTheDocument()
  })

  it('lets a player guess that someone has no role, scoring it against crew who really have none', async () => {
    const withSpectator = { ...users, u4: { name: 'Dan' } }
    const { user } = await open(withSpectator)
    await guess(user, 'Ben', 'smuggler')
    await guess(user, 'Cleo', 'imperial_agent')
    await guess(user, 'Dan', 'none')
    await user.click(checkBtn())
    expect(screen.getByRole('status')).toHaveTextContent('All 3 correct')

    await guess(user, 'Dan', 'smuggler')
    await user.click(checkBtn())
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 correct')
  })

  it('counts every check and lists the history, and still has them after a reload', async () => {
    const { user, unmount } = await open()
    await guess(user, 'Ben', 'smuggler')
    await guess(user, 'Cleo', 'imperial_security')
    await user.click(checkBtn())
    await guess(user, 'Cleo', 'imperial_agent')
    await user.click(checkBtn())
    expect(screen.getByText(/Checks made: 2/)).toHaveTextContent('history: 1/2, 2/2')
    expect(screen.getByRole('status')).toHaveTextContent('All 2 correct')

    unmount()
    await open()
    expect(screen.getByText(/Checks made: 2/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('All 2 correct')
  })

  it('scores against the roles as they are now, not as they were at the last check', async () => {
    const { user, rerender } = await open()
    await guess(user, 'Ben', 'smuggler')
    await guess(user, 'Cleo', 'imperial_agent')
    await user.click(checkBtn())
    expect(screen.getByRole('status')).toHaveTextContent('All 2 correct')

    rerender(<Harness u={{ ...users, u2: { name: 'Ben', narrativeRole: 'arms_dealer' } }} />)
    await user.click(checkBtn())
    expect(screen.getByRole('status')).toHaveTextContent('1 of 2 correct')
  })

  it("keeps each player's checks separate", async () => {
    const { user, unmount } = await open()
    await guess(user, 'Ben', 'smuggler')
    await guess(user, 'Cleo', 'imperial_agent')
    await user.click(checkBtn())
    unmount()
    await open(users, { uid: 'u3' })
    expect(screen.getByText(/Checks made: 0/)).toBeInTheDocument()
  })

  it('copes with a malformed saved score, keeping only the valid history', async () => {
    const bad = { u1: { checks: 'x', history: [{ correct: 'x' }, null, { correct: 1, total: 2 }] } }
    render(<NarrativeDossier ctx={{ authUser: me, profile: {}, users, suspectScores: bad }} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /open your dossier/i }))
    expect(screen.getByText(/Checks made: 1/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('1 of 2 correct')
  })

  it('has no check button when nobody else has joined', async () => {
    await open({ u1: users.u1 })
    expect(screen.queryByRole('button', { name: /check my guesses/i })).not.toBeInTheDocument()
  })

  it('shows the leaderboard inside the unlocked dossier, with the viewer highlighted', async () => {
    store = { u1: nextSuspectScore(undefined, { correct: 1, total: 2 }), u2: nextSuspectScore(undefined, { correct: 2, total: 2 }) }
    await open()
    expect(screen.getByText(/Leaderboard/)).toBeInTheDocument()
    expect(screen.getByText('(you)')).toBeInTheDocument()
    expect(screen.getByText(/🎉 2\/2/)).toBeInTheDocument()
  })
})

describe('nextSuspectScore', () => {
  it('starts a record on the first check', () => {
    expect(nextSuspectScore(undefined, { correct: 2, total: 5 }, 99)).toEqual({
      checks: 1, history: [{ correct: 2, total: 5, at: 99 }],
      bestCorrect: 2, bestTotal: 5, lastCorrect: 2, lastTotal: 5, solvedInChecks: null, updatedAt: 99,
    })
  })

  it('counts every check and keeps the best one, judged as a share of the crew', () => {
    let rec = nextSuspectScore(undefined, { correct: 3, total: 7 })
    rec = nextSuspectScore(rec, { correct: 4, total: 6 })
    expect([rec.bestCorrect, rec.bestTotal, rec.checks]).toEqual([4, 6, 2])
    rec = nextSuspectScore(rec, { correct: 3, total: 7 }) // worse: best must not move
    expect([rec.bestCorrect, rec.bestTotal, rec.checks, rec.lastCorrect]).toEqual([4, 6, 3, 3])
    rec = nextSuspectScore(rec, { correct: 5, total: 7 })
    expect([rec.bestCorrect, rec.bestTotal]).toEqual([5, 7])
  })

  it('prefers more correct answers when the shares are equal', () => {
    let rec = nextSuspectScore(undefined, { correct: 1, total: 2 })
    rec = nextSuspectScore(rec, { correct: 3, total: 6 })
    expect([rec.bestCorrect, rec.bestTotal]).toEqual([3, 6])
  })

  it('records the check that first cracked everyone and never moves it', () => {
    let rec = nextSuspectScore(undefined, { correct: 1, total: 3 })
    rec = nextSuspectScore(rec, { correct: 3, total: 3 })
    rec = nextSuspectScore(rec, { correct: 3, total: 3 })
    expect(rec.solvedInChecks).toBe(2)
  })

  it('keeps counting checks after the history is trimmed', () => {
    const history = Array.from({ length: 50 }, () => ({ correct: 1, total: 2 }))
    const rec = nextSuspectScore({ checks: 60, history, bestCorrect: 1, bestTotal: 2 }, { correct: 2, total: 2 })
    expect(rec.checks).toBe(61)
    expect(rec.history).toHaveLength(50)
    expect(rec.history.at(-1)).toMatchObject({ correct: 2, total: 2 })
  })

  it('copes with a missing or corrupt previous record', () => {
    for (const prev of [null, 'junk', 42, {}, { checks: 'x', history: 'nope', bestCorrect: 'a' }, { checks: -3, history: [null] }]) {
      const rec = nextSuspectScore(prev, { correct: 1, total: 2 })
      expect(rec.checks, JSON.stringify(prev)).toBe(1)
      expect(rec.history).toHaveLength(1)
      expect(rec.history[0]).toMatchObject({ correct: 1, total: 2 })
      expect([rec.bestCorrect, rec.bestTotal]).toEqual([1, 2])
    }
  })

  it('never lets the check count fall below the history it holds', () => {
    const history = [{ correct: 1, total: 2 }, { correct: 2, total: 2 }]
    expect(nextSuspectScore({ checks: 1, history }, { correct: 0, total: 2 }).checks).toBe(3)
  })
})

describe('rankSuspectScores', () => {
  const users = { u1: { name: 'Ana' }, u2: { name: 'Ben' }, u3: { name: 'Cleo' }, u4: { name: 'Dan' } }
  const rec = (checks, bestCorrect, bestTotal, extra = {}) => ({ checks, bestCorrect, bestTotal, history: [], updatedAt: 1, ...extra })
  const order = (rows) => rows.map(r => r.name)

  it('orders by best check as a share of the crew', () => {
    const rows = rankSuspectScores({ u1: rec(1, 3, 7), u2: rec(1, 6, 7), u3: rec(1, 4, 7) }, users)
    expect(order(rows)).toEqual(['Ben', 'Cleo', 'Ana'])
    expect(rows.map(r => r.rank)).toEqual([1, 2, 3])
  })

  it('judges a smaller crew fairly: 4 of 5 beats 4 of 7', () => {
    expect(order(rankSuspectScores({ u1: rec(1, 4, 7), u2: rec(1, 4, 5) }, users))).toEqual(['Ben', 'Ana'])
  })

  it('breaks a tie in favour of whoever needed fewer checks', () => {
    const rows = rankSuspectScores({ u1: rec(5, 7, 7), u2: rec(2, 7, 7) }, users)
    expect(order(rows)).toEqual(['Ben', 'Ana'])
    expect(rows.map(r => r.rank)).toEqual([1, 2])
  })

  it('gives identical results the same rank and skips the next one', () => {
    const rows = rankSuspectScores({ u1: rec(2, 5, 7), u2: rec(2, 5, 7), u3: rec(2, 3, 7) }, users)
    expect(rows.map(r => r.rank)).toEqual([1, 1, 3])
  })

  it('puts whoever got there first ahead within a tie, without changing the rank', () => {
    const rows = rankSuspectScores({ u1: rec(2, 5, 7, { updatedAt: 500 }), u2: rec(2, 5, 7, { updatedAt: 100 }) }, users)
    expect(order(rows)).toEqual(['Ben', 'Ana'])
    expect(rows.map(r => r.rank)).toEqual([1, 1])
  })

  it('leaves out people with no checks, malformed records, or who are no longer in the crew', () => {
    const rows = rankSuspectScores({
      u1: rec(0, 0, 7), u2: { checks: 'x', bestCorrect: 1, bestTotal: 2 }, u3: rec(1, 9, 2),
      ghost: rec(3, 7, 7), u4: rec(1, 1, 7),
    }, users)
    expect(order(rows)).toEqual(['Dan'])
  })

  it('handles no scores at all', () => {
    expect(rankSuspectScores(undefined, users)).toEqual([])
    expect(rankSuspectScores({}, undefined)).toEqual([])
  })

  it('does not divide by zero when a best check had an empty crew', () => {
    expect(() => rankSuspectScores({ u1: rec(1, 0, 0), u2: rec(1, 1, 2) }, users)).not.toThrow()
    expect(order(rankSuspectScores({ u1: rec(1, 0, 0), u2: rec(1, 1, 2) }, users))).toEqual(['Ben', 'Ana'])
  })
})

describe('SuspectLeaderboard', () => {
  const users = { u1: { name: 'Ana' }, u2: { name: 'Ben' }, u3: { name: 'Cleo' } }
  const rec = (checks, bestCorrect, bestTotal, extra = {}) => ({ checks, bestCorrect, bestTotal, history: [], updatedAt: 1, ...extra })

  it('shows an empty state before anyone has checked', () => {
    render(<SuspectLeaderboard scores={{}} users={users} uid="u1" />)
    expect(screen.getByText(/be the first/i)).toBeInTheDocument()
  })

  it('lists players best-first with their best check and number of checks', () => {
    render(<SuspectLeaderboard scores={{ u1: rec(3, 5, 7), u2: rec(1, 7, 7, { solvedInChecks: 1 }), u3: rec(2, 5, 7) }} users={users} uid="u1" />)
    expect(screen.getAllByText(/^(Ana|Ben|Cleo)$/).map(el => el.textContent.replace('(you)', ''))).toEqual(['Ben', 'Cleo', 'Ana'])
    expect(screen.getByText('🎉 7/7')).toBeInTheDocument()
    expect(screen.getByText('1 check')).toBeInTheDocument()
    expect(screen.getByText('2 checks')).toBeInTheDocument()
    expect(screen.getByText('3 checks')).toBeInTheDocument()
    expect(screen.getByText('🥇')).toBeInTheDocument()
    expect(screen.getByText('🥈')).toBeInTheDocument()
    expect(screen.getByText('🥉')).toBeInTheDocument()
  })

  it('marks the viewer, and nobody else', () => {
    render(<SuspectLeaderboard scores={{ u1: rec(1, 1, 2), u2: rec(1, 1, 2) }} users={users} uid="u2" />)
    expect(screen.getAllByText('(you)')).toHaveLength(1)
    expect(screen.getByText('Ben').parentElement).toHaveTextContent('(you)')
  })

  it('shows tied players with the same medal', () => {
    render(<SuspectLeaderboard scores={{ u1: rec(2, 5, 7), u2: rec(2, 5, 7) }} users={users} uid="u3" />)
    expect(screen.getAllByText('🥇')).toHaveLength(2)
  })
})

describe('recordSuspectCheck', () => {
  it("merge-writes the player's next record to their own suspectScores doc", async () => {
    const prev = nextSuspectScore(undefined, { correct: 1, total: 3 }, 5)
    const written = await recordSuspectCheck('u1', prev, { correct: 3, total: 3 })
    expect(setDoc).toHaveBeenCalledTimes(1)
    const [ref, data, opts] = setDoc.mock.calls[0]
    expect(ref).toEqual({ col: 'suspectScores', id: 'u1' })
    expect(opts).toEqual({ merge: true })
    expect(data).toEqual(written)
    expect([data.checks, data.bestCorrect, data.solvedInChecks]).toEqual([2, 3, 2])
  })

  it('writes nothing without a user or with an impossible result', async () => {
    for (const [uid, result] of [[undefined, { correct: 1, total: 2 }], ['u1', { correct: 3, total: 2 }], ['u1', null], ['u1', { correct: 'x', total: 2 }]]) {
      expect(await recordSuspectCheck(uid, {}, result)).toBeNull()
    }
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('lets a failed write reach the caller so it can warn the player', async () => {
    setDoc.mockRejectedValueOnce(new Error('permission-denied'))
    await expect(recordSuspectCheck('u1', {}, { correct: 1, total: 2 })).rejects.toThrow('permission-denied')
  })
})

describe('pickChatTip', () => {
  const role = NARRATIVE_ROLES.rebel_spy

  it('falls back to the standing joke for a player with no role, or an unknown one', () => {
    for (const key of [undefined, null, '', 'no_such_role']) {
      for (const r of [0, 0.5, 0.999]) expect(pickChatTip(key, () => r)).toBe(`Tip: ${HUSS_TIP}`)
    }
  })

  it('keeps the standing joke in the pool alongside the role tips', () => {
    expect(pickChatTip('rebel_spy', () => 0)).toBe(`Tip: ${HUSS_TIP}`)
    expect(pickChatTip('rebel_spy', () => 0.999)).toBe(`Tip: ${role.tips.at(-1)}`)
  })

  it('can reach every tip for the role, and nothing else', () => {
    const pool = [HUSS_TIP, ...role.tips].map(t => `Tip: ${t}`)
    const seen = new Set()
    for (let i = 0; i < 100; i++) seen.add(pickChatTip('rebel_spy', () => i / 100))
    expect([...seen].sort()).toEqual([...pool].sort())
  })

  it("never uses another role's tips", () => {
    const others = Object.entries(NARRATIVE_ROLES).filter(([k]) => k !== 'rebel_spy').flatMap(([, r]) => r.tips)
    for (let i = 0; i < 100; i++) expect(others).not.toContain(pickChatTip('rebel_spy', () => i / 100).replace(/^Tip: /, ''))
  })
})

describe('chat closing tip', () => {
  const reply = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => text })
  const requestText = (f, call = -1) => JSON.parse(f.mock.calls.at(call)[1].body).contents.at(-1).parts[0].text
  const systemText = (f) => JSON.parse(f.mock.calls[0][1].body).system_instruction.parts[0].text
  const mkCtx = (users, uid = 'me', over = {}) => ({
    profile: { name: 'Ann Lee' }, authUser: { uid }, users,
    games: {}, food: {}, supplies: {}, voyageMenu: {}, deckHands: {}, receipts: {}, itinerary: {}, ...over,
  })
  const askOnce = async (ctx, q = "What's for dinner tonight?") => {
    const user = userEvent.setup()
    render(<CrewAssistant ctx={ctx} />)
    await user.click(screen.getByLabelText('Open crew assistant'))
    await user.type(screen.getByPlaceholderText(/Ask anything/), `${q}{Enter}`)
    await screen.findByText('ok')
    return user
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

  it("hands the model one of the asker's own role tips as the closing line", async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    await askOnce(mkCtx({ me: { id: 'me', name: 'Ann Lee', narrativeRole: 'smuggler' } }))
    const req = requestText(f)
    expect(req).toContain('=== CLOSING TIP')
    expect(req).toContain(`Tip: ${NARRATIVE_ROLES.smuggler.tips.at(-1)}`)
  })

  it('uses the standing joke for a player with no role', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    await askOnce(mkCtx({ me: { id: 'me', name: 'Ann Lee' } }))
    expect(requestText(f)).toContain(`=== CLOSING TIP (end any game-related answer with exactly this line) ===\nTip: ${HUSS_TIP}`)
  })

  it("never leaks another player's role or their tips to the asker", async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const other = NARRATIVE_ROLES.arms_dealer
    await askOnce(mkCtx({
      me: { id: 'me', name: 'Ann Lee', narrativeRole: 'rebel_spy' },
      u2: { id: 'u2', name: 'Ben', narrativeRole: 'arms_dealer' },
    }))
    const req = requestText(f)
    expect(req).not.toContain(other.title)
    for (const t of other.tips) expect(req).not.toContain(t)
    expect(req).not.toContain('arms_dealer')
  })

  it('picks again for every question', async () => {
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0)
    const ctx = mkCtx({ me: { id: 'me', name: 'Ann Lee', narrativeRole: 'smuggler' } })
    const user = await askOnce(ctx)
    rnd.mockReturnValue(0.99)
    await user.type(screen.getByPlaceholderText(/Ask anything/), 'And tomorrow?{Enter}')
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(2))
    expect(requestText(f, 0)).toContain(`Tip: ${HUSS_TIP}`)
    expect(requestText(f, 1)).toContain(`Tip: ${NARRATIVE_ROLES.smuggler.tips.at(-1)}`)
  })

  it('reads the live role, not the one loaded at sign-in', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    await askOnce(mkCtx(
      { me: { id: 'me', name: 'Ann Lee', narrativeRole: 'smuggler' } }, 'me',
      { profile: { name: 'Ann Lee', narrativeRole: 'rebel_spy' } }))
    expect(requestText(f)).toContain(`Tip: ${NARRATIVE_ROLES.smuggler.tips.at(-1)}`)
  })

  it('tells the model to use the closing tip, and keeps the standing joke as the fallback', async () => {
    await askOnce(mkCtx({ me: { id: 'me', name: 'Ann Lee' } }))
    const sys = systemText(f)
    expect(sys).toContain('CLOSING TIP')
    expect(sys).toContain(`Tip: ${HUSS_TIP}`)
  })
})
