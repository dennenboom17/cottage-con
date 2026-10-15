import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setDoc } from 'firebase/firestore'
import {
  NARRATIVE_ROLES, LARGE_CREW, FACTION_CAP, BOARD_CAP, MAX_CLAIM_ATTEMPTS,
  pickRandomRoles, crewSize, resolveWin, unachievableWin, evaluateClaim, boardRequired, minMarkedToCheck, boardMissionMet,
  attemptsUsed, attemptsLeft, reviewedClaim, submitMissionClaim, reviewMissionClaim, forgiveClaimAttempt, buildClaim,
  MissionCard, NarrativeDossier, ClaimsReview,
} from '../App.jsx'

// Fixtures: a crew built from a list of role keys (repeats allowed), with ids p0, p1, ...
const mk = (roles) => {
  const people = roles.map((r, i) => ({ id: `p${i}`, name: `Person ${i}`, narrativeRole: r }))
  return { people, users: Object.fromEntries(people.map(p => [p.id, p])) }
}
const times = (n, role) => Array.from({ length: n }, () => role)
const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }

describe('faction wins grow with the faction, up to a cap', () => {
  // player p0 is an Admiralty Constable-General (base 2, 50% of the Rebellion, cap 5)
  const securityVs = (rebels) => resolveWin('imperial_security', mk(['imperial_security', ...times(rebels, 'rebel_pilot')]).people, 'p0')

  it('asks for the role\'s own minimum in a small game', () => {
    expect(securityVs(2).slots).toHaveLength(2)
    expect(securityVs(3).slots).toHaveLength(2)
    expect(securityVs(4).slots).toHaveLength(2) // 50% of 4 = 2
  })

  it('asks for half the faction as it grows', () => {
    expect(securityVs(6).slots).toHaveLength(3)
    expect(securityVs(8).slots).toHaveLength(4)
    expect(securityVs(9).slots).toHaveLength(5) // rounds up
  })

  it('never asks for more than the cap, however big the faction', () => {
    expect(FACTION_CAP).toBe(5)
    expect(securityVs(10).slots).toHaveLength(5)
    expect(securityVs(19).slots).toHaveLength(5)
  })

  it('puts the number in the wording, and numbers the slots only when there is more than one', () => {
    expect(securityVs(8).text).toBe('Identify 4 members of the League.')
    expect(securityVs(8).slots.map(s => s.label)).toEqual(['League member 1', 'League member 2', 'League member 3', 'League member 4'])
    const agent = resolveWin('imperial_agent', mk(['imperial_agent', 'rebel_pilot']).people, 'p0')
    expect(agent.text).toBe('Expose 1 member of the League, with proof.')
    expect(agent.slots.map(s => s.label)).toEqual(['League member'])
  })

  it('uses a lighter share for the roles that say so', () => {
    const agent = (rebels) => resolveWin('imperial_agent', mk(['imperial_agent', ...times(rebels, 'rebel_pilot')]).people, 'p0')
    const pilot = (rebels) => resolveWin('rebel_pilot', mk(['rebel_pilot', ...times(rebels, 'rebel_commander')]).people, 'p0')
    expect(agent(8).slots).toHaveLength(3) // 30% of 8 = 2.4, rounds up
    expect(pilot(8).slots).toHaveLength(3)
    expect(pilot(8).text).toBe('Meet 3 League members in need of extraction.')
    expect(pilot(1).text).toBe('Meet 1 League member in need of extraction.')
    expect(securityVs(8).slots.length).toBeGreaterThan(agent(8).slots.length)
  })

  it("counts only players who hold a role, and never the player themself", () => {
    const withSpectators = mk(['rebel_commander', ...times(5, 'rebel_pilot'), undefined, undefined, undefined])
    expect(resolveWin('rebel_commander', withSpectators.people, 'p0').slots).toHaveLength(3) // 5 other rebels, spectators ignored
    const allRebels = mk(times(7, 'rebel_commander'))
    expect(resolveWin('rebel_commander', allRebels.people, 'p0').slots).toHaveLength(3) // 6 others, not 7
  })

  it('works for the Rebellion\'s identify win against the Empire', () => {
    const spy = (empire) => resolveWin('rebel_spy', mk(['rebel_spy', ...times(empire, 'imperial_agent')]).people, 'p0')
    expect(spy(2).text).toBe('Identify 2 Admiralty agents.')
    expect(spy(8).text).toBe('Identify 4 Admiralty agents.')
    expect(spy(8).slots.every(s => s.faction === 'empire')).toBe(true)
  })

  it('never asks for fewer people than a small game can supply: it stays at the minimum and is flagged as unachievable', () => {
    const crew = mk(['imperial_security', 'rebel_pilot'])
    expect(resolveWin('imperial_security', crew.people, 'p0').slots).toHaveLength(2)
    expect(unachievableWin('imperial_security', crew.people, 'p0')).toBe('it needs 2 League members but only 1 is assigned')
  })

  it('is always completable when the faction is big enough, because it never asks for more than exists', () => {
    for (let rebels = 2; rebels <= 20; rebels++) {
      const crew = mk(['imperial_security', ...times(rebels, 'rebel_pilot')])
      expect(unachievableWin('imperial_security', crew.people, 'p0'), `${rebels} rebels`).toBeNull()
    }
  })
})

describe('big games unlock bigger versions of some wins', () => {
  const filler = (n) => times(n, 'rebel_commander')
  it('adds nothing below the threshold, and one extra part at it', () => {
    expect(LARGE_CREW).toBe(12)
    const small = mk(['rebel_arms_buyer', 'arms_dealer', ...filler(LARGE_CREW - 3)]) // 11 players
    const big = mk(['rebel_arms_buyer', 'arms_dealer', ...filler(LARGE_CREW - 2)])   // 12 players
    expect(crewSize(small.people)).toBe(LARGE_CREW - 1)
    expect(crewSize(big.people)).toBe(LARGE_CREW)
    expect(resolveWin('rebel_arms_buyer', small.people, 'p0').slots).toHaveLength(1)
    const w = resolveWin('rebel_arms_buyer', big.people, 'p0')
    expect(w.slots).toHaveLength(2)
    expect(w.slots[1]).toEqual({ faction: 'rebellion', label: 'A fellow League member who witnessed the deal' })
    expect(w.text).toBe('Meet the Freelance Gunsmith and close the deal. In a big game, bring a fellow League member along as a witness.')
  })

  it('has the Customs Inspector name the League buyer too, in a big game', () => {
    const big = mk(['imperial_smuggler_hunter', 'smuggler', 'rebel_black_market_agent', ...times(LARGE_CREW - 3, 'rebel_commander')])
    const w = resolveWin('imperial_smuggler_hunter', big.people, 'p0')
    expect(w.slots.map(s => s.role)).toEqual(['smuggler', 'rebel_black_market_agent'])
    expect(w.text).toMatch(/also name the League buyer who is purchasing from them/)
    const small = mk(['imperial_smuggler_hunter', 'smuggler', 'rebel_black_market_agent'])
    expect(resolveWin('imperial_smuggler_hunter', small.people, 'p0').slots).toHaveLength(1)
  })

  it('counts only players with a role towards the threshold', () => {
    const crew = mk(['rebel_arms_buyer', 'arms_dealer', ...times(5, 'rebel_commander'), ...times(10, undefined)])
    expect(resolveWin('rebel_arms_buyer', crew.people, 'p0').slots).toHaveLength(1) // 7 with roles, 17 people
  })

  it('judges the witness as a Rebel who is not the dealer or the player', () => {
    const crew = mk(['rebel_arms_buyer', 'arms_dealer', ...filler(LARGE_CREW - 2)])
    const slots = resolveWin('rebel_arms_buyer', crew.people, 'p0').slots
    expect(evaluateClaim('rebel_arms_buyer', ['p1', 'p2'], crew.users, 'p0', slots).ok).toBe(true)
    expect(evaluateClaim('rebel_arms_buyer', ['p1', 'p0'], crew.users, 'p0', slots).ok).toBe(false) // themself
    expect(evaluateClaim('rebel_arms_buyer', ['p1', 'p1'], crew.users, 'p0', slots).ok).toBe(false) // same person twice
    expect(evaluateClaim('rebel_arms_buyer', ['p2', 'p1'], crew.users, 'p0', slots).ok).toBe(false) // wrong way round
  })
})

describe('at 20 players', () => {
  it('every player\'s win can be completed, whatever the random assignment', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const picks = pickRandomRoles(20, NARRATIVE_ROLES, seeded(seed))
      const crew = mk(picks)
      for (const p of crew.people) {
        expect(unachievableWin(p.narrativeRole, crew.people, p.id), `seed ${seed}: ${p.narrativeRole}`).toBeNull()
      }
    }
  })

  it('asks for noticeably more than in a small game, but never more than the cap', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const crew = mk(pickRandomRoles(20, NARRATIVE_ROLES, seeded(seed)))
      for (const p of crew.people) {
        const w = resolveWin(p.narrativeRole, crew.people, p.id)
        for (const faction of ['rebellion', 'empire']) {
          const n = w.slots.filter(s => s.faction === faction).length
          expect(n).toBeLessThanOrEqual(FACTION_CAP)
        }
      }
    }
    const crew = mk(['imperial_security', ...times(9, 'rebel_pilot'), ...times(10, 'imperial_agent')])
    expect(resolveWin('imperial_security', crew.people, 'p0').slots.length).toBeGreaterThanOrEqual(4) // vs 2 in a small game
  })
})

describe('the board win scales too', () => {
  it('asks for a share of the crew, rounded up, but never more than the cap', () => {
    expect(BOARD_CAP).toBe(6)
    const need = (n) => boardRequired(n, 0.6)
    expect([1, 3, 5, 8, 9, 10, 12, 19].map(need)).toEqual([1, 2, 3, 5, 6, 6, 6, 6])
  })

  it('needs nothing when there is nobody to guess about', () => {
    expect(boardRequired(0, 0.6)).toBe(0)
    expect(boardRequired(-3, 0.6)).toBe(0)
  })

  it('puts the resolved number in the wording for the Information Broker', () => {
    const big = mk(['information_broker', ...times(19, 'rebel_pilot')])
    expect(resolveWin('information_broker', big.people, 'p0')).toMatchObject({ type: 'board', required: 6, text: 'Reach 6 correct on the Crew Suspect Board.' })
    const small = mk(['information_broker', ...times(4, 'rebel_pilot')])
    expect(resolveWin('information_broker', small.people, 'p0').text).toBe('Reach 3 correct on the Crew Suspect Board.')
  })

  it('is met at the capped number in a big game, not before', () => {
    expect(boardMissionMet('information_broker', { bestCorrect: 6, bestTotal: 19, history: [{ correct: 6, total: 19 }] })).toBe(true)
    expect(boardMissionMet('information_broker', { bestCorrect: 5, bestTotal: 19, history: [{ correct: 5, total: 19 }] })).toBe(false)
  })

  it('counts any check that qualified, not only the one with the best share', () => {
    // best by share is 2 of 3 (which needs 2): met. A later 6 of 19 has a lower share but also qualifies.
    expect(boardMissionMet('information_broker', { bestCorrect: 1, bestTotal: 5, history: [{ correct: 1, total: 5 }, { correct: 6, total: 19 }] })).toBe(true)
  })

  it('ignores malformed history and impossible scores', () => {
    expect(boardMissionMet('information_broker', { bestCorrect: 9, bestTotal: 5, history: [null, { correct: 'x' }, { correct: 5, total: 0 }] })).toBe(false)
    expect(boardMissionMet('information_broker', undefined)).toBe(false)
    expect(boardMissionMet('rebel_pilot', { bestCorrect: 9, bestTotal: 9 })).toBe(false)
  })
})

describe('minMarkedToCheck', () => {
  it('needs everyone in a small game and half of a big one', () => {
    expect([0, 1, 5, 8].map(minMarkedToCheck)).toEqual([0, 1, 5, 8])
    expect([9, 10, 19, 20].map(minMarkedToCheck)).toEqual([5, 5, 10, 10])
  })
})

describe('attempts', () => {
  const claim = (over) => ({ claimantId: 'me', status: 'rejected', ...over })

  it('allows three', () => {
    expect(MAX_CLAIM_ATTEMPTS).toBe(3)
    expect(attemptsLeft('me', {})).toBe(3)
  })

  it('counts every claim the player has made, whatever happened to it', () => {
    const claims = { a: claim(), b: claim({ status: 'pending' }), c: claim({ claimantId: 'other' }) }
    expect(attemptsUsed('me', claims)).toBe(2)
    expect(attemptsLeft('me', claims)).toBe(1)
  })

  it('does not count a claim the organiser gave back', () => {
    const claims = { a: claim({ uncounted: true }), b: claim() }
    expect(attemptsUsed('me', claims)).toBe(1)
  })

  it('never goes below zero', () => {
    const claims = { a: claim(), b: claim(), c: claim(), d: claim() }
    expect(attemptsLeft('me', claims)).toBe(0)
  })

  it('copes with no claims or malformed entries', () => {
    expect(attemptsUsed('me', undefined)).toBe(0)
    expect(attemptsUsed('me', { a: null, b: undefined })).toBe(0)
  })

  describe('submitting', () => {
    const crew = mk(['rebel_arms_buyer', 'arms_dealer'])
    const base = { claimantId: 'p0', roleKey: 'rebel_arms_buyer', picks: ['p1'], photo: 'data:image/jpeg;base64,x', users: crew.users }
    const rejected = (n, extra = {}) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i}`, { claimantId: 'p0', status: 'rejected', ...extra }]))

    it('lets a player send a third claim, and refuses a fourth', async () => {
      await expect(submitMissionClaim({ ...base, claims: rejected(2) })).resolves.toMatchObject({ status: 'pending' })
      await expect(submitMissionClaim({ ...base, claims: rejected(3) })).rejects.toThrow(`You've used all ${MAX_CLAIM_ATTEMPTS} of your attempts.`)
    })

    it('writes nothing when the attempts are used up', async () => {
      setDoc.mockClear()
      await expect(submitMissionClaim({ ...base, claims: rejected(3) })).rejects.toThrow(/attempts/)
      expect(setDoc).not.toHaveBeenCalled()
    })

    it('does not hold returned attempts against the player', async () => {
      await expect(submitMissionClaim({ ...base, claims: rejected(5, { uncounted: true }) })).resolves.toMatchObject({ status: 'pending' })
    })

    it('still reports a waiting or approved claim before the attempt limit', async () => {
      const claims = { ...rejected(2), w: { claimantId: 'p0', status: 'pending' } }
      await expect(submitMissionClaim({ ...base, claims })).rejects.toThrow(/waiting for review/)
    })
  })

  describe('reviewing', () => {
    const crew = mk(['rebel_arms_buyer', 'arms_dealer'])
    const pending = () => buildClaim({ id: 'c1', claimantId: 'p0', roleKey: 'rebel_arms_buyer', picks: ['p1'], slots: [{ role: 'arms_dealer', label: 'x' }], now: 1 })

    it('lets the organiser reject without using up an attempt', () => {
      expect(reviewedClaim(pending(), 'rejected', 'blurry', 'admin', 5, true)).toMatchObject({ status: 'rejected', uncounted: true })
      expect(reviewedClaim(pending(), 'rejected', 'blurry', 'admin', 5, false)).not.toHaveProperty('uncounted')
    })

    it('only ever marks a rejection as uncounted', () => {
      expect(reviewedClaim(pending(), 'approved', '', 'admin', 5, true)).not.toHaveProperty('uncounted')
    })

    it('passes the choice through when reviewing', async () => {
      setDoc.mockClear()
      const out = await reviewMissionClaim({ claim: pending(), decision: 'rejected', note: 'unclear', reviewerId: 'a', users: crew.users, uncounted: true })
      expect(out.uncounted).toBe(true)
      expect(setDoc.mock.calls[0][1].uncounted).toBe(true)
    })

    it('gives an attempt back by flagging only that claim, and only if it was rejected', async () => {
      setDoc.mockClear()
      await forgiveClaimAttempt({ id: 'c9', status: 'rejected' })
      expect(setDoc.mock.calls[0][0]).toEqual({ col: 'missionClaims', id: 'c9' })
      expect(setDoc.mock.calls[0][1]).toEqual({ uncounted: true })
      expect(setDoc.mock.calls[0][2]).toEqual({ merge: true })
      await expect(forgiveClaimAttempt({ id: 'c9', status: 'approved' })).rejects.toThrow(/rejected/)
      await expect(forgiveClaimAttempt(undefined)).rejects.toThrow(/rejected/)
    })
  })
})

describe('a claim keeps what was asked of the player', () => {
  it('records the slots and wording at the time, so reviewing does not change if the crew does', async () => {
    const small = mk(['imperial_security', ...times(2, 'rebel_pilot')])
    const claim = await submitMissionClaim({ claimantId: 'p0', roleKey: 'imperial_security', picks: ['p1', 'p2'], photo: 'data:x', users: small.users, claims: {} })
    expect(claim.slots).toHaveLength(2)
    expect(claim.winText).toBe('Identify 2 members of the League.')

    // ...the crew then grows, which would now ask for four, but the claim is still judged on what it was
    const grown = mk(['imperial_security', ...times(8, 'rebel_pilot')])
    expect(evaluateClaim('imperial_security', claim.picks, grown.users, 'p0').ok).toBe(false) // judged afresh: asks for 4
    expect(evaluateClaim('imperial_security', claim.picks, grown.users, 'p0', claim.slots).ok).toBe(true) // judged on its snapshot
    await expect(reviewMissionClaim({ claim: { ...claim, status: 'pending' }, decision: 'approved', reviewerId: 'a', users: grown.users })).resolves.toMatchObject({ status: 'approved' })
  })

  it('needs one pick per scaled slot when claiming', async () => {
    const crew = mk(['imperial_security', ...times(8, 'rebel_pilot')]) // asks for 4
    const base = { claimantId: 'p0', roleKey: 'imperial_security', photo: 'data:x', users: crew.users, claims: {} }
    await expect(submitMissionClaim({ ...base, picks: ['p1', 'p2'] })).rejects.toThrow(/different crew member/)
    await expect(submitMissionClaim({ ...base, picks: ['p1', 'p2', 'p3', 'p4'] })).resolves.toMatchObject({ picks: ['p1', 'p2', 'p3', 'p4'] })
  })
})

describe('MissionCard: scaling and attempts', () => {
  const big = mk(['imperial_security', ...times(8, 'rebel_pilot'), ...times(3, 'imperial_agent')])
  const render1 = (over = {}) => render(<MissionCard roleKey="imperial_security" uid="p0" users={big.users} claims={{}} scores={{}} onSubmit={vi.fn().mockResolvedValue(true)} {...over} />)
  const rejected = (n, extra = {}) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i}`, { claimantId: 'p0', status: 'rejected', reviewedAt: i + 1, ...extra }]))

  it('shows one picker for each person the bigger game asks for', () => {
    render1()
    expect(screen.getByText('Identify 4 members of the League.')).toBeInTheDocument()
    expect(screen.getAllByRole('combobox').map(c => c.getAttribute('aria-label'))).toEqual(['League member 1', 'League member 2', 'League member 3', 'League member 4'])
  })

  it('shows how many attempts are left', () => {
    render1()
    expect(screen.getByText('Attempts left: 3 of 3')).toBeInTheDocument()
  })

  it('counts down as claims are turned down', () => {
    render1({ claims: rejected(2) })
    expect(screen.getByText('Attempts left: 1 of 3')).toBeInTheDocument()
    expect(screen.getByText(/Your last claim wasn't approved\. You can send a new one\./)).toBeInTheDocument()
  })

  it('does not count returned attempts', () => {
    render1({ claims: rejected(3, { uncounted: true }) })
    expect(screen.getByText('Attempts left: 3 of 3')).toBeInTheDocument()
  })

  it('takes the form away when the attempts are used up', () => {
    render1({ claims: rejected(3, { reviewNote: 'Not them' }) })
    expect(screen.getByText(/You've used all 3 of your attempts/)).toBeInTheDocument()
    expect(screen.getByText(/Your last claim wasn't approved\. Organiser's note: Not them/)).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send claim/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/You can send a new one/)).not.toBeInTheDocument()
  })

  it('does not take the form away from a mission that is already done or waiting', () => {
    render1({ claims: { ...rejected(2), a: { claimantId: 'p0', status: 'approved' } } })
    expect(screen.getByRole('status')).toHaveTextContent('Mission accomplished')
    expect(screen.queryByText(/Attempts left/)).not.toBeInTheDocument()
  })
})

describe('Crew Suspect Board: checking with part of a big crew marked', () => {
  beforeEach(() => localStorage.clear()) // guesses are saved per player on the device
  const crew = mk(['rebel_spy', ...times(19, 'rebel_pilot')]) // p0 plus 19 others
  const open = async (over = {}) => {
    const user = userEvent.setup()
    const doRecordSuspectCheck = vi.fn()
    render(<NarrativeDossier ctx={{ authUser: { uid: 'p0' }, profile: {}, users: crew.users, suspectScores: {}, doRecordSuspectCheck, missionClaims: {}, ...over }} />)
    await user.click(screen.getByRole('button', { name: /open your dossier/i }))
    return { user, doRecordSuspectCheck }
  }
  const guess = (user, id, value = 'rebel_pilot') => user.selectOptions(screen.getByLabelText(`Guess role for Person ${id.slice(1)}`), value)

  it('asks for half the crew, and says so', async () => {
    const { user } = await open()
    const btn = screen.getByRole('button', { name: /check my guesses/i })
    expect(btn).toBeDisabled()
    expect(screen.getByText(/Mark at least 10 of 19 crew members to unlock the check — 10 to go\. Anyone left unmarked counts as wrong\./)).toBeInTheDocument()
    for (let i = 1; i <= 9; i++) await guess(user, `p${i}`)
    expect(btn).toBeDisabled()
    expect(screen.getByText(/1 to go/)).toBeInTheDocument()
    await guess(user, 'p10')
    expect(btn).toBeEnabled()
  }, 30000)

  it('scores the unmarked as wrong, out of the whole crew', async () => {
    const { user, doRecordSuspectCheck } = await open()
    for (let i = 1; i <= 10; i++) await guess(user, `p${i}`) // all right
    await user.click(screen.getByRole('button', { name: /check my guesses/i }))
    expect(doRecordSuspectCheck).toHaveBeenCalledWith({ correct: 10, total: 19 })
  }, 30000)

  it('still needs everyone in a small crew', async () => {
    const small = mk(['rebel_spy', ...times(3, 'rebel_pilot')])
    const user = userEvent.setup()
    render(<NarrativeDossier ctx={{ authUser: { uid: 'p0' }, profile: {}, users: small.users, suspectScores: {}, missionClaims: {} }} />)
    await user.click(screen.getByRole('button', { name: /open your dossier/i }))
    expect(screen.getByText(/Mark all 3 crew members to unlock the check — 3 to go\./)).toBeInTheDocument()
  })
})

describe('Mission claims review: attempts', () => {
  const crew = mk(['rebel_arms_buyer', 'arms_dealer', 'smuggler'])
  const claim = (over = {}) => ({ id: 'c1', claimantId: 'p0', roleKey: 'rebel_arms_buyer', picks: ['p1'], slots: [{ role: 'arms_dealer', label: 'The Freelance Gunsmith' }], winText: 'Meet the Freelance Gunsmith and close the deal.', note: '', status: 'pending', createdAt: 100, ...over })
  const setup = (claims, over = {}) => {
    const ctx = { users: crew.users, missionClaims: claims, suspectScores: {}, doReviewMissionClaim: vi.fn().mockResolvedValue(true), doForgiveClaimAttempt: vi.fn().mockResolvedValue(true), ...over }
    render(<ClaimsReview ctx={ctx} />)
    return ctx
  }

  it("says which attempt a claim is", () => {
    setup({ a: claim({ id: 'a', status: 'rejected', reviewedAt: 1 }), b: claim({ id: 'b', createdAt: 200 }) })
    expect(screen.getByText('Attempt 2 of 3')).toBeInTheDocument()
  })

  it('lets the organiser reject without using up the attempt', async () => {
    const user = userEvent.setup()
    const ctx = setup({ c1: claim() })
    await user.click(screen.getByLabelText(/don't count it as one of their 3 attempts/i))
    await user.click(screen.getByRole('button', { name: /reject/i }))
    expect(ctx.doReviewMissionClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'rejected', '', true)
  })

  it('counts a normal rejection', async () => {
    const user = userEvent.setup()
    const ctx = setup({ c1: claim() })
    await user.click(screen.getByRole('button', { name: /reject/i }))
    expect(ctx.doReviewMissionClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'rejected', '', false)
  })

  it('offers to give an attempt back on a counted rejection, and says when it has been', async () => {
    const user = userEvent.setup()
    const ctx = setup({ a: claim({ id: 'a', status: 'rejected', reviewedAt: 5 }), b: claim({ id: 'b', status: 'rejected', reviewedAt: 3, uncounted: true }) })
    expect(screen.getByText('(attempt returned)')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: /give attempt back/i })
    expect(buttons).toHaveLength(1)
    await user.click(buttons[0])
    expect(ctx.doForgiveClaimAttempt).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it('offers no give-back on an approved claim', () => {
    setup({ a: claim({ status: 'approved', reviewedAt: 5 }) })
    expect(screen.queryByRole('button', { name: /give attempt back/i })).not.toBeInTheDocument()
  })

  it('judges a claim on the slots it was made with, not on today\'s crew', () => {
    const big = mk(['rebel_arms_buyer', 'arms_dealer', ...times(10, 'rebel_commander')]) // today a witness would also be asked for
    setup({ c1: claim() }, { users: big.users })
    expect(screen.getAllByTestId('claim-slot')).toHaveLength(1)
    expect(screen.getByText('Meet the Freelance Gunsmith and close the deal.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled()
  })
})
