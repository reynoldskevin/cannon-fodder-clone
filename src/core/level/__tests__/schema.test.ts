import { describe, it, expect } from 'vitest'
import {
  loadLevel,
  LevelValidationError,
  CURRENT_SCHEMA_VERSION,
  type LevelData,
} from '../index'

/**
 * Ticket 002 — LevelSchema and validated level loader.
 *
 * `level.json` is the contract between the offline `tools/mapgen` importer and
 * the game. A malformed level must fail loudly at the boundary, naming the
 * offending field — never coerce, never half-load. These tests are that contract.
 */

/** A minimal but complete 3x2 level. Helpers below mutate clones of it. */
function validLevel(): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    name: 'Test Beach',
    size: { w: 3, h: 2 },
    // h rows of w columns
    terrain: [
      [0, 1, 2],
      [1, 0, 1],
    ],
    walkable: [
      [true, true, false],
      [true, true, true],
    ],
    spawns: {
      avatars: [{ x: 0, y: 0 }],
      enemies: [{ x: 2, y: 1, type: 'rifleman', facing: 'south' }],
      chests: [{ x: 1, y: 0 }],
      // schemaVersion 2 added scenery props as a fourth category (ticket 003).
      // Required like the rest: the version gate guarantees it is present, and
      // making it optional would let a mapgen regression emit a silently
      // prop-less level — the exact loss the category was added to prevent.
      props: [{ x: 1, y: 1, type: 'tree' }],
    },
    objectives: [{ type: 'kill_all' }],
  }
}

/** Clone the valid fixture and apply a mutation, so each case starts clean. */
function levelWith(mutate: (l: Record<string, unknown>) => void): Record<string, unknown> {
  const clone = structuredClone(validLevel())
  mutate(clone)
  return clone
}

/** Assert the call throws LevelValidationError and hand it back for inspection. */
function expectValidationError(input: unknown): LevelValidationError {
  try {
    loadLevel(input)
  } catch (err) {
    if (err instanceof LevelValidationError) return err
    throw new Error(
      `expected LevelValidationError, got ${err instanceof Error ? err.constructor.name : typeof err}: ${String(err)}`,
      { cause: err },
    )
  }
  throw new Error('expected loadLevel to throw LevelValidationError, but it returned normally')
}

describe('happy path', () => {
  it('parses a valid level and returns typed data', () => {
    const level: LevelData = loadLevel(validLevel())
    expect(level.name).toBe('Test Beach')
    expect(level.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(level.size).toEqual({ w: 3, h: 2 })
  })

  it('preserves terrain and walkable grids intact', () => {
    const level = loadLevel(validLevel())
    expect(level.terrain).toEqual([
      [0, 1, 2],
      [1, 0, 1],
    ])
    expect(level.walkable).toEqual([
      [true, true, false],
      [true, true, true],
    ])
  })

  it('preserves every spawn category', () => {
    const level = loadLevel(validLevel())
    expect(level.spawns.avatars).toHaveLength(1)
    expect(level.spawns.enemies).toHaveLength(1)
    expect(level.spawns.chests).toHaveLength(1)
    expect(level.spawns.props).toHaveLength(1)
    expect(level.spawns.avatars[0]).toMatchObject({ x: 0, y: 0 })
    expect(level.spawns.enemies[0]).toMatchObject({ x: 2, y: 1, type: 'rifleman' })
  })

  it('preserves optional spawn fields when present', () => {
    const level = loadLevel(validLevel())
    expect(level.spawns.enemies[0]?.type).toBe('rifleman')
    expect(level.spawns.enemies[0]?.facing).toBe('south')
  })

  it('accepts empty spawn lists (a level may legitimately have no chests)', () => {
    const level = loadLevel(levelWith((l) => {
      ;(l.spawns as Record<string, unknown>).chests = []
    }))
    expect(level.spawns.chests).toEqual([])
  })

  it('preserves objectives', () => {
    const level = loadLevel(validLevel())
    expect(level.objectives).toHaveLength(1)
    expect(level.objectives[0]?.type).toBe('kill_all')
  })

  it('does not alias the caller\'s input object', () => {
    const input = validLevel()
    const level = loadLevel(input)
    ;(input.terrain as number[][])[0]![0] = 999
    expect(level.terrain[0]?.[0]).toBe(0)
  })
})

describe('schemaVersion is a distinct, loud failure', () => {
  it('rejects a mismatched schemaVersion with a distinct code', () => {
    const err = expectValidationError(levelWith((l) => {
      l.schemaVersion = CURRENT_SCHEMA_VERSION + 1
    }))
    expect(err.code).toBe('SCHEMA_VERSION_MISMATCH')
    expect(err.path).toBe('schemaVersion')
  })

  it('does not silently coerce an older schemaVersion', () => {
    const err = expectValidationError(levelWith((l) => {
      l.schemaVersion = 0
    }))
    expect(err.code).toBe('SCHEMA_VERSION_MISMATCH')
  })

  it('rejects a missing schemaVersion', () => {
    const err = expectValidationError(levelWith((l) => {
      delete l.schemaVersion
    }))
    expect(err.path).toBe('schemaVersion')
  })

  it('mentions both expected and received versions in the message', () => {
    const err = expectValidationError(levelWith((l) => {
      l.schemaVersion = 42
    }))
    expect(err.message).toContain('42')
    expect(err.message).toContain(String(CURRENT_SCHEMA_VERSION))
  })
})

describe('dimension integrity', () => {
  it('rejects a terrain grid with the wrong number of rows', () => {
    const err = expectValidationError(levelWith((l) => {
      l.terrain = [[0, 1, 2]] // 1 row, size.h is 2
    }))
    expect(err.code).toBe('DIMENSION_MISMATCH')
    expect(err.path).toContain('terrain')
  })

  it('rejects a terrain row with the wrong number of columns', () => {
    const err = expectValidationError(levelWith((l) => {
      l.terrain = [
        [0, 1, 2],
        [1, 0], // 2 cols, size.w is 3
      ]
    }))
    expect(err.code).toBe('DIMENSION_MISMATCH')
    expect(err.path).toContain('terrain')
  })

  it('rejects a walkable grid with the wrong number of rows', () => {
    const err = expectValidationError(levelWith((l) => {
      l.walkable = [[true, true, false]]
    }))
    expect(err.code).toBe('DIMENSION_MISMATCH')
    expect(err.path).toContain('walkable')
  })

  it('rejects a walkable row with the wrong number of columns', () => {
    const err = expectValidationError(levelWith((l) => {
      l.walkable = [
        [true, true, false],
        [true, true],
      ]
    }))
    expect(err.code).toBe('DIMENSION_MISMATCH')
    expect(err.path).toContain('walkable')
  })

  it('names the offending row index in the path', () => {
    const err = expectValidationError(levelWith((l) => {
      l.terrain = [
        [0, 1, 2],
        [1, 0],
      ]
    }))
    expect(err.path).toBe('terrain[1]')
  })

  it('rejects a non-positive size', () => {
    const err = expectValidationError(levelWith((l) => {
      l.size = { w: 0, h: 2 }
    }))
    expect(err.path).toContain('size')
  })
})

describe('spawn bounds', () => {
  it('rejects an avatar spawned outside the grid on x', () => {
    const err = expectValidationError(levelWith((l) => {
      ;(l.spawns as Record<string, unknown>).avatars = [{ x: 3, y: 0 }]
    }))
    expect(err.code).toBe('SPAWN_OUT_OF_BOUNDS')
    expect(err.path).toBe('spawns.avatars[0]')
  })

  it('rejects an enemy spawned outside the grid on y', () => {
    const err = expectValidationError(levelWith((l) => {
      ;(l.spawns as Record<string, unknown>).enemies = [{ x: 0, y: 2 }]
    }))
    expect(err.code).toBe('SPAWN_OUT_OF_BOUNDS')
    expect(err.path).toBe('spawns.enemies[0]')
  })

  it('rejects a negative spawn coordinate', () => {
    const err = expectValidationError(levelWith((l) => {
      ;(l.spawns as Record<string, unknown>).chests = [{ x: -1, y: 0 }]
    }))
    expect(err.code).toBe('SPAWN_OUT_OF_BOUNDS')
    expect(err.path).toBe('spawns.chests[0]')
  })

  it('names the offending index when a later spawn is out of bounds', () => {
    const err = expectValidationError(levelWith((l) => {
      ;(l.spawns as Record<string, unknown>).enemies = [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 99, y: 0 },
      ]
    }))
    expect(err.path).toBe('spawns.enemies[2]')
  })

  it('accepts spawns exactly on the boundary', () => {
    const level = loadLevel(levelWith((l) => {
      ;(l.spawns as Record<string, unknown>).avatars = [{ x: 2, y: 1 }]
    }))
    expect(level.spawns.avatars[0]).toMatchObject({ x: 2, y: 1 })
  })

  it('rejects a non-integer spawn coordinate', () => {
    const err = expectValidationError(levelWith((l) => {
      ;(l.spawns as Record<string, unknown>).avatars = [{ x: 1.5, y: 0 }]
    }))
    expect(err.path).toBe('spawns.avatars[0]')
  })
})

describe('structural validation', () => {
  it('rejects a null input', () => {
    expectValidationError(null)
  })

  it('rejects a non-object input', () => {
    expectValidationError('not a level')
  })

  it('rejects a missing spawns block', () => {
    const err = expectValidationError(levelWith((l) => {
      delete l.spawns
    }))
    expect(err.path).toContain('spawns')
  })

  it('rejects a missing spawn category', () => {
    const err = expectValidationError(levelWith((l) => {
      delete (l.spawns as Record<string, unknown>).enemies
    }))
    expect(err.path).toContain('spawns.enemies')
  })

  it('rejects a missing props category, like any other', () => {
    const err = expectValidationError(levelWith((l) => {
      delete (l.spawns as Record<string, unknown>).props
    }))
    expect(err.path).toContain('spawns.props')
  })

  it('rejects a missing objectives array', () => {
    const err = expectValidationError(levelWith((l) => {
      delete l.objectives
    }))
    expect(err.path).toContain('objectives')
  })

  it('rejects an empty objectives array (a level must be winnable)', () => {
    const err = expectValidationError(levelWith((l) => {
      l.objectives = []
    }))
    expect(err.path).toContain('objectives')
  })

  it('rejects a non-numeric terrain cell', () => {
    const err = expectValidationError(levelWith((l) => {
      l.terrain = [
        [0, 'grass', 2],
        [1, 0, 1],
      ]
    }))
    expect(err.path).toContain('terrain')
  })

  it('rejects a non-boolean walkable cell', () => {
    const err = expectValidationError(levelWith((l) => {
      l.walkable = [
        [true, 1, false],
        [true, true, true],
      ]
    }))
    expect(err.path).toContain('walkable')
  })

  it('rejects a missing name', () => {
    const err = expectValidationError(levelWith((l) => {
      delete l.name
    }))
    expect(err.path).toBe('name')
  })

  it('rejects an objective without a type', () => {
    const err = expectValidationError(levelWith((l) => {
      l.objectives = [{ count: 3 }]
    }))
    expect(err.path).toContain('objectives[0]')
  })
})

describe('open enums (extension points must not require a schema break)', () => {
  it('accepts an unknown terrain tile id', () => {
    const level = loadLevel(levelWith((l) => {
      l.terrain = [
        [0, 1, 99],
        [1, 0, 1],
      ]
    }))
    expect(level.terrain[0]?.[2]).toBe(99)
  })

  it('accepts an unknown objective type', () => {
    const level = loadLevel(levelWith((l) => {
      l.objectives = [{ type: 'enter_building', buildingId: 'bunker-1' }]
    }))
    expect(level.objectives[0]?.type).toBe('enter_building')
  })

  it('accepts an unknown enemy archetype string', () => {
    const level = loadLevel(levelWith((l) => {
      ;(l.spawns as Record<string, unknown>).enemies = [{ x: 0, y: 0, type: 'rocket-trooper' }]
    }))
    expect(level.spawns.enemies[0]?.type).toBe('rocket-trooper')
  })
})

describe('LevelValidationError shape', () => {
  it('is an Error with a stable name', () => {
    const err = expectValidationError(levelWith((l) => {
      delete l.name
    }))
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('LevelValidationError')
  })

  it('always carries a non-empty path and code', () => {
    const err = expectValidationError(levelWith((l) => {
      delete l.name
    }))
    expect(err.path.length).toBeGreaterThan(0)
    expect(err.code.length).toBeGreaterThan(0)
  })

  it('includes the field path in the message so the failure is self-describing', () => {
    const err = expectValidationError(levelWith((l) => {
      ;(l.spawns as Record<string, unknown>).enemies = [{ x: 99, y: 0 }]
    }))
    expect(err.message).toContain('spawns.enemies[0]')
  })
})
