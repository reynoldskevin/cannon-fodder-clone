import { describe, it, expect } from 'vitest'
import { sliceGrid, trimFrame, cellAnchor, DIRECTIONS } from '../slice'

/**
 * Ticket 004 — slicing a sheet into frames.
 *
 * The load-bearing rule here: a frame is trimmed to its content to save atlas
 * space, but its ORIGINAL position within the cell must be recoverable. The die
 * animation's content box shrinks from 199px to 110px tall as the soldier falls;
 * if playback re-centred each frame on its own content the body would slide back
 * up the screen as it died.
 */

/** A tiny synthetic sheet: `cols x rows` cells of `cw x ch`, content described per cell. */
function sheet(
  cols: number, rows: number, cw: number, ch: number,
  content: (col: number, row: number) => { x: number; y: number; w: number; h: number } | null,
) {
  const width = cols * cw, height = rows * ch
  const data = new Uint8Array(width * height * 4)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const box = content(c, r)
      if (!box) continue
      for (let y = box.y; y < box.y + box.h; y++) {
        for (let x = box.x; x < box.x + box.w; x++) {
          const i = ((r * ch + y) * width + (c * cw + x)) * 4
          data[i] = 200; data[i + 1] = 100; data[i + 2] = 50; data[i + 3] = 255
        }
      }
    }
  }
  return { width, height, data }
}

describe('sliceGrid', () => {
  it('splits a sheet into cols x rows cells', () => {
    const s = sheet(4, 8, 480, 240, () => ({ x: 10, y: 10, w: 20, h: 20 }))
    const cells = sliceGrid(s, { cols: 4, rows: 8 })
    expect(cells).toHaveLength(32)
  })

  it('indexes cells by row then column', () => {
    const s = sheet(4, 8, 480, 240, () => ({ x: 0, y: 0, w: 4, h: 4 }))
    const cells = sliceGrid(s, { cols: 4, rows: 8 })
    expect(cells[0]).toMatchObject({ row: 0, col: 0 })
    expect(cells[4]).toMatchObject({ row: 1, col: 0 })
    expect(cells[31]).toMatchObject({ row: 7, col: 3 })
  })

  it('reports each cell origin in sheet pixels', () => {
    const s = sheet(4, 8, 480, 240, () => ({ x: 0, y: 0, w: 4, h: 4 }))
    const cells = sliceGrid(s, { cols: 4, rows: 8 })
    const c = cells.find((k) => k.row === 2 && k.col === 3)!
    expect(c.originX).toBe(3 * 480)
    expect(c.originY).toBe(2 * 240)
  })

  it('rejects a grid that does not divide the sheet evenly', () => {
    const s = sheet(4, 8, 480, 240, () => null)
    expect(() => sliceGrid(s, { cols: 7, rows: 8 })).toThrow()
  })
})

describe('trimFrame', () => {
  const CW = 480, CH = 240

  it('finds the content box inside a cell', () => {
    const s = sheet(1, 1, CW, CH, () => ({ x: 100, y: 40, w: 60, h: 90 }))
    const t = trimFrame(s, { originX: 0, originY: 0, width: CW, height: CH })
    expect(t.width).toBe(60)
    expect(t.height).toBe(90)
    expect(t.offsetX).toBe(100)
    expect(t.offsetY).toBe(40)
  })

  it('preserves the original cell position through the offset', () => {
    // The whole point: offset + trimmed box reconstructs where it was.
    const s = sheet(1, 1, CW, CH, () => ({ x: 213, y: 17, w: 30, h: 40 }))
    const t = trimFrame(s, { originX: 0, originY: 0, width: CW, height: CH })
    expect(t.offsetX + t.width).toBe(213 + 30)
    expect(t.offsetY + t.height).toBe(17 + 40)
  })

  it('does not re-centre a frame on its own content', () => {
    // Two frames, same cell size, content at different heights — as in `die`.
    const tall = sheet(1, 1, CW, CH, () => ({ x: 200, y: 10, w: 40, h: 200 }))
    const short = sheet(1, 1, CW, CH, () => ({ x: 200, y: 130, w: 40, h: 80 }))
    const a = trimFrame(tall, { originX: 0, originY: 0, width: CW, height: CH })
    const b = trimFrame(short, { originX: 0, originY: 0, width: CW, height: CH })
    expect(a.offsetY).toBe(10)
    expect(b.offsetY).toBe(130)
    // Both still end at the same baseline — the feet do not move.
    expect(a.offsetY + a.height).toBe(b.offsetY + b.height)
  })

  it('ignores fully transparent pixels when finding the box', () => {
    const s = sheet(1, 1, CW, CH, () => ({ x: 5, y: 5, w: 10, h: 10 }))
    const t = trimFrame(s, { originX: 0, originY: 0, width: CW, height: CH })
    expect(t.width).toBe(10)
    expect(t.height).toBe(10)
  })

  it('keeps semi-transparent antialiased edges as content', () => {
    // 8-14% of the real sprites' pixels are partial alpha; discarding them
    // would clip the outline.
    const CWs = 32, CHs = 32
    const data = new Uint8Array(CWs * CHs * 4)
    const put = (x: number, y: number, a: number) => {
      const i = (y * CWs + x) * 4
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = a
    }
    put(10, 10, 255)
    put(9, 10, 40) // faint edge pixel
    const t = trimFrame({ width: CWs, height: CHs, data }, { originX: 0, originY: 0, width: CWs, height: CHs })
    expect(t.offsetX).toBe(9)
  })

  it('reports an empty cell rather than a zero-sized box', () => {
    const s = sheet(1, 1, CW, CH, () => null)
    const t = trimFrame(s, { originX: 0, originY: 0, width: CW, height: CH })
    expect(t.empty).toBe(true)
  })
})

describe('cellAnchor', () => {
  it('is the bottom-centre of the CELL, not of the content', () => {
    const a = cellAnchor({ width: 480, height: 240 })
    expect(a.x).toBeCloseTo(240)
    expect(a.y).toBeCloseTo(240)
  })

  it('is identical for every frame of an animation, so nothing slides', () => {
    const cells = [{ width: 480, height: 240 }, { width: 480, height: 240 }]
    const anchors = cells.map(cellAnchor)
    expect(anchors[0]).toEqual(anchors[1])
  })
})

describe('DIRECTIONS', () => {
  it('is the eight compass points clockwise from north', () => {
    expect(DIRECTIONS).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'])
  })

  it('maps row 0 to north and row 4 to south', () => {
    // Established by measurement: row 0 is the back view, row 4 the front, and
    // rows 5/6/7 mirror 3/2/1.
    expect(DIRECTIONS[0]).toBe('N')
    expect(DIRECTIONS[4]).toBe('S')
  })

  it('has mirror-symmetric pairs either side of the N-S axis', () => {
    expect(DIRECTIONS[1]).toBe('NE'); expect(DIRECTIONS[7]).toBe('NW')
    expect(DIRECTIONS[2]).toBe('E'); expect(DIRECTIONS[6]).toBe('W')
    expect(DIRECTIONS[3]).toBe('SE'); expect(DIRECTIONS[5]).toBe('SW')
  })
})
