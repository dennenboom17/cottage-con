import { describe, it, expect, vi } from 'vitest'
import {
  getInitials, avColor, uid, sumAmount, cleanGameName, detectCategory, gameBadge, getDeviceInfo,
} from '../App.jsx'

describe('getInitials', () => {
  it('takes the first letter of up to two words, uppercased', () => {
    expect(getInitials('ada lovelace')).toBe('AL')
  })
  it('caps at two letters for longer names', () => {
    expect(getInitials('Mary Jane Watson')).toBe('MJ')
  })
  it('handles a single name', () => {
    expect(getInitials('Cher')).toBe('C')
  })
  it('falls back to "?" for empty input', () => {
    expect(getInitials('')).toBe('?')
    expect(getInitials()).toBe('?')
  })
})

describe('avColor', () => {
  it('is deterministic for the same name', () => {
    expect(avColor('Ada')).toBe(avColor('Ada'))
  })
  it('always returns a hex colour', () => {
    for (const n of ['A', 'zed', '🏴‍☠️ Pirate', '']) expect(avColor(n)).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })
})

describe('uid', () => {
  it('returns a non-empty string', () => {
    expect(uid()).toMatch(/^[0-9a-z]+$/)
  })
  it('does not collide across a burst of calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => uid()))
    expect(ids.size).toBe(500)
  })
})

describe('sumAmount', () => {
  it('sums numeric strings and numbers', () => {
    expect(sumAmount([{ amount: '10.50' }, { amount: 4 }, { amount: '0.25' }])).toBeCloseTo(14.75)
  })
  it('treats missing, empty and non-numeric amounts as zero', () => {
    expect(sumAmount([{}, { amount: '' }, { amount: 'abc' }, { amount: null }, { amount: '5' }])).toBe(5)
  })
  it('returns 0 for an empty list', () => {
    expect(sumAmount([])).toBe(0)
  })
})

describe('cleanGameName', () => {
  it.each([
    ['Catan', 'Catan'],
    ['Wingspan 1-5 players', 'Wingspan'],
    ['Wingspan 1–5', 'Wingspan'],
    ['Ticket to Ride | 2-5 players', 'Ticket to Ride'],
    ['Azul (2-4 players)', 'Azul'],
    ['Splendor for 2 to 4 players', 'Splendor'],
    ['Pandemic 2 to 4 players', 'Pandemic'],
    ['Codenames players: 4+', 'Codenames'],
    ['Carcassonne, ', 'Carcassonne'],
  ])('cleans %j → %j', (raw, expected) => {
    expect(cleanGameName(raw)).toBe(expected)
  })
  it('does not mangle numbers that are part of the title', () => {
    expect(cleanGameName('7 Wonders')).toBe('7 Wonders')
    expect(cleanGameName('Catan')).not.toMatch(/\d/)
  })
  it('is safe on empty input', () => {
    expect(cleanGameName()).toBe('')
    expect(cleanGameName('')).toBe('')
  })
})

describe('detectCategory', () => {
  it('flags two-player-only games', () => {
    expect(detectCategory('2.0', '2', '2')).toBe('2 Player')
    expect(detectCategory('3.9', 1, 2)).toBe('2 Player')
  })
  it('flags large-group games as Party regardless of weight', () => {
    expect(detectCategory('4.5', '3', '8')).toBe('Party')
  })
  it('maps weight bands to Light / Medium / Heavy', () => {
    expect(detectCategory('1.5', '2', '4')).toBe('Light')
    expect(detectCategory('2.19', '2', '4')).toBe('Light')
    expect(detectCategory('2.2', '2', '4')).toBe('Medium')
    expect(detectCategory('3.49', '2', '4')).toBe('Medium')
    expect(detectCategory('3.5', '2', '4')).toBe('Heavy')
  })
  it('returns "" when there is nothing to go on', () => {
    expect(detectCategory('', '', '')).toBe('')
    expect(detectCategory('abc', undefined, undefined)).toBe('')
  })
})

describe('gameBadge', () => {
  it('uses up to 3 letters of a single-word name', () => {
    expect(gameBadge('Wingspan').initials).toBe('WIN')
  })
  it('uses the first letter of up to 3 words', () => {
    expect(gameBadge('Ticket to Ride Europe').initials).toBe('TTR')
  })
  it('is deterministic and returns a full colour set', () => {
    const a = gameBadge('Azul'), b = gameBadge('Azul')
    expect(a).toEqual(b)
    expect(a).toMatchObject({ bg: expect.any(String), text: expect.any(String), border: expect.any(String) })
  })
  it('does not throw on an empty name', () => {
    expect(() => gameBadge('')).not.toThrow()
    expect(() => gameBadge()).not.toThrow()
  })
})

describe('getDeviceInfo', () => {
  const withUA = (ua) => vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua)

  it('detects an iPhone Safari', () => {
    withUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')
    expect(getDeviceInfo()).toEqual({ os: 'iOS', browser: 'Safari', deviceType: 'Mobile' })
  })
  it('detects desktop Edge on Windows (and not Chrome)', () => {
    withUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0')
    expect(getDeviceInfo()).toEqual({ os: 'Windows', browser: 'Edge', deviceType: 'Desktop' })
  })
  it('distinguishes an Android tablet from an Android phone', () => {
    withUA('Mozilla/5.0 (Linux; Android 13; Pixel Tablet) AppleWebKit/537.36 Chrome/120.0 Safari/537.36')
    expect(getDeviceInfo().deviceType).toBe('Tablet')
    withUA('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36')
    expect(getDeviceInfo().deviceType).toBe('Mobile')
  })
})
