import { describe, it, expect } from 'vitest'
import { parseLegend } from '../legend'
import { TILE, TERRAIN_NAMES } from '../terrain'
import { MapgenError } from '../errors'

/**
 * Ticket 033 — `legend.json` declares which colour is which terrain.
 *
 * WHY A DECLARATION AND NOT A HEURISTIC. Level 2's bridge is painted
 * `rgb(100,100,100)`, and the obvious fix — "neutral grey means bridge" — is a
 * rule about every level, including the ones nobody looked at. `classifyTile`'s
 * rock branch is the `r > g` fallback and already collects dirt, trunks and leaf
 * litter; a neutral cut placed to catch a bridge reclassifies real terrain on a
 * map whose author never asked for it.
 *
 * Measured on the real artwork at the legend's existing tolerance of 40
 * (`colourDistance` is max-channel, not euclidean): level 2 has 28 tiles within
 * tolerance of that grey and every one is on the deck; level 1 has none. The
 * nearest other terrain is jungle at distance 99 and the river at 100. So the
 * declaration is exact where it is made and inert everywhere else.
 */

const base = {
  tileSize: 16,
  colourTolerance: 40,
  markerColours: { '60,160,255': 'avatars', '255,60,60': 'enemies' },
  labels: [],
}

const parse = (overrides: Record<string, unknown> = {}) =>
  parseLegend({ ...base, ...overrides }, 'legend.json')

describe('terrainColours', () => {
  it('is absent by default, so level 1`s legend needs no change', () => {
    // The whole point of optional: this ticket must not touch a level that
    // never asked for it.
    expect(parse().terrainColours).toEqual([])
  })

  it('resolves a name to the tile id the importer emits', () => {
    /**
     * The legend speaks NAMES, never ids. Every other legend field does — a
     * level author writes `avatars`, not a category ordinal — and the numeric
     * ids are `tools/mapgen`'s private business. Resolving here means the rest
     * of the pipeline never carries a string it has to look up again.
     */
    expect(parse({ terrainColours: { '100,100,100': 'bridge' } }).terrainColours).toEqual([
      { colour: [100, 100, 100], name: 'bridge', terrain: TILE.BRIDGE },
    ])
  })

  it('accepts every name in the tile table, and only those', () => {
    // TERRAIN_NAMES is the vocabulary; a name in the table that the parser
    // rejects would be a table nobody can use.
    for (const [name, id] of Object.entries(TERRAIN_NAMES)) {
      expect({ name, terrain: parse({ terrainColours: { '10,20,30': name } }).terrainColours[0]?.terrain }).toEqual({
        name,
        terrain: id,
      })
    }
  })

  it('rejects a name it does not know, and says which ones it does', () => {
    /**
     * Not a silent skip. A skip leaves the author looking at a map that ignored
     * their annotation without ever saying so — which is exactly the failure
     * that produced this ticket, where the bridge was quietly classified as
     * jungle and nothing anywhere mentioned it.
     */
    let error: unknown
    try {
      parse({ terrainColours: { '100,100,100': 'plank' } })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(MapgenError)
    const message = error instanceof Error ? error.message : ''
    expect(message).toContain('plank')
    for (const name of Object.keys(TERRAIN_NAMES)) expect(message).toContain(name)
  })

  it('rejects a malformed colour key the same way markerColours does', () => {
    expect(() => parse({ terrainColours: { 'greyish': 'bridge' } })).toThrow(MapgenError)
    expect(() => parse({ terrainColours: { '100,100,300': 'bridge' } })).toThrow(MapgenError)
  })

  it('rejects anything that is not an object', () => {
    expect(() => parse({ terrainColours: [['100,100,100', 'bridge']] })).toThrow(MapgenError)
    expect(() => parse({ terrainColours: 'bridge' })).toThrow(MapgenError)
  })

  it('is sorted by colour, so iteration never depends on JSON key order', () => {
    /**
     * The same rule `markerColours` follows and for the same reason: two
     * legends with the same content written in a different order must import
     * byte-identically, because the pipeline is required to be idempotent.
     */
    const a = parse({ terrainColours: { '200,200,200': 'rock', '100,100,100': 'bridge' } })
    const b = parse({ terrainColours: { '100,100,100': 'bridge', '200,200,200': 'rock' } })
    expect(a.terrainColours.map((t) => t.name)).toEqual(['bridge', 'rock'])
    expect(a.terrainColours).toEqual(b.terrainColours)
  })
})

describe('two declared terrain colours that could claim the same tile are fatal', () => {
  it('rejects a pair within twice the tolerance', () => {
    /**
     * THE MARGIN IS TWICE THE TOLERANCE, not the tolerance — the same argument
     * `assertColoursSeparated` already makes about markers, and it is the part
     * that is easy to get wrong. A tile is claimed when it lands within
     * `tolerance` of a declared colour, so two colours `2 * tolerance` apart
     * have a band between them that both claim. Which one wins would then
     * depend on object key order, which is precisely what the sort above exists
     * to stop mattering.
     */
    let error: unknown
    try {
      parse({
        colourTolerance: 40,
        terrainColours: { '100,100,100': 'bridge', '150,150,150': 'rock' },
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(MapgenError)
    const message = error instanceof Error ? error.message : ''
    // Both named: an error that says "two colours are too close" and makes the
    // author find them is half an error message.
    expect(message).toContain('100,100,100')
    expect(message).toContain('150,150,150')
  })

  it('accepts a pair further apart than twice the tolerance', () => {
    expect(() =>
      parse({
        colourTolerance: 40,
        terrainColours: { '100,100,100': 'bridge', '181,100,100': 'rock' },
      }),
    ).not.toThrow()
  })

  it('and the check scales with the level`s own tolerance', () => {
    // Not a constant: a level painted from a tighter palette declares a tighter
    // tolerance and may legitimately place its colours closer together.
    const colours = { '100,100,100': 'bridge', '130,100,100': 'rock' }
    expect(() => parse({ colourTolerance: 10, terrainColours: colours })).not.toThrow()
    expect(() => parse({ colourTolerance: 20, terrainColours: colours })).toThrow(MapgenError)
  })
})

describe('terrain colours and marker colours are separate vocabularies', () => {
  it('a terrain colour does not have to stand clear of a marker colour', () => {
    /**
     * They are checked against their OWN kind only, because they are read at
     * different stages and can never contend: marker colours build the ink mask
     * and are then EXCLUDED from every tile average, while a terrain colour is
     * matched against exactly those averages. Folding them into one separation
     * check would be a constraint with no failure behind it.
     */
    expect(() =>
      parse({
        markerColours: { '60,160,255': 'avatars', '255,60,60': 'enemies' },
        terrainColours: { '60,160,255': 'water' },
      }),
    ).not.toThrow()
  })

  it('and declaring terrain leaves markerColours untouched', () => {
    const legend = parse({ terrainColours: { '100,100,100': 'bridge' } })
    expect(legend.markerColours.map((m) => m.category)).toEqual(['avatars', 'enemies'])
  })
})
