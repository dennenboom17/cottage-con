import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getDoc } from 'firebase/firestore'
import {
  Itinerary, ItineraryEditor, CrewAssistant, DEFAULT_COTTAGE_ADDRESS, cottageAddress, mapsSearchUrl, mapsEmbedUrl, resetBggMatcher,
} from '../App.jsx'

const NEW_ADDRESS = '12 Maple Lane, Orangeville, ON L9W 1A1'

describe('cottage address helpers', () => {
  it('falls back to the default when none is set', () => {
    expect(cottageAddress(undefined)).toBe(DEFAULT_COTTAGE_ADDRESS)
    expect(cottageAddress({})).toBe(DEFAULT_COTTAGE_ADDRESS)
    expect(cottageAddress({ checkIn: '3 PM' })).toBe(DEFAULT_COTTAGE_ADDRESS)
    expect(cottageAddress({ address: '   ' })).toBe(DEFAULT_COTTAGE_ADDRESS)
  })

  it('uses the address saved with the check-in details, trimmed', () => {
    expect(cottageAddress({ address: `  ${NEW_ADDRESS} ` })).toBe(NEW_ADDRESS)
  })

  it('builds Google Maps links that survive spaces, commas and ampersands', () => {
    const a = '1 Fish & Chips Rd, Alliston, ON'
    expect(mapsSearchUrl(a)).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`)
    expect(mapsEmbedUrl(a)).toBe(`https://maps.google.com/maps?q=${encodeURIComponent(a)}&output=embed&z=13`)
    expect(new URL(mapsSearchUrl(a)).searchParams.get('query')).toBe(a)
    expect(new URL(mapsEmbedUrl(a)).searchParams.get('q')).toBe(a)
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

  it('shows the saved address, and points the map link and embed at it', () => {
    render(<Itinerary ctx={{ ...base, itinMeta: { address: NEW_ADDRESS } }} />)
    expect(screen.getByText(NEW_ADDRESS)).toBeInTheDocument()
    expect(screen.queryByText(DEFAULT_COTTAGE_ADDRESS)).not.toBeInTheDocument()
    expect(mapLink()).toHaveAttribute('href', mapsSearchUrl(NEW_ADDRESS))
    expect(mapFrame()).toHaveAttribute('src', mapsEmbedUrl(NEW_ADDRESS))
  })

  it('ignores an address left on an itinerary day by the earlier per-day version', () => {
    const itinerary = { Nov_26: { id: 'Nov_26', short: 'Nov 26', address: '9 Old Rd, Nowhere, ON' } }
    render(<Itinerary ctx={{ ...base, itinerary, itinMeta: { address: NEW_ADDRESS } }} />)
    expect(mapLink()).toHaveAttribute('href', mapsSearchUrl(NEW_ADDRESS))
    expect(screen.queryByText('9 Old Rd, Nowhere, ON')).not.toBeInTheDocument()
  })
})

describe('Engine Room: address with the check-in details', () => {
  const mk = (over = {}) => ({
    itinerary: {}, itinMeta: {}, doSaveItinDay: vi.fn(async () => {}), doDelItinDay: vi.fn(), doSaveItinMeta: vi.fn(async () => {}), showToast: vi.fn(), ...over,
  })
  const field = () => screen.getByPlaceholderText(DEFAULT_COTTAGE_ADDRESS)

  it('shows the current address, defaulting to the usual one', () => {
    render(<ItineraryEditor ctx={mk()} />)
    expect(field()).toHaveValue(DEFAULT_COTTAGE_ADDRESS)
    expect(screen.getByText('Cottage address')).toBeInTheDocument()
  })

  it('shows the saved address', () => {
    render(<ItineraryEditor ctx={mk({ itinMeta: { address: NEW_ADDRESS } })} />)
    expect(field()).toHaveValue(NEW_ADDRESS)
  })

  it('saves the address together with the check-in details', async () => {
    const ctx = mk({ itinMeta: { checkIn: '4 PM', checkInDay: 'Thursday', checkOut: '10 AM', checkOutDay: 'Sunday', parkingNote: 'Barn' } })
    const user = userEvent.setup()
    render(<ItineraryEditor ctx={ctx} />)
    await user.clear(field())
    await user.type(field(), NEW_ADDRESS)
    await user.click(screen.getByRole('button', { name: /Save/ }))
    expect(ctx.doSaveItinMeta).toHaveBeenCalledTimes(1)
    expect(ctx.doSaveItinMeta.mock.calls[0][0]).toMatchObject({ address: NEW_ADDRESS, checkIn: '4 PM', checkOut: '10 AM', parkingNote: 'Barn' })
  })

  it('offers no address field on the individual days', async () => {
    const user = userEvent.setup()
    render(<ItineraryEditor ctx={mk()} />)
    expect(screen.getAllByText('Cottage address')).toHaveLength(1)
    await user.click(document.querySelector('button i.ti-pencil').closest('button'))
    expect(screen.getAllByText('Cottage address')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: /Add Day/ }))
    expect(screen.getAllByText('Cottage address')).toHaveLength(1)
  })

  it('does not put an address on the day records it saves', async () => {
    const ctx = mk()
    const user = userEvent.setup()
    render(<ItineraryEditor ctx={ctx} />)
    await user.click(document.querySelector('button i.ti-pencil').closest('button'))
    await user.click(screen.getByRole('button', { name: /Save Changes/ }))
    expect(ctx.doSaveItinDay.mock.calls[0][0]).not.toHaveProperty('address')
  })
})

describe('the crew assistant and the cottage address', () => {
  const reply = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => text })
  const requestText = (f) => JSON.parse(f.mock.calls.at(-1)[1].body).contents.at(-1).parts[0].text
  const systemText = (f) => JSON.parse(f.mock.calls[0][1].body).system_instruction.parts[0].text
  const section = (text, name) => text.split(/\n(?==== )/).find((p) => p.startsWith(`=== ${name}`)) || ''
  const mkCtx = (over = {}) => ({
    profile: { name: 'Ann Lee' }, authUser: { uid: 'me' }, users: { me: { id: 'me', name: 'Ann Lee' } },
    games: {}, food: {}, supplies: {}, voyageMenu: {}, deckHands: {}, receipts: {}, itinerary: {}, itinMeta: {}, ...over,
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

  it('copes with a context that has no itinMeta at all', async () => {
    const ctx = mkCtx()
    delete ctx.itinMeta
    await ask(ctx)
    expect(section(requestText(f), 'COTTAGE ADDRESS')).toContain(DEFAULT_COTTAGE_ADDRESS)
  })

  it('hands the model the saved address, not the default', async () => {
    await ask(mkCtx({ itinMeta: { address: NEW_ADDRESS } }))
    const sec = section(requestText(f), 'COTTAGE ADDRESS')
    expect(sec).toContain(`Yellow Cottage: ${NEW_ADDRESS}`)
    expect(sec).toContain(mapsSearchUrl(NEW_ADDRESS))
    expect(sec).not.toContain(DEFAULT_COTTAGE_ADDRESS)
  })

  it('tells the model to answer address questions only from that section', async () => {
    await ask(mkCtx())
    const sys = systemText(f)
    expect(sys).toContain('COTTAGE ADDRESS section')
    expect(sys).toMatch(/never guess, shorten or alter an address/)
  })

  it('explains how an organiser sets the address', async () => {
    await ask(mkCtx(), 'How do I change the cottage address?')
    expect(requestText(f)).toMatch(/SET THE COTTAGE ADDRESS[^\n]*Check-in \/ Check-out section/)
  })
})
