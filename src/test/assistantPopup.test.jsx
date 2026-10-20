import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { CrewAssistant, ASSISTANT_POPUP_KEY, ASSISTANT_POPUP_DELAY, assistantPopupDone, markAssistantPopupDone } from '../App.jsx'

const ctx = () => ({
  profile: { name: 'Mia' }, authUser: { uid: 'me' }, users: { me: { id: 'me', name: 'Mia' } },
  games: {}, food: {}, supplies: {}, voyageMenu: {}, deckHands: {}, receipts: {}, itinerary: {}, itinMeta: {},
})
const isOpen = () => !!screen.queryByPlaceholderText(/Ask anything/)
const toggle = () => fireEvent.click(screen.getByLabelText('Open crew assistant'))
const wait = (ms) => act(() => { vi.advanceTimersByTime(ms) })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the assistant pops up once per session', () => {
  it('opens by itself after the delay', () => {
    render(<CrewAssistant ctx={ctx()} />)
    expect(isOpen()).toBe(false)
    wait(ASSISTANT_POPUP_DELAY - 1)
    expect(isOpen()).toBe(false)
    wait(1)
    expect(isOpen()).toBe(true)
    expect(ASSISTANT_POPUP_DELAY).toBe(30000)
  })

  it('stays closed once dismissed, however long the user keeps going', () => {
    render(<CrewAssistant ctx={ctx()} />)
    wait(ASSISTANT_POPUP_DELAY)
    expect(isOpen()).toBe(true)
    toggle() // dismiss
    expect(isOpen()).toBe(false)
    wait(60 * 60 * 1000)
    expect(isOpen()).toBe(false)
  })

  it('does not come back after a sign-out and sign-in within the same session', () => {
    const { unmount } = render(<CrewAssistant ctx={ctx()} />)
    wait(ASSISTANT_POPUP_DELAY)
    toggle()
    unmount() // the shell is torn down on sign-out
    render(<CrewAssistant ctx={ctx()} />)
    wait(5 * ASSISTANT_POPUP_DELAY)
    expect(isOpen()).toBe(false)
  })

  it('does not come back after a reload in the same tab', () => {
    const { unmount } = render(<CrewAssistant ctx={ctx()} />)
    wait(ASSISTANT_POPUP_DELAY)
    unmount()
    expect(sessionStorage.getItem(ASSISTANT_POPUP_KEY)).toBe('1')
    render(<CrewAssistant ctx={ctx()} />)
    wait(5 * ASSISTANT_POPUP_DELAY)
    expect(isOpen()).toBe(false)
  })

  it('does not pop up at all if it was already shown earlier in the session', () => {
    markAssistantPopupDone()
    render(<CrewAssistant ctx={ctx()} />)
    wait(5 * ASSISTANT_POPUP_DELAY)
    expect(isOpen()).toBe(false)
  })

  it('pops up again in a new session', () => {
    const first = render(<CrewAssistant ctx={ctx()} />)
    wait(ASSISTANT_POPUP_DELAY)
    first.unmount()
    sessionStorage.clear() // a new tab, or the browser was closed
    render(<CrewAssistant ctx={ctx()} />)
    wait(ASSISTANT_POPUP_DELAY)
    expect(isOpen()).toBe(true)
  })

  it('does not pop up after the user opened and closed it themselves first', () => {
    render(<CrewAssistant ctx={ctx()} />)
    wait(10_000)
    toggle() // opened by hand
    expect(isOpen()).toBe(true)
    toggle() // and closed again
    expect(isOpen()).toBe(false)
    wait(ASSISTANT_POPUP_DELAY)
    expect(isOpen()).toBe(false)
  })

  it('leaves it alone if the user opened it themselves and kept it open', () => {
    render(<CrewAssistant ctx={ctx()} />)
    wait(10_000)
    toggle()
    wait(ASSISTANT_POPUP_DELAY)
    expect(isOpen()).toBe(true) // the timer never closes or toggles it
  })

  it('does not run a timer at all when it has already had its turn', () => {
    markAssistantPopupDone()
    const spy = vi.spyOn(globalThis, 'setTimeout')
    render(<CrewAssistant ctx={ctx()} />)
    expect(spy.mock.calls.some(([, ms]) => ms === ASSISTANT_POPUP_DELAY)).toBe(false)
    spy.mockRestore()
  })

  it('cancels the pending popup if the assistant goes away first', () => {
    const { unmount } = render(<CrewAssistant ctx={ctx()} />)
    unmount()
    wait(2 * ASSISTANT_POPUP_DELAY)
    expect(sessionStorage.getItem(ASSISTANT_POPUP_KEY)).toBeNull()
  })

  it('records that it popped up', () => {
    expect(assistantPopupDone()).toBe(false)
    render(<CrewAssistant ctx={ctx()} />)
    wait(ASSISTANT_POPUP_DELAY)
    expect(assistantPopupDone()).toBe(true)
  })

  // Keep this last: it leaves the page-lifetime fallback flag set
  it('still pops up only once when the browser blocks sessionStorage', () => {
    const block = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      const { unmount } = render(<CrewAssistant ctx={ctx()} />)
      wait(ASSISTANT_POPUP_DELAY)
      expect(isOpen()).toBe(true)
      toggle()
      unmount()
      render(<CrewAssistant ctx={ctx()} />)
      wait(5 * ASSISTANT_POPUP_DELAY)
      expect(isOpen()).toBe(false)
    } finally { block.mockRestore(); set.mockRestore() }
  })
})
