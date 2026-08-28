import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Ticket 082 — the samples the game imports are small, present, and committed.
 *
 * READ AS SOURCE TEXT RATHER THAN IMPORTED. `src/audio/index.ts` is built around
 * `AudioContext` and this suite runs on `environment: 'node'`, so the module
 * cannot be loaded here at all — the same constraint that shaped
 * `squad-panel.test.ts` and `mission-banner.test.ts`, and the same answer: parse
 * the import lines, then ask the filesystem about what they name.
 *
 * THE POINT OF THE TRACKED CHECK. `assets/source/audio/` was untracked and NOT
 * ignored, so nine `.wav` files existed on exactly one machine and `npm run
 * build` from a clean clone died on the first import. Every other test in this
 * suite passed throughout, because every other test ran on the machine that had
 * the files. Presence on disk is not the invariant — presence in the repository
 * is.
 */

const AUDIO_MODULE = new URL('../index.ts', import.meta.url)
const REPO_ROOT = new URL('../../../', import.meta.url)

const source = readFileSync(AUDIO_MODULE, 'utf8')

/** Every asset path the audio module imports, as written. */
const importedPaths: readonly string[] = [
  ...source.matchAll(/^import\s+\w+\s+from\s+'([^']*\/assets\/[^']*?)(\?url)?'/gm),
].map((m) => m[1] as string)

/** Resolved against the module's own directory, the way the bundler resolves it. */
const resolve = (p: string): string => fileURLToPath(new URL(p, AUDIO_MODULE))

describe('the audio module imports real samples', () => {
  it('and there are some to check', () => {
    /**
     * NON-VACUITY, AND THIS ONE HAS TEETH. Every sweep below runs over
     * `importedPaths`, so the day the import style changes — a barrel file, a
     * glob, a rename of `assets/` — the regex quietly matches nothing and all of
     * this passes while checking NOTHING. Nine is the count the cue table needs:
     * three deaths and six single-sample cues.
     */
    expect(importedPaths.length).toBe(9)
  })

  it('naming a file that is actually there', () => {
    const missing = importedPaths.filter((p) => !existsSync(resolve(p)))
    expect(missing).toEqual([])
  })

  it('and committed, so a clean clone can build', () => {
    /**
     * THE REGRESSION THIS FILE EXISTS FOR. `git ls-files --error-unmatch` exits
     * non-zero for a path git does not track, which is the only cheap way to tell
     * "this file is here" apart from "this file is here FOR ME". Asked in one
     * call so the failure names every untracked sample at once.
     */
    const absolute = importedPaths.map(resolve)
    const tracked = new Set(
      execFileSync('git', ['ls-files', '-z', '--', ...absolute], {
        cwd: fileURLToPath(REPO_ROOT),
        encoding: 'utf8',
      })
        .split('\0')
        .filter((line) => line !== '')
        .map((line) => fileURLToPath(new URL(line, REPO_ROOT))),
    )
    const untracked = absolute.filter((p) => !tracked.has(p))
    expect(untracked).toEqual([])
  })
})

describe('the samples are shipped compressed', () => {
  it('with no uncompressed wave file left in the import list', () => {
    /**
     * A 96 kHz 24-bit master decodes to exactly the same PCM as the 48 kHz AAC
     * the browser actually needs, having spent thirty times the bytes to say it.
     * The extension is the visible half of that decision; the size cap below is
     * the half that stops a `.m4a` being re-exported at master quality.
     */
    const uncompressed = importedPaths.filter((p) => p.endsWith('.wav'))
    expect(uncompressed).toEqual([])
  })

  it('and the whole sound bank fits in half a megabyte', () => {
    /**
     * MEASURED AS A TOTAL, NOT PER FILE, because the total is what a player
     * downloads: `load` fetches all nine through one `Promise.all` the moment the
     * context opens. 10.19 MB of `.wav` became 0.31 MB at AAC 128 kbps; half a
     * megabyte leaves room to add a cue or two — `chest` is already named in
     * `CUES` with no file — without leaving room to slip a master back in.
     */
    const total = importedPaths.reduce((sum, p) => sum + statSync(resolve(p)).size, 0)
    expect(total).toBeLessThan(512 * 1024)
    // And not zero-length placeholders that would satisfy every check above.
    expect(total).toBeGreaterThan(64 * 1024)
  })
})

describe('the cue table still covers every cue it used to', () => {
  it('naming all seven, with death keeping its three variants', () => {
    /**
     * THE SILENT-CUE RISK. `load` swallows a failed fetch or decode on purpose so
     * one bad sample cannot break a mission — which means a cue dropped from this
     * table during a re-encode goes silent with nothing failing anywhere. Pinning
     * the table's shape is what turns that into a test failure.
     */
    const table = /const CUE_SAMPLES[^=]*=\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    const cues = [...table.matchAll(/^\s*'?([\w-]+)'?:\s*\[([^\]]*)\]/gm)].map((m) => [
      m[1] as string,
      (m[2] as string).split(',').filter((s) => s.trim() !== '').length,
    ])
    expect(Object.fromEntries(cues)).toEqual({
      rifle: 1,
      'grenade-throw': 1,
      'rocket-launch': 1,
      explosion: 1,
      death: 3,
      victory: 1,
      defeat: 1,
    })
  })
})
