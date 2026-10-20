import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDoc } from 'firebase/firestore'
import {
  Itinerary, ItineraryEditor, CrewAssistant, DEFAULT_COTTAGE_ADDRESS, cottageAddress, mapsSearchUrl, mapsEmbedUrl,
  mergeItineraryDays, resetBggMatcher,
} from '../App.jsx'

const NEW_ADDRESS = '12 Maple Lane, Orangeville, ON L9W 1A1'

describe('cottage address helpers', () => {
  it('falls back to the default when no day has an address', () => {
    expect(cottageAddress([])).toBe(DEFAULT_COTTAGE_ADDRESS)
    expect(cottageAddress(undefined)).toBe(DEFAULT_COTTAGE_ADDRESS)
    expect(cottageAddress([{ short: 'Nov 26' }, { short: 'Nov 27', address: '   ' }])).toBe(DEFAULT_COTTAGE_ADDRESS)
  })

  it('uses the first day, in order, that has an address, trimmed', () => {
    expect(cottageAddress([{ address: '' }, { address: `  ${NEW_ADDRESS} ` }, { address: 'Somewhere else' }])).toBe(NEW_ADDRESS)
  })

  it('builds Google Maps links that survive spaces, commas and ampersands', () => {
    const a = '1 Fish & Chips Rd, Alliston, ON'
    expect(mapsSearchUrl(a)).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`)
    expect(mapsEmbedUrl(a)).toBe(`https://maps.google.com/maps?q=${encodeURIComponent(a)}&output=embed&z=13`)
    expect(new URL(mapsSearchUrl(a)).searchParams.get('query')).toBe(a)
    expect(new URL(mapsEmbedUrl(a)).searchParams.get('q')).toBe(a)
  })

  it('keeps an address when merging saved days onto the base days', () => {
    const days = mergeItineraryDays({ Nov_26: { id: 'Nov_26', short: 'Nov 26', address: NEW_ADDRESS } })
    expect(days).toHaveLength(4)
    expect(days[0].address).toBe(NEW_ADDRESS)
    expect(cottageAddress(days)).toBe(NEW_ADDRESS)
  })
})

describe('Itinerary address and map', () => {
  const base = { itinerary: {}, itinMeta: {} }
  const mapLink = () => screen.getByRole('link', { name: /Open in Maps/ })
  const mapFrame = () => screen.getByTitle('Cottage Location')

  it('shows the default address and map until one is set', () => {
    render(<Itinerary ctx={base} />)
    expect(screen.getByText(DEFAULT_COTTAGE_ADDRESS)).toBeInTheDocument()
    expect(mapLink()).toHaveAttribute('href', mapsSearchUrl(DEFAULT_COTTAGE_ADDRESS))
    expect(mapFrame()).toHaveAttribute('src', mapsEmbedUrl(DEFAULT_COTTAGE_ADDRESS))
  })

  it('shows the address stored on a day, and points the map link and embed at it', () => {
    render(<Itinerary ctx={{ ...base, itinerary: { Nov_26: { id: 'Nov_26', short: 'Nov 26', address: NEW_ADDRESS } } }} />)
    expect(screen.getByText(NEW_ADDRESS)).toBeInTheDocument()
    expect(screen.queryByText(DEFAULT_COTTAGE_ADDRESS)).not.toBeInTheDocument()
    expect(mapLink()).toHaveAttribute('href', mapsSearchUrl(NEW_ADDRESS))
    expect(mapFrame()).toHaveAttribute('src', mapsEmbedUrl(NEW_ADDRESS))
  })

  it('does not repeat the cottage address on the days that are at the cottage', () => {
    const itinerary = {
      Nov_26: { id: 'Nov_26', short: 'Nov 26', address: NEW_ADDRESS },
      Nov_27: { id: 'Nov_27', short: 'Nov 27', address: NEW_ADDRESS },
    }
    render(<Itinerary ctx={{ ...base, itinerary }} />)
    expect(screen.getAllByText(NEW_ADDRESS)).toHaveLength(1)
  })

  it('lets the earliest day with an address win, and shows a different address on its own day', () => {
    const outing = '5 Brewery Row, Collingwood, ON'
    const itinerary = {
      Nov_27: { id: 'Nov_27', short: 'Nov 27', address: outing },
      Nov_26: { id: 'Nov_26', short: 'Nov 26', address: NEW_ADDRESS },
    }
    render(<Itinerary ctx={{ ...base, itinerary }} />)
    expect(mapLink()).toHaveAttribute('href', mapsSearchUrl(NEW_ADDRESS))
    const day = screen.getByRole('link', { name: outing })
    expect(day).toHaveAttribute('href', mapsSearchUrl(outing))
  })
})

describe('Engine Room itinerary editor', () => {
  const mk = (over = {}) => ({
    itinerary: {}, itinMeta: {}, doSaveItinDay: vi.fn(async () => {}), doDelItinDay: vi.fn(), doSaveItinMeta: vi.fn(), showToast: vi.fn(), ...over,
  })
  const field = () => screen.getByPlaceholderText(DEFAULT_COTTAGE_ADDRESS)
  const editFirstDay = async (user) => {
    const pencils = document.querySelectorAll('button i.ti-pencil')
    await user.click(pencils[0].closest('button'))
  }

  it('saves the address entered for a day, trimmed', async () => {
    const ctx = mk()
    const user = userEvent.setup()
    render(<ItineraryEditor ctx={ctx} />)
    await editFirstDay(user)
    await user.type(field(), `  ${NEW_ADDRESS}  `)
    await user.click(screen.getByRole('button', { name: /Save Changes/ }))
    expect(ctx.doSaveItinDay).toHaveBeenCalledTimes(1)
    expect(ctx.doSaveItinDay.mock.calls[0][0]).toMatchObject({ id: 'Nov_26', address: NEW_ADDRESS })
  })

  it('opens a day with its saved address filled in, and keeps it on save', async () => {
    const ctx = mk({ itinerary: { Nov_26: { id: 'Nov_26', short: 'Nov 26', date: 'Thursday, Nov 26', label: 'Arrival Day', address: NEW_ADDRESS } } })
    const user = userEvent.setup()
    render(<ItineraryEditor ctx={ctx} />)
    await editFirstDay(user)
    expect(field()).toHaveValue(NEW_ADDRESS)
    await user.click(screen.getByRole('button', { name: /Save Changes/ }))
    expect(ctx.doSaveItinDay.mock.calls[0][0].address).toBe(NEW_ADDRESS)
  })

  it('saves an empty address when the field is cleared, so the default comes back', async () => {
    const ctx = mk({ itinerary: { Nov_26: { id: 'Nov_26', short: 'Nov 26', date: 'Thursday, Nov 26', label: 'Arrival Day', address: NEW_ADDRESS } } })
    const user = userEvent.setup()
    render(<ItineraryEditor ctx={ctx} />)
    await editFirstDay(user)
    await user.clear(field())
    await user.click(screen.getByRole('button', { name: /Save Changes/ }))
    expect(ctx.doSaveItinDay.mock.calls[0][0].address).toBe('')
    expect(cottageAddress([ctx.doSaveItinDay.mock.calls[0][0]])).toBe(DEFAULT_COTTAGE_ADDRESS)
  })

  it('includes the address on a new day', async () => {
    const ctx = mk()
    const user = userEvent.setup()
    render(<ItineraryEditor ctx={ctx} />)
    await user.click(screen.getByRole('button', { name: /Add Day/ }))
    await user.type(screen.getByPlaceholderText('e.g. Thursday, Nov 26'), 'Monday, Nov 30')
    await user.type(screen.getByPlaceholderText('e.g. Nov 26'), 'Nov 30')
    await user.type(field(), NEW_ADDRESS)
    await user.click(screen.getAllByRole('button', { name: /^Add Day$/ }).at(-1))
    expect(ctx.doSaveItinDay.mock.calls[0][0]).toMatchObject({ short: 'Nov 30', address: NEW_ADDRESS })
  })
})

describe('the crew assistant and the cottage address', () => {
  const reply = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => text })
  const requestText = (f) => JSON.parse(f.mock.calls.at(-1)[1].body).contents.at(-1).parts[0].text
  const systemText = (f) => JSON.parse(f.mock.calls[0][1].body).system_instruction.parts[0].text
  const section = (text, name) => text.split(/\n(?==== )/).find((p) => p.startsWith(`=== ${name}`)) || ''
  const mkCtx = (itinerary = {}) => ({
    profile: { name: 'Ann Lee' }, authUser: { uid: 'me' }, users: { me: { id: 'me', name: 'Ann Lee' } },
    games: {}, food: {}, supplies: {}, voyageMenu: {}, deckHands: {}, receipts: {}, itinerary,
  })
  const ask = async (ctx, q = 'Where is the cottage?') => {
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

  it('hands the model the default address and a Maps link when none is set', async () => {
    await ask(mkCtx())
    const sec = section(requestText(f), 'COTTAGE ADDRESS')
    expect(sec).toContain(`Yellow Cottage: ${DEFAULT_COTTAGE_ADDRESS}`)
    expect(sec).toContain(`Google Maps: ${mapsSearchUrl(DEFAULT_COTTAGE_ADDRESS)}`)
  })

  it('hands the model the address stored on the itinerary, not the default', async () => {
    await ask(mkCtx({ Nov_26: { id: 'Nov_26', short: 'Nov 26', date: 'Thursday, Nov 26', label: 'Arrival', address: NEW_ADDRESS } }))
    const req = requestText(f)
    const sec = section(req, 'COTTAGE ADDRESS')
    expect(sec).toContain(`Yellow Cottage: ${NEW_ADDRESS}`)
    expect(sec).toContain(mapsSearchUrl(NEW_ADDRESS))
    expect(sec).not.toContain(DEFAULT_COTTAGE_ADDRESS)
    // and the day's own line carries it too
    expect(section(req, 'ITINERARY')).toContain(`Address: ${NEW_ADDRESS}`)
  })

  it('tells the model to answer address questions only from that section', async () => {
    await ask(mkCtx())
    const sys = systemText(f)
    expect(sys).toContain('COTTAGE ADDRESS section')
    expect(sys).toMatch(/never guess, shorten or alter an address/)
  })

  it('explains how an organiser sets the address', async () => {
    await ask(mkCtx(), 'How do I change the cottage address?')
    expect(requestText(f)).toMatch(/SET THE COTTAGE ADDRESS[^\n]*Engine Room -> Itinerary Days/)
  })
})
