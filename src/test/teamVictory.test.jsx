import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setDoc, getDoc, onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import App, {
  TEAM_THRESHOLD, CONTENDERS, missionDoneAt, boardMetAt, completedMissionCount, teamThreshold, gameEndTime, teamStandings, teamOutcome,
  victoryText, TeamStandings, VictoryBanner, TeamVictoryManager, MissionCard, NarrativeDossier, submitMissionClaim, nextSuspectScore,
  NARRATIVE_FACTIONS,
} from '../App.jsx'

vi.setConfig({ testTimeout: 20000 })

// ── fixtures ────────────────────────────────────────────────────────────────
const ROLE = { empire: 'imperial_agent', rebellion: 'rebel_pilot', independent: 'arms_dealer' }
// A crew with `n` players per faction, ids like e0, r1, i2. Returns the users and the ids by faction.
function crew({ empire = 0, rebellion = 0, independent = 0 }) {
  const users = {}, ids = { empire: [], rebellion: [], independent: [] }
  const add = (f, n, p) => { for (let i = 0; i < n; i++) { const id = `${p}${i}`; users[id] = { name: id, narrativeRole: ROLE[f] }; ids[f].push(id) } }
  add('empire', empire, 'e'); add('rebellion', rebellion, 'r'); add('independent', independent, 'i')
  return { users, ids }
}
// approved claims, one per id, submitted at the given times
const approved = (list) => Object.fromEntries(list.map(([id, at]) => [`c_${id}`, { id: `c_${id}`, claimantId: id, status: 'approved', createdAt: at }]))
const times = (ids, from = 100) => ids.map((id, i) => [id, from + i])

describe('missionDoneAt', () => {
  it('is the time the approved claim was submitted, not reviewed', () => {
    const claims = { c1: { claimantId: 'e0', status: 'approved', createdAt: 50, reviewedAt: 9000 } }
    expect(missionDoneAt('e0', { narrativeRole: ROLE.empire }, claims, {})).toBe(50)
  })

  it('takes the earliest if there are several approved claims', () => {
    const claims = { a: { claimantId: 'e0', status: 'approved', createdAt: 80 }, b: { claimantId: 'e0', status: 'approved', createdAt: 30 } }
    expect(missionDoneAt('e0', { narrativeRole: ROLE.empire }, claims, {})).toBe(30)
  })

  it('is null for a pending, rejected or someone else\'s claim, or no claim at all', () => {
    const claims = { a: { claimantId: 'e0', status: 'pending', createdAt: 1 }, b: { claimantId: 'e0', status: 'rejected', createdAt: 1 }, c: { claimantId: 'e1', status: 'approved', createdAt: 1 } }
    expect(missionDoneAt('e0', { narrativeRole: ROLE.empire }, claims, {})).toBeNull()
    expect(missionDoneAt('e0', { narrativeRole: ROLE.empire }, undefined, undefined)).toBeNull()
  })

  it('is null for a player with no role', () => {
    expect(missionDoneAt('x', {}, approved([['x', 1]]), {})).toBeNull()
    expect(missionDoneAt('x', undefined, approved([['x', 1]]), {})).toBeNull()
  })

  it('uses the time of the qualifying check for a board mission', () => {
    const score = { bestCorrect: 4, bestTotal: 5, updatedAt: 900, history: [{ correct: 1, total: 5, at: 100 }, { correct: 4, total: 5, at: 400 }, { correct: 5, total: 5, at: 700 }] }
    expect(missionDoneAt('b', { narrativeRole: 'information_broker' }, {}, { b: score })).toBe(400)
  })

  it('is null for a board mission that has not been met', () => {
    expect(missionDoneAt('b', { narrativeRole: 'information_broker' }, {}, { b: { bestCorrect: 1, bestTotal: 5, history: [{ correct: 1, total: 5, at: 1 }] } })).toBeNull()
    expect(missionDoneAt('b', { narrativeRole: 'information_broker' }, {}, {})).toBeNull()
  })
})

describe('boardMetAt', () => {
  it('falls back to the last check time for checks saved before times were recorded', () => {
    expect(boardMetAt('information_broker', { bestCorrect: 4, bestTotal: 5, updatedAt: 777, history: [{ correct: 4, total: 5 }] })).toBe(777)
    expect(boardMetAt('information_broker', { bestCorrect: 4, bestTotal: 5, updatedAt: 888 })).toBe(888)
  })

  it('is null for other kinds of mission or no score', () => {
    expect(boardMetAt('rebel_pilot', { bestCorrect: 9, bestTotal: 9 })).toBeNull()
    expect(boardMetAt('information_broker', undefined)).toBeNull()
  })
})

describe('each saved check records when it was made', () => {
  it('stamps the new history entry', () => {
    const rec = nextSuspectScore(nextSuspectScore(undefined, { correct: 1, total: 2 }, 10), { correct: 2, total: 2 }, 20)
    expect(rec.history.map(h => h.at)).toEqual([10, 20])
  })
})

describe('settings', () => {
  it('defaults the threshold to 65%', () => {
    expect(TEAM_THRESHOLD).toBe(0.65)
    expect(teamThreshold(undefined)).toBe(0.65)
    expect(teamThreshold({})).toBe(0.65)
  })

  it('takes a sensible threshold from the settings and ignores nonsense', () => {
    expect(teamThreshold({ threshold: 0.5 })).toBe(0.5)
    expect(teamThreshold({ threshold: 1 })).toBe(1)
    for (const bad of [0, -1, 1.5, 'x', null, NaN]) expect(teamThreshold({ threshold: bad }), String(bad)).toBe(0.65)
  })

  it('ends the game at the earlier of the scheduled and manual end', () => {
    expect(gameEndTime({})).toBeNull()
    expect(gameEndTime({ endsAt: 500 })).toBe(500)
    expect(gameEndTime({ endedAt: 300 })).toBe(300)
    expect(gameEndTime({ endsAt: 500, endedAt: 300 })).toBe(300)
    expect(gameEndTime({ endsAt: 200, endedAt: 300 })).toBe(200)
    expect(gameEndTime({ endsAt: null, endedAt: null })).toBeNull()
  })
})

describe('teamStandings', () => {
  it('counts the players who hold a role on each side, and how many have finished', () => {
    const { users, ids } = crew({ empire: 4, rebellion: 5, independent: 2 })
    users.spectator = { name: 'Nia' } // no role: on no team
    const s = teamStandings(users, approved(times([...ids.empire.slice(0, 2), ids.rebellion[0]])), {})
    expect([s.empire.members, s.empire.done]).toEqual([4, 2])
    expect([s.rebellion.members, s.rebellion.done]).toEqual([5, 1])
    expect([s.independent.members, s.independent.done]).toEqual([2, 0])
    expect(s.empire.share).toBe(0.5)
    expect(s.rebellion.share).toBe(0.2)
  })

  it('has no share for a side with nobody on it', () => {
    const s = teamStandings(crew({ empire: 2 }).users, {}, {})
    expect(s.rebellion).toMatchObject({ members: 0, share: null, needed: 0, crossedAt: null })
  })

  it('needs the threshold share of the team, rounded up, and at least one', () => {
    const needed = (n, threshold) => teamStandings(crew({ empire: n }).users, {}, {}, threshold).empire.needed
    expect([1, 2, 3, 4, 5, 8, 10].map(n => needed(n, 0.65))).toEqual([1, 2, 2, 3, 4, 6, 7])
    expect(needed(20, 0.65)).toBe(13)
    // floating-point products just above a whole number must not demand an extra person
    expect(0.14 * 50).toBeGreaterThan(7)
    expect(needed(50, 0.14)).toBe(7)
    expect(needed(50, 0.28)).toBe(14)
    expect(needed(25, 0.56)).toBe(14)
    expect(needed(100, 0.65)).toBe(65)
    expect(needed(3, 0.01)).toBe(1)
  })

  it('records when a side got there: the time of the completion that reached the target', () => {
    const { users, ids } = crew({ empire: 4 }) // needs 3 at 65%
    const s = teamStandings(users, approved([[ids.empire[0], 40], [ids.empire[1], 10], [ids.empire[2], 30], [ids.empire[3], 20]]), {})
    expect(s.empire.times).toEqual([10, 20, 30, 40])
    expect(s.empire.crossedAt).toBe(30)
  })

  it('has not crossed while short of the target', () => {
    const { users, ids } = crew({ empire: 4 })
    expect(teamStandings(users, approved(times(ids.empire.slice(0, 2))), {}).empire.crossedAt).toBeNull()
  })

  it('ignores completions after the cutoff', () => {
    const { users, ids } = crew({ empire: 2 })
    const s = teamStandings(users, approved([[ids.empire[0], 10], [ids.empire[1], 500]]), {}, 0.65, 100)
    expect(s.empire.done).toBe(1)
    expect(s.empire.crossedAt).toBeNull()
  })

  it('counts a board mission towards the Free Traders', () => {
    const users = { b: { narrativeRole: 'information_broker' }, d: { narrativeRole: 'arms_dealer' } }
    const s = teamStandings(users, {}, { b: { bestCorrect: 4, bestTotal: 5, updatedAt: 5, history: [{ correct: 4, total: 5, at: 5 }] } })
    expect([s.independent.members, s.independent.done]).toEqual([2, 1])
  })

  it('agrees with the plain count of completed missions', () => {
    const { users, ids } = crew({ empire: 3, rebellion: 3 })
    const claims = approved(times([ids.empire[0], ids.rebellion[1]]))
    expect(completedMissionCount(users, claims, {})).toBe(2)
  })
})

describe('teamOutcome', () => {
  const NOW = 10_000
  const outcome = (users, claims, settings = {}, now = NOW, scores = {}) => teamOutcome({ users, claims, scores, settings, now })

  it('is open while nobody has reached the threshold and no end has come', () => {
    const { users, ids } = crew({ empire: 4, rebellion: 4, independent: 2 })
    const o = outcome(users, approved(times(ids.empire.slice(0, 2))))
    expect(o).toMatchObject({ phase: 'open', winner: null, gameOver: false, ended: false, threshold: 0.65 })
  })

  it('goes to the Admiralty as soon as it completes 65% of its goals', () => {
    const { users, ids } = crew({ empire: 4, rebellion: 4, independent: 2 })
    const o = outcome(users, approved(times(ids.empire.slice(0, 3))))
    expect(o).toMatchObject({ phase: 'won', winner: 'empire', reason: 'threshold', gameOver: true })
    expect(o.decidedAt).toBe(102)
  })

  it('goes to the League when it gets there', () => {
    const { users, ids } = crew({ empire: 4, rebellion: 4 })
    expect(outcome(users, approved(times(ids.rebellion.slice(0, 3)))).winner).toBe('rebellion')
  })

  it('needs exactly the right number: 13 of 20 wins, 12 does not', () => {
    const { users, ids } = crew({ empire: 20 })
    expect(outcome(users, approved(times(ids.empire.slice(0, 12)))).phase).toBe('open')
    expect(outcome(users, approved(times(ids.empire.slice(0, 13)))).winner).toBe('empire')
  })

  it('goes to whichever side got there first when both have', () => {
    const { users, ids } = crew({ empire: 2, rebellion: 2 })
    const claims = approved([[ids.empire[0], 10], [ids.empire[1], 50], [ids.rebellion[0], 20], [ids.rebellion[1], 30]])
    expect(outcome(users, claims).winner).toBe('rebellion') // League finished at 30, Admiralty at 50
    const swapped = approved([[ids.empire[0], 10], [ids.empire[1], 25], [ids.rebellion[0], 20], [ids.rebellion[1], 30]])
    expect(outcome(users, swapped).winner).toBe('empire')
  })

  it('does not let the Free Traders win by finishing their own goals', () => {
    const { users, ids } = crew({ empire: 3, rebellion: 3, independent: 3 })
    const o = outcome(users, approved(times(ids.independent)))
    expect(o.phase).toBe('open')
    expect(o.standings.independent.share).toBe(1)
  })

  it('gives the Free Traders the win when the game ends and neither side reached 65%', () => {
    const { users, ids } = crew({ empire: 4, rebellion: 4, independent: 2 })
    const claims = approved(times([...ids.empire.slice(0, 2), ...ids.rebellion.slice(0, 2)]))
    const o = outcome(users, claims, { endsAt: 5000 }, NOW)
    expect(o).toMatchObject({ phase: 'won', winner: 'independent', reason: 'time', gameOver: true, ended: true, decidedAt: 5000 })
  })

  it('stays open until the scheduled end', () => {
    const { users } = crew({ empire: 2, rebellion: 2, independent: 1 })
    expect(outcome(users, {}, { endsAt: NOW + 1 }).phase).toBe('open')
    expect(outcome(users, {}, { endsAt: NOW }).phase).toBe('won') // at the end time exactly it is over
  })

  it('can be ended by hand', () => {
    const { users } = crew({ empire: 2, rebellion: 2, independent: 1 })
    expect(outcome(users, {}, { endedAt: 9000 }).winner).toBe('independent')
    expect(outcome(users, {}, { endsAt: NOW + 99999, endedAt: 9000 }).winner).toBe('independent') // before the scheduled end
  })

  it('still goes to a side that reached the threshold before the end', () => {
    const { users, ids } = crew({ empire: 2, rebellion: 2, independent: 2 })
    const claims = approved([[ids.empire[0], 10], [ids.empire[1], 20]])
    expect(outcome(users, claims, { endsAt: 5000 })).toMatchObject({ winner: 'empire', reason: 'threshold', decidedAt: 20 })
  })

  it('ignores completions made after the game ended', () => {
    const { users, ids } = crew({ empire: 2, rebellion: 2, independent: 2 })
    const claims = approved([[ids.empire[0], 10], [ids.empire[1], 6000]]) // the second was submitted after the end at 5000
    const o = outcome(users, claims, { endsAt: 5000 })
    expect(o).toMatchObject({ winner: 'independent', reason: 'time' })
    expect(o.standings.empire.done).toBe(1)
  })

  it('counts a claim reviewed after the end if it was submitted before it', () => {
    const { users, ids } = crew({ empire: 1, independent: 1 })
    const claims = { c: { claimantId: ids.empire[0], status: 'approved', createdAt: 4000, reviewedAt: 9500 } }
    expect(outcome(users, claims, { endsAt: 5000 }).winner).toBe('empire')
  })

  it('has no winner if the game ends with no Free Traders in play and nobody at the threshold', () => {
    const { users } = crew({ empire: 2, rebellion: 2 })
    expect(outcome(users, {}, { endsAt: 5000 })).toMatchObject({ phase: 'ended', winner: null, reason: 'nobody', gameOver: true })
  })

  it('cannot be won by a side with nobody on it', () => {
    const { users, ids } = crew({ empire: 2 })
    const o = outcome(users, approved(times(ids.empire.slice(0, 1))))
    expect(o.standings.rebellion.crossedAt).toBeNull()
    expect(o.winner).toBeNull()
  })

  it('uses the threshold from the settings', () => {
    const { users, ids } = crew({ empire: 4 })
    const claims = approved(times(ids.empire.slice(0, 2)))
    expect(outcome(users, claims, {}).phase).toBe('open') // 2 of 4 is 50%
    expect(outcome(users, claims, { threshold: 0.5 }).winner).toBe('empire')
  })

  it('only the two contending sides can win by reaching the threshold', () => {
    expect(CONTENDERS).toEqual(['empire', 'rebellion'])
  })

  it('works on an empty game', () => {
    expect(outcome({}, {}, {}).phase).toBe('open')
    expect(outcome(undefined, undefined, undefined).phase).toBe('open')
  })
})

describe('victoryText', () => {
  const base = { threshold: 0.65 }
  it('says nothing while the game is open', () => {
    expect(victoryText({ ...base, phase: 'open' })).toBeNull()
    expect(victoryText(undefined)).toBeNull()
  })
  it('names a side that reached the threshold', () => {
    expect(victoryText({ ...base, phase: 'won', winner: 'empire', reason: 'threshold' })).toBe("🏆 The Admiralty have won! They completed at least 65% of their team's goals.")
    expect(victoryText({ ...base, phase: 'won', winner: 'rebellion', reason: 'threshold' })).toMatch(/The Gearwrights' League have won/)
  })
  it('explains a Free Traders win', () => {
    expect(victoryText({ ...base, phase: 'won', winner: 'independent', reason: 'time' })).toBe('🏆 The Free Traders win! Neither the Admiralty nor the League reached 65% in time.')
  })
  it('says so when nobody won', () => {
    expect(victoryText({ ...base, phase: 'ended', winner: null })).toBe('The game is over. Nobody reached 65% and no Free Traders were in play.')
  })
  it('uses the real threshold in the wording', () => {
    expect(victoryText({ threshold: 0.5, phase: 'won', winner: 'empire', reason: 'threshold' })).toMatch(/at least 50%/)
  })
})

describe('TeamStandings', () => {
  const o = (claimsFor, settings = {}) => {
    const { users, ids } = crew({ empire: 4, rebellion: 5, independent: 2 })
    return teamOutcome({ users, claims: approved(times(claimsFor(ids))), scores: {}, settings, now: 10_000 })
  }

  it("shows each contending side's percentage, the threshold, and the Free Traders' rule", () => {
    render(<TeamStandings outcome={o(ids => [...ids.empire.slice(0, 2), ...ids.rebellion.slice(0, 1)])} />)
    expect(screen.getByText(/each win by completing 65% of their team's goals\. The first to get there wins\./)).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument() // Admiralty 2 of 4
    expect(screen.getByText('20%')).toBeInTheDocument() // League 1 of 5
    expect(screen.getByText(/The Free Traders win if the game ends with neither side at 65%\./)).toBeInTheDocument()
  })

  it('draws a bar for each side', () => {
    render(<TeamStandings outcome={o(ids => ids.empire.slice(0, 1))} />)
    expect(screen.getByRole('progressbar', { name: 'The Admiralty progress' })).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByRole('progressbar', { name: "The Gearwrights' League progress" })).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getAllByRole('progressbar')).toHaveLength(2)
  })

  it('never shows the numbers behind the percentages, which would reveal how big each side is', () => {
    render(<TeamStandings outcome={o(ids => ids.empire.slice(0, 2))} />)
    expect(document.body.textContent).not.toMatch(/\d+ of \d+/)
    expect(document.body.textContent).not.toMatch(/needs \d/)
  })

  it('shows a dash for a side with nobody on it', () => {
    const { users } = crew({ empire: 2 })
    render(<TeamStandings outcome={teamOutcome({ users, claims: {}, scores: {}, settings: {}, now: 1 })} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('shows when the game ends, and says so once it has', () => {
    const { unmount } = render(<TeamStandings outcome={o(() => [], { endsAt: 20_000 })} />)
    expect(screen.getByText(/The game ends/)).toBeInTheDocument()
    unmount()
    render(<TeamStandings outcome={o(() => [], { endsAt: 5_000 })} />)
    expect(screen.getByText(/The game ended/)).toBeInTheDocument()
  })

  it('announces the result', () => {
    render(<TeamStandings outcome={o(ids => ids.empire.slice(0, 3))} />)
    expect(screen.getByRole('status')).toHaveTextContent('The Admiralty have won')
  })

  it('has no announcement while the game is open', () => {
    render(<TeamStandings outcome={o(() => [])} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('uses the configured threshold in the text and on the bars', () => {
    render(<TeamStandings outcome={o(() => [], { threshold: 0.8 })} />)
    expect(screen.getByText(/completing 80% of their team's goals/)).toBeInTheDocument()
    expect(screen.getAllByTitle('80% to win')).toHaveLength(2)
  })
})

describe('VictoryBanner', () => {
  it('is hidden while the game is open', () => {
    const { container } = render(<VictoryBanner outcome={{ phase: 'open', threshold: 0.65 }} />)
    expect(container).toBeEmptyDOMElement()
    expect(render(<VictoryBanner outcome={undefined} />).container).toBeEmptyDOMElement()
  })

  it('announces the winner on every page', () => {
    render(<VictoryBanner outcome={{ phase: 'won', winner: 'rebellion', reason: 'threshold', threshold: 0.65 }} />)
    expect(screen.getByRole('status', { name: 'Game result' })).toHaveTextContent("The Gearwrights' League have won")
  })

  it('announces a Free Traders win and a no-winner ending', () => {
    const { unmount } = render(<VictoryBanner outcome={{ phase: 'won', winner: 'independent', reason: 'time', threshold: 0.65 }} />)
    expect(screen.getByRole('status')).toHaveTextContent('The Free Traders win!')
    unmount()
    render(<VictoryBanner outcome={{ phase: 'ended', winner: null, threshold: 0.65 }} />)
    expect(screen.getByRole('status')).toHaveTextContent('The game is over')
  })
})

describe('once the game is over', () => {
  const users = { me: { name: 'Mia', narrativeRole: 'rebel_arms_buyer' }, d: { name: 'Dev', narrativeRole: 'arms_dealer' } }

  it('refuses a new claim and writes nothing', async () => {
    setDoc.mockClear()
    await expect(submitMissionClaim({ claimantId: 'me', roleKey: 'rebel_arms_buyer', picks: ['d'], photo: 'data:x', users, claims: {}, gameOver: true })).rejects.toThrow('The game is over, so no more claims can be sent.')
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('takes new claims while the game is on', async () => {
    await expect(submitMissionClaim({ claimantId: 'me', roleKey: 'rebel_arms_buyer', picks: ['d'], photo: 'data:x', users, claims: {}, gameOver: false })).resolves.toMatchObject({ status: 'pending' })
  })

  it('replaces the claim form with a message', () => {
    render(<MissionCard roleKey="rebel_arms_buyer" uid="me" users={users} claims={{}} scores={{}} onSubmit={vi.fn()} gameOver />)
    expect(screen.getByText('The game is over, so no more claims can be sent.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send claim/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/Attempts left/)).not.toBeInTheDocument()
  })

  it('still shows a claim that is waiting or approved', () => {
    const { unmount } = render(<MissionCard roleKey="rebel_arms_buyer" uid="me" users={users} claims={{ c: { claimantId: 'me', status: 'pending' } }} scores={{}} gameOver />)
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for the organiser')
    unmount()
    render(<MissionCard roleKey="rebel_arms_buyer" uid="me" users={users} claims={{ c: { claimantId: 'me', status: 'approved' } }} scores={{}} gameOver />)
    expect(screen.getByRole('status')).toHaveTextContent('Mission accomplished')
  })

  it('does not say "send a new one" after a rejection', () => {
    render(<MissionCard roleKey="rebel_arms_buyer" uid="me" users={users} claims={{ c: { claimantId: 'me', status: 'rejected', reviewedAt: 1 } }} scores={{}} gameOver />)
    expect(screen.queryByText(/You can send a new one/)).not.toBeInTheDocument()
  })
})

describe('in the dossier', () => {
  beforeEach(() => localStorage.clear())
  const open = async (over = {}) => {
    const { users, ids } = crew({ empire: 2, rebellion: 2, independent: 1 })
    users.me = { name: 'Mia', narrativeRole: 'rebel_arms_buyer' }
    const outcome = teamOutcome({ users, claims: approved(times(ids.empire)), scores: {}, settings: {}, now: 1 })
    const user = userEvent.setup()
    render(<NarrativeDossier ctx={{ authUser: { uid: 'me' }, profile: {}, users, missionClaims: {}, suspectScores: {}, teamOutcome: outcome, ...over }} />)
    await user.click(screen.getByRole('button', { name: /open your dossier/i }))
  }

  it('keeps the standings out of sight until the dossier is unlocked', async () => {
    const { users } = crew({ empire: 1 })
    render(<NarrativeDossier ctx={{ authUser: { uid: 'e0' }, profile: {}, users, missionClaims: {}, suspectScores: {}, teamOutcome: teamOutcome({ users, claims: {}, scores: {}, settings: {}, now: 1 }) }} />)
    expect(screen.queryByText(/Team Victory/)).not.toBeInTheDocument()
  })

  it('shows them after unlocking, and freezes claims when the team has won', async () => {
    await open()
    expect(screen.getByText(/Team Victory/)).toBeInTheDocument()
    expect(screen.getByText('The game is over, so no more claims can be sent.')).toBeInTheDocument() // the Admiralty already won
    expect(screen.queryByRole('button', { name: /send claim/i })).not.toBeInTheDocument()
  })

  it('works without a team outcome in the context', async () => {
    const { users } = crew({ empire: 1 })
    users.me = { name: 'Mia', narrativeRole: 'rebel_arms_buyer' }
    const user = userEvent.setup()
    render(<NarrativeDossier ctx={{ authUser: { uid: 'me' }, profile: {}, users, missionClaims: {}, suspectScores: {} }} />)
    await user.click(screen.getByRole('button', { name: /open your dossier/i }))
    expect(screen.queryByText(/Team Victory/)).not.toBeInTheDocument()
  })
})

describe('TeamVictoryManager', () => {
  const NOW = 50_000
  const setup = ({ claimsFor = () => [], settings = {}, save } = {}) => {
    const { users, ids } = crew({ empire: 4, rebellion: 5, independent: 2 })
    const claims = approved(times(claimsFor(ids)))
    const ctx = {
      users, missionClaims: claims, suspectScores: {}, teamSettings: settings,
      teamOutcome: teamOutcome({ users, claims, scores: {}, settings, now: NOW }),
      doSaveTeamSettings: save || vi.fn().mockResolvedValue(true),
    }
    render(<TeamVictoryManager ctx={ctx} />)
    return ctx
  }

  it('shows the real numbers for every side, and how many the contenders need', () => {
    setup({ claimsFor: ids => [...ids.empire.slice(0, 2), ids.rebellion[0], ids.independent[0]] })
    expect(screen.getByText('2 of 4 complete (50%) — needs 3')).toBeInTheDocument()
    expect(screen.getByText('1 of 5 complete (20%) — needs 4')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 complete (50%)')).toBeInTheDocument()
  })

  it('says the game is open with no end time, and what that means', () => {
    setup()
    expect(screen.getByText(/open, with no end time set\. It stays open until you end it\./)).toBeInTheDocument()
  })

  it('shows the end time when there is one', () => {
    setup({ settings: { endsAt: NOW + 3_600_000 } })
    expect(screen.getByText(/The game is open and ends/)).toBeInTheDocument()
  })

  it('shows the result once decided', () => {
    setup({ claimsFor: ids => ids.empire.slice(0, 3) })
    expect(screen.getByRole('status')).toHaveTextContent('The Admiralty have won')
  })

  it('starts the form from the saved settings', () => {
    setup({ settings: { threshold: 0.7, endsAt: new Date('2026-11-29T10:00').getTime() } })
    expect(screen.getByLabelText('Victory threshold (%)')).toHaveValue(70)
    expect(screen.getByLabelText('Game ends at')).toHaveValue('2026-11-29T10:00')
  })

  it('defaults to 65%', () => {
    setup()
    expect(screen.getByLabelText('Victory threshold (%)')).toHaveValue(65)
  })

  it('saves the threshold as a fraction and the end time as a timestamp', async () => {
    const user = userEvent.setup()
    const ctx = setup()
    const pct = screen.getByLabelText('Victory threshold (%)')
    await user.clear(pct); await user.type(pct, '70')
    fireEvent.change(screen.getByLabelText('Game ends at'), { target: { value: '2026-11-29T10:00' } })
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    expect(ctx.doSaveTeamSettings).toHaveBeenCalledWith({ threshold: 0.7, endsAt: new Date('2026-11-29T10:00').getTime() })
  })

  it('clears the end time when the field is emptied', async () => {
    const user = userEvent.setup()
    const ctx = setup({ settings: { endsAt: new Date('2026-11-29T10:00').getTime() } })
    fireEvent.change(screen.getByLabelText('Game ends at'), { target: { value: '' } })
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    expect(ctx.doSaveTeamSettings).toHaveBeenCalledWith({ threshold: 0.65, endsAt: null })
  })

  it('will not save a threshold outside 1 to 100', async () => {
    const user = userEvent.setup()
    const ctx = setup()
    const pct = screen.getByLabelText('Victory threshold (%)')
    for (const bad of ['0', '101', '']) {
      await user.clear(pct)
      if (bad) await user.type(pct, bad)
      expect(screen.getByRole('button', { name: /^save$/i }), bad).toBeDisabled()
      expect(screen.getByText('Enter a threshold between 1 and 100.')).toBeInTheDocument()
    }
    expect(ctx.doSaveTeamSettings).not.toHaveBeenCalled()
  })

  it('asks before ending the game, then ends it now', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123_456)
    const user = userEvent.setup()
    const ctx = setup()
    await user.click(screen.getByRole('button', { name: /end the game now/i }))
    expect(ctx.doSaveTeamSettings).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('End the game for everyone?')
    await user.click(screen.getByRole('button', { name: /yes, end it/i }))
    expect(ctx.doSaveTeamSettings).toHaveBeenCalledWith({ endedAt: 123_456 })
  })

  it('can back out of ending the game', async () => {
    const user = userEvent.setup()
    const ctx = setup()
    await user.click(screen.getByRole('button', { name: /end the game now/i }))
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(ctx.doSaveTeamSettings).not.toHaveBeenCalled()
  })

  it('offers to reopen once an end is set, and clears both', async () => {
    const user = userEvent.setup()
    const ctx = setup({ settings: { endedAt: NOW - 1000 } })
    expect(screen.getByRole('button', { name: /end the game now/i })).toBeDisabled() // already over
    await user.click(screen.getByRole('button', { name: /reopen the game/i }))
    expect(ctx.doSaveTeamSettings).toHaveBeenCalledWith({ endedAt: null, endsAt: null })
  })

  it('does not offer to reopen a game that has no end set', () => {
    setup()
    expect(screen.queryByRole('button', { name: /reopen the game/i })).not.toBeInTheDocument()
  })
})

// ── through the whole app ───────────────────────────────────────────────────
describe('App: team victory', () => {
  const me = { uid: 'me', email: 'mia@example.com', emailVerified: true, displayName: 'Mia' }
  const profileDoc = (over = {}) => ({ id: 'me', name: 'Mia', email: 'mia@example.com', onboarded: true, crewRank: 'Enlisted', loginHistory: [], ...over })
  const snapshot = (docs) => ({ forEach: (fn) => Object.entries(docs).forEach(([id, data]) => fn({ id, data: () => data })), docChanges: () => [] })
  const listenerFor = (name) => onSnapshot.mock.calls.find(([ref]) => ref.name === name)?.[1]
  const players = {
    me: profileDoc({ narrativeRole: 'rebel_arms_buyer' }),
    d: { id: 'd', name: 'Dev', narrativeRole: 'arms_dealer' },
    a: { id: 'a', name: 'Ann', narrativeRole: 'imperial_agent' },
  }
  async function openApp({ settings } = {}) {
    onAuthStateChanged.mockImplementation((_a, cb) => { cb(me); return () => {} })
    getDoc.mockResolvedValue({ exists: () => true, data: () => players.me })
    render(<App />)
    await waitFor(() => expect(listenerFor('settings')).toBeTypeOf('function'))
    await screen.findAllByTitle('Personal Log')
    act(() => {
      listenerFor('users')(snapshot(players))
      if (settings) listenerFor('settings')(snapshot({ teamVictory: settings }))
    })
  }

  it('shows no banner while the game is open', async () => {
    await openApp({ settings: { endsAt: Date.now() + 86_400_000 } })
    expect(screen.queryByRole('status', { name: 'Game result' })).not.toBeInTheDocument()
  })

  it('announces a Free Traders win to everyone once the end time has passed with nobody at 65%', async () => {
    await openApp({ settings: { endsAt: Date.now() - 1000 } })
    expect(await screen.findByRole('status', { name: 'Game result' })).toHaveTextContent('The Free Traders win!')
  })

  it('announces a side that reaches the threshold, the moment its claim is approved', async () => {
    await openApp()
    act(() => listenerFor('missionClaims')(snapshot({ c1: { id: 'c1', claimantId: 'a', roleKey: 'imperial_agent', status: 'approved', createdAt: 5 } })))
    expect(await screen.findByRole('status', { name: 'Game result' })).toHaveTextContent('The Admiralty have won')
  })

  it('lets the organiser change the settings from the Engine Room', async () => {
    await openApp()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /engine room/i }))
    await user.type(await screen.findByPlaceholderText(/access code/i), 'cottage con{Enter}')
    await user.click(await screen.findByRole('button', { name: /team victory/i }))
    const pct = await screen.findByLabelText('Victory threshold (%)')
    await user.clear(pct); await user.type(pct, '50')
    setDoc.mockClear()
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(setDoc).toHaveBeenCalled())
    const [ref, data, opts] = setDoc.mock.calls.at(-1)
    expect(ref).toEqual({ col: 'settings', id: 'teamVictory' })
    expect(data).toMatchObject({ threshold: 0.5, endsAt: null })
    expect(opts).toEqual({ merge: true })
    expect(await screen.findByText(/Team victory settings saved/)).toBeInTheDocument()
  })

  it('uses a threshold the organiser has saved', async () => {
    await openApp({ settings: { threshold: 1 } })
    act(() => listenerFor('missionClaims')(snapshot({ c1: { id: 'c1', claimantId: 'a', roleKey: 'imperial_agent', status: 'approved', createdAt: 5 } })))
    // the Admiralty has one member and finished: 100% meets a 100% threshold too
    expect(await screen.findByRole('status', { name: 'Game result' })).toHaveTextContent('at least 100%')
  })
})
