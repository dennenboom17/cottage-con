import { describe, it, expect, vi } from 'vitest'
import { setDoc } from 'firebase/firestore'
import {
  NARRATIVE_ROLES, NARRATIVE_FACTIONS, requiredRoles, winOf, unachievableWin, evaluateClaim, buildClaim, reviewedClaim,
  missionStatus, boardMissionMet, completedMissionCount, prepareProofPhoto, submitMissionClaim, reviewMissionClaim,
  MAX_PROOF_CHARS,
} from '../App.jsx'

const users = {
  me: { name: 'Mia', narrativeRole: 'rebel_arms_buyer' },
  d: { name: 'Dev', narrativeRole: 'arms_dealer' },
  s: { name: 'Sam', narrativeRole: 'smuggler' },
  h: { name: 'Hal', narrativeRole: 'imperial_arms_hunter' },
  n: { name: 'Nia' }, // no role
}

describe('win conditions: data', () => {
  it('gives every role a win condition of a known kind, with text', () => {
    for (const [key, r] of Object.entries(NARRATIVE_ROLES)) {
      expect(['meet', 'identify', 'board'], key).toContain(r.win?.type)
      expect(r.win.text?.trim(), `${key} text`).toBeTruthy()
    }
  })

  it('describes each meet/identify claim as labelled slots naming exactly one role or faction that exists', () => {
    for (const [key, r] of Object.entries(NARRATIVE_ROLES)) {
      if (r.win.type === 'board') continue
      expect(r.win.slots.length, key).toBeGreaterThan(0)
      expect(r.win.proofHint?.trim(), `${key} proofHint`).toBeTruthy()
      for (const sl of r.win.slots) {
        expect(sl.label?.trim(), `${key} label`).toBeTruthy()
        expect(Boolean(sl.role) !== Boolean(sl.faction), `${key}: one of role/faction`).toBe(true)
        if (sl.role) expect(NARRATIVE_ROLES[sl.role], `${key} → ${sl.role}`).toBeTruthy()
        if (sl.faction) expect(NARRATIVE_FACTIONS[sl.faction], `${key} → ${sl.faction}`).toBeTruthy()
      }
    }
  })

  it('gives the board mission a sensible share', () => {
    const board = Object.entries(NARRATIVE_ROLES).filter(([, r]) => r.win.type === 'board')
    expect(board.length).toBeGreaterThan(0)
    for (const [key, r] of board) { expect(r.win.minShare, key).toBeGreaterThan(0); expect(r.win.minShare, key).toBeLessThanOrEqual(1) }
  })

  it('guarantees every role a target: each role a win names is required, so random assignment always includes it', () => {
    for (const [key, r] of Object.entries(NARRATIVE_ROLES)) {
      for (const sl of r.win.slots || []) {
        if (sl.role) expect(requiredRoles(key), `${key} → ${sl.role}`).toContain(sl.role)
      }
    }
  })

  it('has the Rebel arms buyer meet the Freelance Arms Dealer', () => {
    const w = winOf('rebel_arms_buyer')
    expect(w.type).toBe('meet')
    expect(w.slots).toEqual([expect.objectContaining({ role: 'arms_dealer' })])
  })

  it('has the Imperial investigator identify both the dealer and the Rebel buyer', () => {
    const w = winOf('imperial_arms_hunter')
    expect(w.type).toBe('identify')
    expect(w.slots.map(sl => sl.role)).toEqual(['arms_dealer', 'rebel_arms_buyer'])
  })

  it('has the black-market pair meet, and the customs inspector identify the smuggler', () => {
    expect(winOf('rebel_black_market_agent').slots[0].role).toBe('smuggler')
    expect(winOf('smuggler').slots[0].role).toBe('rebel_black_market_agent')
    expect(winOf('imperial_smuggler_hunter').slots[0].role).toBe('smuggler')
  })

  it('is looked up safely for roles that do not exist', () => {
    expect(winOf('nope')).toBeNull()
    expect(winOf(undefined)).toBeNull()
  })
})

describe('unachievableWin', () => {
  const people = Object.entries(users).map(([id, u]) => ({ ...u, id }))

  it('is fine when the roles the win needs are assigned to someone else', () => {
    expect(unachievableWin('rebel_arms_buyer', people, 'me')).toBeNull()
    expect(unachievableWin('imperial_arms_hunter', people, 'h')).toBeNull() // dealer + buyer both present
  })

  it('names the missing role', () => {
    expect(unachievableWin('rebel_black_market_agent', people.filter(p => p.id !== 's'), 'me')).toBe('no Black Market Smuggler is assigned')
  })

  it("does not count the player as their own target", () => {
    expect(unachievableWin('arms_dealer', [{ id: 'd', narrativeRole: 'arms_dealer' }], 'd')).toBe('no Rebel Arms Procurement Officer is assigned')
  })

  it('counts faction members, excluding the player', () => {
    const crew = [{ id: 'a', narrativeRole: 'imperial_security' }, { id: 'b', narrativeRole: 'rebel_spy' }, { id: 'c', narrativeRole: 'rebel_pilot' }]
    expect(unachievableWin('imperial_security', crew, 'a')).toBeNull() // two rebels for two slots
    expect(unachievableWin('imperial_security', [...crew, { id: 'z', narrativeRole: 'imperial_agent' }], 'z')).toBeNull() // the Empire do not count towards it
  })

  it('says how many are short', () => {
    const crew = [{ id: 'a', narrativeRole: 'imperial_security' }, { id: 'b', narrativeRole: 'rebel_spy' }]
    expect(unachievableWin('imperial_security', crew, 'a')).toBe('it needs 2 Rebellion members but only 1 is assigned')
    expect(unachievableWin('imperial_agent', [{ id: 'a', narrativeRole: 'imperial_agent' }], 'a')).toBe('it needs 1 Rebellion member but only 0 are assigned')
  })

  it('never blocks a board mission or an unknown role', () => {
    expect(unachievableWin('information_broker', [], 'x')).toBeNull()
    expect(unachievableWin('nope', [], 'x')).toBeNull()
  })
})

describe('evaluateClaim', () => {
  it('accepts the right person for a role slot', () => {
    expect(evaluateClaim('rebel_arms_buyer', ['d'], users, 'me')).toEqual({ slots: [true], ok: true })
  })

  it('rejects the wrong person, someone with no role, nobody, and an unknown person', () => {
    for (const pick of ['s', 'n', undefined, 'ghost']) expect(evaluateClaim('rebel_arms_buyer', [pick], users, 'me').ok, String(pick)).toBe(false)
  })

  it('checks each slot of a two-part claim separately', () => {
    expect(evaluateClaim('imperial_arms_hunter', ['d', 'me'], users, 'h')).toEqual({ slots: [true, true], ok: true })
    expect(evaluateClaim('imperial_arms_hunter', ['d', 's'], users, 'h')).toEqual({ slots: [true, false], ok: false })
    expect(evaluateClaim('imperial_arms_hunter', ['me', 'd'], users, 'h').ok).toBe(false) // right people, wrong way round
  })

  it('never lets players name themselves', () => {
    expect(evaluateClaim('arms_dealer', ['d'], users, 'd').ok).toBe(false)
  })

  it('matches faction slots by faction, and needs different people', () => {
    const crew = { a: { narrativeRole: 'imperial_security' }, b: { narrativeRole: 'rebel_spy' }, c: { narrativeRole: 'rebel_pilot' }, e: { narrativeRole: 'imperial_agent' } }
    expect(evaluateClaim('imperial_security', ['b', 'c'], crew, 'a')).toEqual({ slots: [true, true], ok: true })
    expect(evaluateClaim('imperial_security', ['b', 'e'], crew, 'a')).toEqual({ slots: [true, false], ok: false })
    expect(evaluateClaim('imperial_security', ['b', 'b'], crew, 'a')).toEqual({ slots: [true, false], ok: false })
  })

  it('has nothing to evaluate for a board mission or an unknown role', () => {
    expect(evaluateClaim('information_broker', [], users, 'me').ok).toBe(false)
    expect(evaluateClaim('nope', ['d'], users, 'me').ok).toBe(false)
  })
})

describe('claims', () => {
  it('builds a pending claim, trimming and limiting the note', () => {
    const c = buildClaim({ id: 'c1', claimantId: 'me', roleKey: 'rebel_arms_buyer', picks: ['d'], note: `  ${'x'.repeat(400)}  `, now: 7 })
    expect(c).toMatchObject({ id: 'c1', claimantId: 'me', roleKey: 'rebel_arms_buyer', picks: ['d'], status: 'pending', createdAt: 7 })
    expect(c.note).toHaveLength(300)
    expect(buildClaim({ id: 'c', claimantId: 'me', roleKey: 'x', picks: [] }).note).toBe('')
  })

  it('records who reviewed a claim, when, and why', () => {
    const c = buildClaim({ id: 'c1', claimantId: 'me', roleKey: 'x', picks: ['d'], now: 1 })
    expect(reviewedClaim(c, 'rejected', ' blurry ', 'admin', 9)).toMatchObject({ status: 'rejected', reviewNote: 'blurry', reviewedBy: 'admin', reviewedAt: 9, id: 'c1' })
  })
})

describe('missionStatus', () => {
  const claim = (over) => ({ claimantId: 'me', status: 'pending', ...over })

  it('is none without claims', () => {
    expect(missionStatus('me', undefined)).toEqual({ state: 'none', claim: null })
    expect(missionStatus('me', { a: claim({ claimantId: 'other' }) }).state).toBe('none')
  })

  it('shows a waiting claim as pending', () => {
    expect(missionStatus('me', { a: claim() }).state).toBe('pending')
  })

  it('lets an approval win over everything else', () => {
    expect(missionStatus('me', { a: claim({ status: 'rejected' }), b: claim(), c: claim({ status: 'approved' }) }).state).toBe('approved')
  })

  it('falls back to the most recent rejection once nothing is waiting', () => {
    const out = missionStatus('me', { a: claim({ status: 'rejected', reviewedAt: 1, reviewNote: 'old' }), b: claim({ status: 'rejected', reviewedAt: 5, reviewNote: 'new' }) })
    expect(out.state).toBe('rejected')
    expect(out.claim.reviewNote).toBe('new')
  })

  it('ignores malformed entries', () => {
    expect(missionStatus('me', { a: null, b: undefined, c: claim() }).state).toBe('pending')
  })
})

describe('board missions and the completed count', () => {
  it('is met once the best check reaches the share, and not before', () => {
    expect(boardMissionMet('information_broker', { bestCorrect: 3, bestTotal: 5 })).toBe(true) // exactly 60%
    expect(boardMissionMet('information_broker', { bestCorrect: 5, bestTotal: 9 })).toBe(false)
    expect(boardMissionMet('information_broker', { bestCorrect: 9, bestTotal: 9 })).toBe(true)
  })

  it('is never met without a score, with an empty crew, or for other kinds of mission', () => {
    expect(boardMissionMet('information_broker', undefined)).toBe(false)
    expect(boardMissionMet('information_broker', { bestCorrect: 0, bestTotal: 0 })).toBe(false)
    expect(boardMissionMet('rebel_arms_buyer', { bestCorrect: 9, bestTotal: 9 })).toBe(false)
  })

  it('counts approved claims and met board missions, as a number only', () => {
    const crew = {
      a: { narrativeRole: 'rebel_arms_buyer' }, b: { narrativeRole: 'information_broker' },
      c: { narrativeRole: 'smuggler' }, d: {}, e: { narrativeRole: 'arms_dealer' },
    }
    const claims = { x: { claimantId: 'a', status: 'approved' }, y: { claimantId: 'c', status: 'pending' }, z: { claimantId: 'd', status: 'approved' } }
    const scores = { b: { bestCorrect: 4, bestTotal: 5 }, e: { bestCorrect: 5, bestTotal: 5 } }
    expect(completedMissionCount(crew, claims, scores)).toBe(2) // a (claim) and b (board); d has no role, e's score doesn't count
  })

  it('handles no data', () => {
    expect(completedMissionCount(undefined, undefined, undefined)).toBe(0)
  })
})

describe('prepareProofPhoto', () => {
  const file = (type = 'image/jpeg', parts = ['pixels']) => new File(parts, 'proof.jpg', { type })

  it('turns a photo into the compressed data URL', async () => {
    const compress = vi.fn(async () => 'data:image/jpeg;base64,small')
    expect(await prepareProofPhoto(file(), compress)).toBe('data:image/jpeg;base64,small')
    expect(compress).toHaveBeenCalledTimes(1)
    expect(compress.mock.calls[0][0]).toMatch(/^data:image\/jpeg;base64,/) // the original file, read as a data URL
  })

  it('squeezes harder when the first pass is still too big', async () => {
    const compress = vi.fn(async (_d, max) => (max === 900 ? 'x'.repeat(MAX_PROOF_CHARS + 1) : 'tiny'))
    expect(await prepareProofPhoto(file(), compress)).toBe('tiny')
    expect(compress.mock.calls.map(c => c[1])).toEqual([900, 640])
  })

  it('gives up with a clear message if it still will not fit', async () => {
    const compress = vi.fn(async () => 'x'.repeat(MAX_PROOF_CHARS + 1))
    await expect(prepareProofPhoto(file(), compress)).rejects.toThrow(/shrink/)
  })

  it('refuses things that are not images, and enormous files', async () => {
    const compress = vi.fn()
    await expect(prepareProofPhoto(file('application/pdf'), compress)).rejects.toThrow(/image/)
    await expect(prepareProofPhoto(undefined, compress)).rejects.toThrow(/image/)
    await expect(prepareProofPhoto(file('image/jpeg', [new ArrayBuffer(15 * 1024 * 1024 + 1)]), compress)).rejects.toThrow(/too large/)
    expect(compress).not.toHaveBeenCalled()
  })

  it('accepts a phone-sized photo that profile pictures would have rejected', async () => {
    const compress = vi.fn(async () => 'data:image/jpeg;base64,ok')
    await expect(prepareProofPhoto(file('image/jpeg', [new ArrayBuffer(4 * 1024 * 1024)]), compress)).resolves.toBe('data:image/jpeg;base64,ok')
  })
})

describe('submitMissionClaim', () => {
  const base = { claimantId: 'me', roleKey: 'rebel_arms_buyer', picks: ['d'], note: 'by the fire', photo: 'data:image/jpeg;base64,abc', users, claims: {} }

  it('saves the proof photo first, then the claim, each in its own document', async () => {
    const claim = await submitMissionClaim(base)
    expect(setDoc).toHaveBeenCalledTimes(2)
    const [[proofRef, proof], [claimRef, saved, opts]] = setDoc.mock.calls
    expect(proofRef.col).toBe('missionProofs')
    expect(claimRef.col).toBe('missionClaims')
    expect(proofRef.id).toBe(claimRef.id)
    expect(proof).toEqual({ id: claim.id, claimantId: 'me', photo: base.photo })
    expect(saved).toEqual(claim)
    expect(claim).toMatchObject({ claimantId: 'me', roleKey: 'rebel_arms_buyer', picks: ['d'], note: 'by the fire', status: 'pending' })
    expect(saved).not.toHaveProperty('photo') // the photo is kept out of the shared claim list
    expect(opts).toEqual({ merge: true })
  })

  it('does not write the claim if the photo fails to save', async () => {
    setDoc.mockRejectedValueOnce(new Error('too big'))
    await expect(submitMissionClaim(base)).rejects.toThrow('too big')
    expect(setDoc).toHaveBeenCalledTimes(1)
  })

  it('needs a photo', async () => {
    await expect(submitMissionClaim({ ...base, photo: '' })).rejects.toThrow(/photo/i)
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('needs a different crew member for every part, never yourself', async () => {
    const hunter = { ...base, claimantId: 'h', roleKey: 'imperial_arms_hunter' }
    await expect(submitMissionClaim({ ...hunter, picks: ['d'] })).rejects.toThrow(/different crew member/)
    await expect(submitMissionClaim({ ...hunter, picks: ['d', ''] })).rejects.toThrow(/different crew member/)
    await expect(submitMissionClaim({ ...hunter, picks: ['d', 'd'] })).rejects.toThrow(/different crew member/)
    await expect(submitMissionClaim({ ...hunter, picks: ['d', 'h'] })).rejects.toThrow(/different crew member/)
    await expect(submitMissionClaim({ ...base, picks: ['me'] })).rejects.toThrow(/different crew member/)
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('refuses someone who has left the crew', async () => {
    await expect(submitMissionClaim({ ...base, picks: ['ghost'] })).rejects.toThrow(/no longer in the crew/)
  })

  it('does not take claims for a board mission or a role with no mission', async () => {
    await expect(submitMissionClaim({ ...base, roleKey: 'information_broker' })).rejects.toThrow(/doesn't use claims/)
    await expect(submitMissionClaim({ ...base, roleKey: undefined })).rejects.toThrow(/doesn't use claims/)
  })

  it('allows one claim at a time, and none once the mission is complete', async () => {
    await expect(submitMissionClaim({ ...base, claims: { c: { claimantId: 'me', status: 'pending' } } })).rejects.toThrow(/waiting for review/)
    await expect(submitMissionClaim({ ...base, claims: { c: { claimantId: 'me', status: 'approved' } } })).rejects.toThrow(/already complete/)
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('lets a rejected claim be tried again', async () => {
    await expect(submitMissionClaim({ ...base, claims: { c: { claimantId: 'me', status: 'rejected' } } })).resolves.toMatchObject({ status: 'pending' })
  })
})

describe('reviewMissionClaim', () => {
  const pending = (over) => buildClaim({ id: 'c1', claimantId: 'me', roleKey: 'rebel_arms_buyer', picks: ['d'], now: 1, ...over })

  it('approves a claim that matches the assigned roles, with a merge-write to that claim only', async () => {
    const out = await reviewMissionClaim({ claim: pending(), decision: 'approved', note: 'nice', reviewerId: 'admin', users })
    expect(out).toMatchObject({ status: 'approved', reviewNote: 'nice', reviewedBy: 'admin' })
    const [ref, data, opts] = setDoc.mock.calls[0]
    expect(ref).toEqual({ col: 'missionClaims', id: 'c1' })
    expect(data).toEqual(out)
    expect(opts).toEqual({ merge: true })
  })

  it("refuses to approve a claim that doesn't match, even if asked", async () => {
    await expect(reviewMissionClaim({ claim: pending({ picks: ['s'] }), decision: 'approved', reviewerId: 'admin', users })).rejects.toThrow(/can't be approved/)
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('still lets the organiser reject a claim that matches, for example a poor photo', async () => {
    const out = await reviewMissionClaim({ claim: pending(), decision: 'rejected', note: 'blurry', reviewerId: 'admin', users })
    expect(out.status).toBe('rejected')
  })

  it('only reviews a claim once', async () => {
    await expect(reviewMissionClaim({ claim: { ...pending(), status: 'approved' }, decision: 'rejected', reviewerId: 'admin', users })).rejects.toThrow(/already been reviewed/)
    await expect(reviewMissionClaim({ claim: undefined, decision: 'approved', reviewerId: 'admin', users })).rejects.toThrow(/already been reviewed/)
  })

  it('needs a real decision', async () => {
    await expect(reviewMissionClaim({ claim: pending(), decision: 'maybe', reviewerId: 'admin', users })).rejects.toThrow(/approve or reject/)
  })
})
