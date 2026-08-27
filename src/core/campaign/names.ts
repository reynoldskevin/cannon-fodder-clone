/**
 * Where a soldier's name comes from (ticket 019).
 *
 * A NAME IS NEVER REISSUED, AND THAT IS A REAL CONSTRAINT rather than a
 * nicety. The pool is finite and a campaign outlives it — five levels of
 * casualties will run through thirty names — so a generator that picked at
 * random, or that wrapped around when the pool ran dry, would eventually put
 * two identical gravestones on Boot Hill. Boot Hill is a list of names; two
 * stones reading the same thing destroys the one screen this whole ticket
 * exists to feed, and makes the promotion list ambiguous on the way.
 *
 * So names are ISSUED BY INDEX, not drawn:
 *
 *   - The pool is shuffled once, deterministically, from the campaign's seed.
 *     Same seed, same roster — a returning player must get his squad back, not
 *     a set of strangers wearing his save file. Two different seeds give two
 *     different rosters, or "seeded" would be indistinguishable from
 *     "hardcoded".
 *   - The campaign remembers how many men it has EVER recruited and issues the
 *     next index. That counter only rises, so a dead man's name is never handed
 *     to a living one — no cross-check against the dead list is needed, which
 *     means there is no cross-check to forget.
 *   - Past the end of the pool the name gets a generation suffix (`Jones II`,
 *     `Jones III`) rather than repeating. Ugly is survivable; ambiguous is not.
 *
 * Randomness is SEEDED (`core/world/prng`). `Math.random` here would break the
 * reload promise above, and is asserted against by the purity suite.
 */

import { createRng } from '../world/prng'
import type { Rng } from '../world/prng'

/**
 * The pool (ticket 045). Plain data, imported from `recruit_names.csv` — the
 * roll the original game recruited from — and NOT invented here. Short, first
 * names and nicknames rather than surnames: they are rendered into a roster row
 * and onto a gravestone, and the longest of these is six characters, so nothing
 * in the pool is up against either field.
 *
 * THE NAME COLUMN ONLY. The sheet carries four other columns and none of them
 * is imported; a name with anything else riding along would read as the man's
 * name on every screen that shows one. `names.test.ts` holds every entry to a
 * single bare word so a re-import cannot smuggle one in.
 *
 * SHEET ORDER, LESS ITS REPEATS. Thirteen of the sheet's 360 rows name someone
 * who already appeared, and the first appearance is the one kept. That is not
 * tidiness: a duplicate here becomes two identical gravestones, which is the
 * exact ambiguity the rest of this file is built to prevent — see below.
 *
 * ADD TO IT FREELY — nothing derives a count from its length, and a longer pool
 * simply delays the first generation suffix. It must never contain a duplicate
 * or a name already ending in a numeral, either of which would collide with a
 * suffixed form. Both rules were prose until ticket 045 and are now checked.
 */
export const NAME_POOL: readonly string[] = [
  'JOOLS', 'JOPS', 'STOO', 'RJ', 'UBIK', 'CJ', 'CHRIS', 'PETE', 'TADGER', 'HECTOR', 'ELROY',
  'SOFTY', 'MAC', 'BOMBER', 'STAN', 'TOSH', 'BRAINS', 'NORM', 'BUSTER', 'SPIKE', 'BROWNY',
  'MURPHY', 'KILLER', 'ABDUL', 'SPOTTY', 'GOOFY', 'DONALD', 'WINDY', 'NIFTA', 'DENZIL', 'CEDRIC',
  'ALF', 'MARTY', 'CECIL', 'WALLY', 'DONG', 'JASON', 'ROY', 'PEEWEE', 'ARNIE', 'LOFTY', 'TUBBY',
  'PORKY', 'NORRIS', 'BUGSY', 'GREG', 'GUS', 'GINGER', 'EDDY', 'STEVE', 'HUGO', 'ZIPPY', 'SONNY',
  'WILLY', 'MARIO', 'LUIGI', 'BO', 'JOHAN', 'COLIN', 'RUBY', 'MORGAN', 'REG', 'PETER', 'BRETT',
  'MATT', 'VIC', 'HUT', 'BUD', 'BRAD', 'ASHLEY', 'LES', 'REX', 'LOUIS', 'PEDRO', 'MARCO', 'LEON',
  'ALI', 'TYSON', 'TIGER', 'FRANK', 'REUBEN', 'LEYTON', 'JOSH', 'JUDAS', 'AJ', 'LEX', 'BUTCH',
  'BISON', 'GARY', 'LUTHER', 'KERMIT', 'BRIAN', 'RAY', 'FREAK', 'LEROY', 'LEE', 'BANJO', 'BEAKER',
  'BASIL', 'BONZO', 'KELVIN', 'RONNIE', 'RUPERT', 'ROO', 'DAN', 'BASHER', 'LUCKY', 'DON', 'TOMMY',
  'EDDIE', 'CYNIC', 'BLOND', 'PADDY', 'ARNOLD', 'TONY', 'TEDDY', 'DOM', 'THEO', 'MARTIN',
  'CHUNKY', 'JON', 'BEN', 'GIRLY', 'JULIAN', 'PIZZA', 'MARK', 'CIARAN', 'JOCK', 'GRAVY', 'TRENDY',
  'NEIL', 'DEREK', 'ED', 'BIFF', 'PAUL', 'STUART', 'RANDY', 'LORETA', 'SUZIE', 'PUMPY', 'URMER',
  'BUNNY', 'ADEY', 'PEPPER', 'BEEFY', 'HARRY', 'TINY', 'HOWARD', 'MORRIS', 'THOR', 'REV', 'DUKE',
  'SHORTY', 'MICKY', 'CHAS', 'MELONY', 'CRAIG', 'SIDNEY', 'PARSON', 'ROWAN', 'SMELLY', 'DOK',
  'STEW', 'ADRIAN', 'PAT', 'ICEMAN', 'GOOSE', 'DIPPY', 'VIV', 'SI', 'BUNTY', 'NOEL', 'BONO',
  'EDGE', 'ROBBIE', 'SEAN', 'MILES', 'JIMI', 'GORDON', 'VAL', 'HOBO', 'FUNGUS', 'JR', 'LAMPY',
  'MARCUS', 'PELE', 'HUBERT', 'JAMES', 'TIM', 'SAUL', 'ANDY', 'SILKY', 'SIMON', 'HANDY', 'SID',
  'GEORGE', 'JOFF', 'BARRY', 'DICK', 'GIL', 'NICK', 'TED', 'PHIL', 'WOODY', 'WYNN', 'ALAN', 'PIP',
  'MICKEY', 'JUSTIN', 'KARL', 'MADDOG', 'HORACE', 'HAROLD', 'GAZZA', 'SPIV', 'FOXY', 'NED',
  'BAZIL', 'OLIVER', 'RETT', 'SCOT', 'DARREN', 'EDWIN', 'MOSES', 'NOAH', 'SETH', 'HARVEY', 'MARY',
  'PILOT', 'MCBETH', 'MCDUFF', 'BELLY', 'MATHEW', 'LUKE', 'JOHN', 'ASLAM', 'HAM', 'SHEM',
  'JOSHUA', 'JACOB', 'ESAW', 'OMAR', 'ENOCH', 'OBADIA', 'DANIEL', 'SAMUEL', 'ROBBO', 'JOEBED',
  'ISMAEL', 'ISREAL', 'ISABEL', 'ISARAT', 'MONK', 'BLIP', 'BACON', 'DANUBE', 'FRIEND', 'DARRYL',
  'IZZY', 'CROSBY', 'STILLS', 'NASH', 'YOUNG', 'CHEESE', 'SALAMI', 'PRAWN', 'RADISH', 'EGBERT',
  'EDWY', 'EDGAR', 'EDRED', 'EGGPIE', 'BROS', 'CAKEY', 'ZIGGY', 'ALFRED', 'SIGGY', 'HILDA',
  'SNELL', 'SPARKS', 'ROB', 'TOPCAT', 'BENNY', 'DIBBLE', 'BENKER', 'DOSEY', 'BEAKY', 'JOIST',
  'PIVOT', 'TREE', 'BUSH', 'GRASS', 'SEEDY', 'TIN', 'ROLLO', 'ZIPPO', 'NANCY', 'LARRY', 'IGGY',
  'NIGEL', 'JAMIE', 'JESSE', 'LEO', 'VIRGO', 'GARTH', 'FIDEL', 'IDI', 'CHE', 'JOHNNY', 'AMBER',
  'LAIRY', 'LARDO', 'CLIFF', 'FESTER', 'JETHRO', 'JIMBOB', 'DECLAN', 'HICKEY', 'CHOCCO', 'GOCH',
  'PABLO', 'RENOIR', 'ROLF', 'DALI', 'MONET', 'MANET', 'GAUGIN', 'CHAGAL', 'KID', 'HULLY',
  'ROBERT', 'PIERS', 'RAITH', 'JEEVES', 'PASTER', 'GINAN', 'DEITER', 'DENI', 'ZARK', 'WIZKID',
  'WIZARD', 'IAIN', 'KITTEN', 'GONNER', 'WASTER', 'LOSER', 'FODDER',
]

/** Roman numeral pieces, largest first. Enough for any campaign a player finishes. */
const NUMERALS: readonly (readonly [number, string])[] = [
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
]

/**
 * Roman numerals, because `Jones II` reads as a second man of that name while
 * `Jones 2` reads as a bug. Large generations degrade to a long string of `X`s
 * rather than to nothing, which stays unique — the only property that matters.
 */
function roman(value: number): string {
  let left = Math.max(1, Math.floor(value))
  let out = ''
  for (const [amount, symbol] of NUMERALS) {
    while (left >= amount) {
      out += symbol
      left -= amount
    }
  }
  return out
}

/**
 * Fisher-Yates over a copy. In place on the pool itself would make the module
 * constant differ between two campaigns in the same session, which is a
 * cross-campaign leak that no test in this ticket would catch.
 */
function shuffled(pool: readonly string[], rng: Rng): string[] {
  const out = [...pool]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1)
    const here = out[i]
    const there = out[j]
    // Both are in range by construction; the guard is what `noUncheckedIndexedAccess`
    // costs, and skipping a swap is safer than asserting a non-null.
    if (here === undefined || there === undefined) continue
    out[i] = there
    out[j] = here
  }
  return out
}

/**
 * `count` names for the men numbered `fromIndex` onwards in a campaign seeded
 * with `seed`. Pure: the same arguments always give the same names, which is
 * what lets recruitment be replayed from a save that stores only a seed and a
 * counter.
 */
export function issueNames(seed: number, fromIndex: number, count: number): string[] {
  const order = shuffled(NAME_POOL, createRng(seed))
  const names: string[] = []
  for (let n = 0; n < count; n += 1) {
    const index = fromIndex + n
    // `?? 'Soldier'` is unreachable with a non-empty pool and exists only to
    // satisfy the index-may-be-undefined rule; an empty pool would make every
    // name identical, which is why the pool above must never be emptied.
    const base = order[index % order.length] ?? 'Soldier'
    const generation = Math.floor(index / order.length)
    names.push(generation === 0 ? base : `${base} ${roman(generation + 1)}`)
  }
  return names
}
