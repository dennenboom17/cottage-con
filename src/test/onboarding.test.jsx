import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OnboardingModal, NARRATIVE_ROLES, NARRATIVE_FACTIONS } from '../App.jsx'

const FLAVOUR = /Field Intelligence/

// jsdom has no matchMedia; the install card asks whether the app is already running standalone
beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false }))
})

const renderTour = (over = {}) => {
  const doUpdateProfile = vi.fn().mockResolvedValue()
  const ctx = { profile: { id: 'u1', name: 'Ann Lee', onboarded: false, ...over }, doUpdateProfile }
  const utils = render(<OnboardingModal ctx={ctx} />)
  return { doUpdateProfile, ...utils }
}

// Renders the tour and walks it with the Next button, returning each card's heading and the text on it.
async function walk() {
  renderTour()
  const user = userEvent.setup()
  const cards = []
  for (let i = 0; i < 40; i++) {
    cards.push({
      title: screen.getByRole('heading', { level: 2 }).textContent,
      text: document.body.textContent,
      hasFlavour: !!screen.queryByText(FLAVOUR),
    })
    const next = screen.queryByRole('button', { name: /next/i })
    if (!next) break
    await user.click(next)
  }
  return cards
}

describe('welcome tour', () => {
  it('greets the player by first name and sets up the secret war on the first card', () => {
    renderTour()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Welcome aboard, Ann!')
    expect(screen.getByText(FLAVOUR)).toBeInTheDocument()
    expect(screen.getByText(/secret war is being fought aboard/i)).toBeInTheDocument()
  })

  it('does not appear for someone who has already been through it', () => {
    renderTour({ onboarded: true })
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
  })

  it('gives every feature card an in-world note, and leaves the install instructions plain', async () => {
    const cards = await walk()
    const install = cards.at(-1)
    expect(install.title).toMatch(/install|already installed/i)
    expect(install.hasFlavour).toBe(false)
    for (const c of cards.slice(0, -1)) expect(c.hasFlavour, c.title).toBe(true)
  })

  it('explains the dossier and the suspect board, after the Personal Log and before the install card', async () => {
    const titles = (await walk()).map(c => c.title)
    const at = (t) => titles.indexOf(t)
    expect(at('Personal Log')).toBeGreaterThan(-1)
    expect(at('Your Dossier')).toBe(at('Personal Log') + 1)
    expect(at('Crew Suspect Board')).toBe(at('Your Dossier') + 1)
    expect(at('Crew Suspect Board')).toBeLessThan(titles.length - 1)
  })

  it('tells players where the dossier lives and how the board and leaderboard work', async () => {
    const byTitle = Object.fromEntries((await walk()).map(c => [c.title, c.text]))
    expect(byTitle['Personal Log']).toMatch(/classified dossier is kept/)
    expect(byTitle['Your Dossier']).toMatch(/top of your Personal Log/)
    expect(byTitle['Your Dossier']).toMatch(/win condition/)
    expect(byTitle['Your Dossier']).toMatch(/photo as proof/)
    expect(byTitle['Crew Suspect Board']).toMatch(/Check my guesses/)
    expect(byTitle['Crew Suspect Board']).toMatch(/leaderboard/)
    expect(byTitle['Crew Suspect Board']).toMatch(/private on your device/)
  })

  it('never names a specific role, so the tour gives nothing away', async () => {
    const everything = (await walk()).map(c => c.text).join('\n')
    for (const [key, role] of Object.entries(NARRATIVE_ROLES)) {
      expect(everything, key).not.toContain(role.title)
      for (const tip of role.tips) expect(everything, `${key} tip`).not.toContain(tip)
    }
    for (const f of Object.values(NARRATIVE_FACTIONS)) expect(f.name.length).toBeGreaterThan(0) // factions may be named; roles may not
  })

  it('keeps the existing practical content of each card', async () => {
    const byTitle = Object.fromEntries((await walk()).map(c => [c.title, c.text]))
    expect(byTitle['Cargo Hold']).toMatch(/Vote for the ones you want to play/)
    expect(byTitle['Deck Hands']).toMatch(/Officer \(adult\), Enlisted \(kid\), or Stowaway/)
    expect(byTitle['Manifest']).toMatch(/splitting costs at the end is easy/)
  })

  it('records that the tour is done when the player skips it', async () => {
    const user = userEvent.setup()
    const { doUpdateProfile } = renderTour()
    await user.click(screen.getByRole('button', { name: /skip tour/i }))
    expect(doUpdateProfile).toHaveBeenCalledWith(expect.objectContaining({ onboarded: true }))
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
  })

  it('records that the tour is done when the player reaches the end', async () => {
    const user = userEvent.setup()
    const { doUpdateProfile } = renderTour()
    for (let i = 0; i < 40 && !screen.queryByRole('button', { name: /all hands ready/i }); i++) {
      await user.click(screen.getByRole('button', { name: /next/i }))
    }
    await user.click(screen.getByRole('button', { name: /all hands ready/i }))
    expect(doUpdateProfile).toHaveBeenCalledWith(expect.objectContaining({ onboarded: true }))
  })

  it('lets the card scroll on a short screen instead of clipping the extra text', () => {
    renderTour()
    const card = screen.getByRole('heading', { level: 2 }).closest('div[style*="overflow"]')
    expect(card.style.overflowY).toBe('auto')
    expect(card.style.maxHeight).toContain('100dvh')
  })
})
