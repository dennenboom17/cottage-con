import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, it, expect } from 'vitest'
import { NARRATIVE_ROLES } from '../App.jsx'

// Tests run from the project root (`npm test`); import.meta.url is not a file: URL under Vitest's jsdom environment
const ROOT = `${process.cwd()}/`
const nodeRequire = createRequire(pathToFileURL(`${ROOT}package.json`))
const POSTERS = {
  admiralty: { faction: 'ADMIRALTY', slogan: ['A TIGHT SHIP', 'IS A SAFE SHIP'] },
  league: { faction: 'GEARWRIGHTS', slogan: ['HANDS THAT BUILD', 'THE WORLD'] },
  traders: { faction: 'FREE TRADERS', slogan: ['FREE TRADE FLIES', 'UNDER ANY FLAG'] },
}
const read = (name) => fs.readFileSync(`${ROOT}public/posters/${name}.svg`, 'utf8')
const parse = (name) => new DOMParser().parseFromString(read(name), 'image/svg+xml')
const textOf = (doc) => [...doc.querySelectorAll('text, title, desc')].map((e) => e.textContent).join(' ')

describe.each(Object.keys(POSTERS))('the %s poster', (name) => {
  it('is well-formed SVG at poster proportions (2:3)', () => {
    const doc = parse(name)
    expect(doc.querySelector('parsererror')).toBeNull()
    const svg = doc.documentElement
    expect(svg.tagName).toBe('svg')
    expect(svg.getAttribute('viewBox')).toBe('0 0 600 900')
  })

  it('has a title and a description for screen readers', () => {
    const doc = parse(name)
    expect(doc.querySelector('title')?.textContent.trim().length).toBeGreaterThan(5)
    expect(doc.querySelector('desc')?.textContent.trim().length).toBeGreaterThan(20)
    expect(doc.documentElement.getAttribute('role')).toBe('img')
  })

  it('carries its slogan and names its faction', () => {
    const text = textOf(parse(name)).toUpperCase()
    expect(text).toContain(POSTERS[name].faction)
    for (const line of POSTERS[name].slogan) expect(text).toContain(line)
  })

  it('says when and where it is for', () => {
    expect(textOf(parse(name)).toUpperCase()).toContain('COTTAGE CON')
  })

  it('is self-contained: it loads nothing from the network, so it prints and embeds anywhere', () => {
    const src = read(name).replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '')
    expect(src).not.toMatch(/https?:\/\//)
    expect(src).not.toMatch(/@import|<image|<script|xlink:href="(?!#)/)
  })

  it('has unique ids and every reference resolves', () => {
    const doc = parse(name)
    const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id)
    expect(new Set(ids).size, `duplicate ids: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`).toBe(ids.length)
    const refs = [...read(name).matchAll(/(?:href|url)\(?="?#([\w-]+)/g)].map((m) => m[1])
    const urlRefs = [...read(name).matchAll(/url\(#([\w-]+)\)/g)].map((m) => m[1])
    for (const r of [...refs, ...urlRefs]) expect(ids, `#${r}`).toContain(r)
  })

  it('gives nothing away: no role is named on a public poster, and no old space-opera wording', () => {
    const text = textOf(parse(name)).toLowerCase()
    for (const [key, role] of Object.entries(NARRATIVE_ROLES)) expect(text, `${key}: ${role.title}`).not.toContain(role.title.toLowerCase())
    expect(text).not.toMatch(/\b(empire|imperial|rebel|rebels|rebellion|emperor|galactic|space)\b/)
  })

  it('matches what the generator produces, so the file and the code do not drift apart', () => {
    const generated = nodeRequire(`./scripts/posters/${name}.cjs`)
    expect(read(name).replace(/\r\n/g, '\n')).toBe(generated.replace(/\r\n/g, '\n'))
  })
})

describe('the set', () => {
  it('is one poster per faction', () => {
    expect(Object.keys(POSTERS)).toHaveLength(3)
    for (const name of Object.keys(POSTERS)) expect(fs.existsSync(`${ROOT}public/posters/${name}.svg`), name).toBe(true)
  })

  it('looks different: each poster has its own palette', () => {
    const colours = (n) => new Set(read(n).match(/#[0-9a-fA-F]{6}\b/g).map((c) => c.toLowerCase()))
    const [a, l, t] = ['admiralty', 'league', 'traders'].map(colours)
    const shared = (x, y) => [...x].filter((c) => y.has(c)).length / Math.min(x.size, y.size)
    expect(shared(a, l)).toBeLessThan(0.6)
    expect(shared(a, t)).toBeLessThan(0.6)
    expect(shared(l, t)).toBeLessThan(0.6)
  })
})
