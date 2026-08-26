import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { INITIAL_SCREEN, TRANSITIONS } from '../index'

/**
 * Ticket 020 — the code and the diagram cannot drift.
 *
 * `ARCHITECTURE_DIAGRAM.md` holds the campaign state chart, and the brief is
 * GRADED on that document. Documentation nobody checks rots: somebody adds a
 * screen, the machine grows a row, and the diagram quietly becomes a picture of
 * a game that no longer exists — which is worse than no diagram, because a
 * reader trusts it.
 *
 * So the chart is parsed and compared, in BOTH directions. A row in the table
 * with no arrow is an undocumented transition; an arrow with no row is a
 * promise the game does not keep. This is the cheapest possible way to make
 * either impossible, and it costs one file read.
 *
 * IT IS DELIBERATELY NOT A SNAPSHOT of the whole document. Only the arrows
 * matter here — the diagram's prose, layout and every other mermaid block in it
 * are free to change without this failing, because a test that fails on
 * unrelated edits is a test people delete.
 */

const DIAGRAM = 'ARCHITECTURE_DIAGRAM.md'

/**
 * The `stateDiagram-v2` block's arrows, as `from|to`.
 *
 * Labels are dropped on purpose: the diagram says "MissionComplete" where the
 * table says `missionComplete`, and forcing those to match would make the chart
 * a source file rather than a picture. What must agree is the SHAPE — which
 * screens lead where.
 */
function chartArrows(): string[] {
  const markdown = readFileSync(DIAGRAM, 'utf8')
  const block = /```mermaid\s*\nstateDiagram-v2\n([\s\S]*?)```/.exec(markdown)
  if (block === null) throw new Error(`no stateDiagram-v2 block found in ${DIAGRAM}`)
  const arrows: string[] = []
  for (const line of (block[1] ?? '').split('\n')) {
    const match = /^\s*([A-Za-z[*\]]+)\s*-->\s*([A-Za-z]+)\s*(?::.*)?$/.exec(line)
    if (match === null) continue
    const from = match[1] ?? ''
    const to = match[2] ?? ''
    // `[*] --> Menu` is the entry marker, not a transition between screens.
    if (from === '[*]') {
      arrows.push(`START|${to}`)
      continue
    }
    arrows.push(`${from}|${to}`)
  }
  return arrows
}

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort()

describe('the state chart in ARCHITECTURE_DIAGRAM.md', () => {
  it('is there, and parses', () => {
    // Non-vacuity. Every comparison below is trivially satisfied by a parser
    // that found nothing, which is how this kind of test rots silently after
    // somebody reformats the document.
    expect(chartArrows().length).toBeGreaterThan(5)
  })

  it('names the entry state the machine actually starts in', () => {
    expect(chartArrows()).toContain(`START|${INITIAL_SCREEN}`)
  })

  it('promises nothing the machine cannot do', () => {
    // An arrow with no row: a documented transition the game refuses. A reader
    // builds a mental model from this file and then finds the button dead.
    const documented = unique(chartArrows().filter((a) => !a.startsWith('START|')))
    const implemented = new Set(TRANSITIONS.map((t) => `${t.from}|${t.to}`))
    expect(documented.filter((a) => !implemented.has(a))).toEqual([])
  })

  it('and hides nothing the machine can do', () => {
    // The other direction, and the one that rots first: a row added to the
    // table with no arrow drawn for it. The diagram stops being the whole
    // picture and nobody notices, because everything it DOES say is still true.
    const documented = new Set(chartArrows())
    const implemented = unique(TRANSITIONS.map((t) => `${t.from}|${t.to}`))
    expect(implemented.filter((a) => !documented.has(a))).toEqual([])
  })

  it('agrees on the exact set, so neither can drift', () => {
    // Both directions in one assertion, which is what a failure should read
    // like: here is the chart, here is the machine, here is the difference.
    const documented = unique(chartArrows().filter((a) => !a.startsWith('START|')))
    const implemented = unique(TRANSITIONS.map((t) => `${t.from}|${t.to}`))
    expect(implemented).toEqual(documented)
  })

  it('documents the demo shortcut, which is easy to forget', () => {
    // `Menu --> Mission` bypasses Recruitment and Briefing entirely. It is the
    // one arrow that looks like a mistake in the picture, so it is the one most
    // likely to be "tidied away" by somebody redrawing the chart.
    expect(chartArrows()).toContain('Menu|Mission')
  })

  it('documents both ways out of Boot Hill', () => {
    // Next level, or the campaign is over. Losing the second leaves a finished
    // campaign with nowhere to go.
    const arrows = chartArrows()
    expect(arrows).toContain('BootHill|Recruitment')
    expect(arrows).toContain('BootHill|Menu')
  })
})
