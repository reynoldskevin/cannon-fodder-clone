import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { configureFloorTexture, GroundTextureError, loadGroundTextures } from '../ground-texture'
import { GROUND_SURFACES } from '../../core/view/ground-surface'

/**
 * Ticket 034 — the three tileable ground textures, as configured objects.
 *
 * Like `terrain-groups.test.ts`, this exists because "`src/render` cannot be
 * tested" turned out to be false. `THREE.Texture` is a plain object; every
 * setting below is a field on it, and none of them touches the GPU until a
 * `WebGLRenderer` uploads the texture. Only the upload needs a context, and
 * nothing here performs one.
 *
 * MEASURED BEFORE WRITING THIS: deleting `texture.flipY = false`, and skipping
 * `configureFloorTexture` entirely for the two new textures, each left all 1980
 * tests green.
 */

const manifest = (overrides: Record<string, unknown> = {}) =>
  ({
    version: 2,
    ground: {
      jungle: { file: 'floor.png', width: 512, height: 512, tileable: true },
      water: { file: 'water.png', width: 512, height: 512, tileable: true },
      bridge: { file: 'bridge.png', width: 512, height: 512, tileable: true },
      ...overrides,
    },
  }) as never

describe('configureFloorTexture', () => {
  it('turns the upload flip OFF, which is load-bearing rather than tidy', () => {
    /**
     * Three flips images on upload by default, putting the PNG's BOTTOM row at
     * v = 0. `floorUv` maps world +z straight to +v and world +z is screen-down,
     * so with the flip left on, walking down the screen walks UP the image and
     * the entire floor renders vertically mirrored.
     *
     * On a seamless organic texture that never shows as a seam — it shows as art
     * that reads subtly wrong: leaves lit from the wrong side, stones with their
     * shadows above them. Which is to say it is invisible in a screenshot and
     * permanent in the build, and it is one deleted line away at all times.
     */
    const texture = new THREE.Texture()
    configureFloorTexture(texture, 1)
    expect(texture.flipY).toBe(false)
  })

  it('wraps on both axes, because the UVs are unbounded by construction', () => {
    /**
     * `floorUv` returns world position over a repeat distance, so its values are
     * unbounded and negative across half the map. `RepeatWrapping` is what folds
     * them. The default, `ClampToEdgeWrapping`, would smear the texture's edge
     * row across everything past the first repeat.
     */
    const texture = new THREE.Texture()
    configureFloorTexture(texture, 1)
    expect(texture.wrapS).toBe(THREE.RepeatWrapping)
    expect(texture.wrapT).toBe(THREE.RepeatWrapping)
  })

  it('treats the art as colour, not data', () => {
    // Left linear, painted artwork renders washed out and pale against terrain
    // that is correctly lit.
    const texture = new THREE.Texture()
    configureFloorTexture(texture, 1)
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(texture.generateMipmaps).toBe(true)
    expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter)
    expect(texture.magFilter).toBe(THREE.LinearFilter)
  })

  it('and never asks for more anisotropy than the driver offers', () => {
    // `min(cap, driver max)`, so a device offering 2 still works rather than
    // requesting 8 and getting undefined behaviour.
    const low = new THREE.Texture()
    configureFloorTexture(low, 2)
    expect(low.anisotropy).toBe(2)

    const high = new THREE.Texture()
    configureFloorTexture(high, 64)
    expect(high.anisotropy).toBeLessThanOrEqual(8)
    expect(high.anisotropy).toBeGreaterThan(1)
  })
})

describe('a ground texture the manifest cannot supply is a NAMED failure', () => {
  it('rejects a missing entry, saying which surface', () => {
    /**
     * NOT A SILENT FALLBACK TO THE JUNGLE. A river quietly drawn as jungle floor
     * is exactly the "looks plausible, is wrong" outcome that produced ticket
     * 033, where the bridge rendered as trees because nothing anywhere said
     * otherwise. Three textures is three ways to get this wrong, so the error
     * has to name which one.
     */
    const bad = manifest()
    delete (bad as { ground: Record<string, unknown> }).ground.water

    return loadGroundTextures(bad, 'http://x/sprites.manifest.json', 1).then(
      () => {
        throw new Error('expected a GroundTextureError')
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(GroundTextureError)
        expect(error instanceof Error ? error.message : '').toContain('water')
      },
    )
  })

  it('and rejects one that is not marked tileable', () => {
    /**
     * Not pedantry: a non-tiling image under `RepeatWrapping` puts a hard seam on
     * every repeat boundary — nine of them across level 1 — and that is the
     * failure that looks like a rendering bug rather than an asset one.
     *
     * Nothing covered this. Deleting the check entirely left all 1980 tests
     * green, so an acceptance criterion was met by a branch with no test behind
     * it.
     */
    return loadGroundTextures(
      manifest({ bridge: { file: 'bridge.png', width: 512, height: 512, tileable: false } }),
      'http://x/sprites.manifest.json',
      1,
    ).then(
      () => {
        throw new Error('expected a GroundTextureError')
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(GroundTextureError)
        expect(error instanceof Error ? error.message : '').toContain('bridge')
      },
    )
  })

  it('and the surfaces it demands are exactly the ones the renderer asks for', () => {
    // Two lists that must not drift: a surface the loader does not fetch is a
    // material with no map, and one the renderer never uses is a wasted upload.
    expect([...GROUND_SURFACES].sort()).toEqual(['bridge', 'jungle', 'water'])
  })
})
