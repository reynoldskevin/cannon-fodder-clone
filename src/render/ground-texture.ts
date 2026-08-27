/**
 * The tileable ground textures (ticket 009c; three of them since ticket 034).
 *
 * `tools/spritegen` has emitted `floor.png` — 512x512, seamless — since ticket
 * 004 and kept it OUT of the atlas on purpose: `RepeatWrapping` wraps a whole
 * texture, so an image that has to tile cannot be a rect inside a packed sheet.
 * `water.png` and `bridge.png` join it for the same reason. This module is the
 * other half of that decision.
 *
 * It is a separate file from `sprite-atlas.ts` because it answers to a different
 * consumer (the terrain, not the entities) and because `UnitVisual` is an
 * interface with a stub implementation in tests — widening it to carry ground
 * textures would have forced every stub to invent them.
 */

import * as THREE from 'three'
import { GROUND_SURFACES, type GroundSurface } from '../core/view/ground-surface'
import { resolveAssetUrl, type SpriteManifest } from './sprite-atlas'

/** A failure loading a ground texture, phrased for the boot error overlay. */
export class GroundTextureError extends Error {
  constructor(
    readonly detail: string,
    readonly technical: string,
  ) {
    super(`${detail} (${technical})`)
    this.name = 'GroundTextureError'
  }
}

/**
 * Cap on anisotropic filtering.
 *
 * The ground is viewed at a 55-degree elevation, which is a steeply foreshortened
 * angle: a screen pixel near the top of the view covers several times more
 * texels along z than along x, and an isotropic mip chain has to pick one level
 * for both — so it picks the blurrier one and the distance smears. Anisotropy
 * samples the elongated footprint properly and is the single biggest quality win
 * available on a big textured ground plane.
 *
 * Capped at 8 rather than taking the driver's maximum (often 16): the extra
 * samples cost bandwidth on exactly the one surface that fills the whole screen,
 * and past 8 the difference at this angle is not visible. The actual value is
 * `min(8, driver max)`, so a device that only offers 2 still works.
 */
const MAX_ANISOTROPY = 8

/**
 * Load and configure every ground texture named by an already-fetched manifest.
 *
 * ALL OR NOTHING, AND EVERY FAILURE NAMES WHICH TEXTURE. There is no fallback to
 * the jungle for a missing water or bridge image: a river quietly drawn as
 * jungle floor is exactly the "looks plausible, is wrong" outcome the boot error
 * overlay exists to prevent, and it is the failure ticket 033 lived with. Three
 * textures is three ways to get this wrong, so the message says which one.
 *
 * The declaration is checked in FULL before a single byte is fetched. A manifest
 * missing `water` must fail on `water` whatever order `GROUND_SURFACES` happens
 * to be in, and it must fail without having gone to the network for `jungle`
 * first. That also keeps the validation half callable with no DOM at all, which
 * is what lets it be tested.
 *
 * `maxAnisotropy` comes from `renderer.capabilities.getMaxAnisotropy()`; the
 * caller passes it rather than this module reaching for a renderer, so the
 * function stays a pure "manifest in, textures out".
 */
export async function loadGroundTextures(
  manifest: SpriteManifest,
  manifestUrl: string,
  maxAnisotropy = 1,
): Promise<Record<GroundSurface, THREE.Texture>> {
  const ground = manifest.ground
  if (!ground) {
    throw new GroundTextureError(
      'The sprite manifest does not declare any ground textures.',
      'Expected a `ground` entry in the manifest — run `npm run build:models`.',
    )
  }

  // Pass one: the whole declaration, before any network work.
  const declared = {} as Record<GroundSurface, NonNullable<(typeof ground)[GroundSurface]>>
  for (const surface of GROUND_SURFACES) {
    const entry = ground[surface]
    if (!entry) {
      throw new GroundTextureError(
        `The sprite manifest does not declare the ${surface} ground texture.`,
        `Expected a \`ground.${surface}\` entry in the manifest — run \`npm run build:models\`.`,
      )
    }
    if (!entry.tileable) {
      // Not pedantry: a non-tiling image under `RepeatWrapping` puts a hard seam
      // on every repeat boundary — nine of them across level 1 — and that is the
      // failure that looks like a rendering bug rather than an asset one.
      throw new GroundTextureError(
        `The ${surface} ground texture is not marked as tileable, so it cannot be wrapped across the map.`,
        `manifest ground.${surface}.tileable was ${String(entry.tileable)}.`,
      )
    }
    declared[surface] = entry
  }

  const loaded = {} as Record<GroundSurface, THREE.Texture>
  // Pass two. Sequential rather than `Promise.all`: three small images off the
  // same origin are not worth the parallelism, and a serial loop makes the FIRST
  // failure the one reported instead of whichever lost the race.
  for (const surface of GROUND_SURFACES) {
    const entry = declared[surface]
    const url = resolveAssetUrl(entry.file, manifestUrl)
    let texture: THREE.Texture
    try {
      texture = await new THREE.TextureLoader().loadAsync(url)
    } catch (cause) {
      // `TextureLoader` rejects with a DOM `ErrorEvent`, not an `Error`, so
      // `String(cause)` is the useless "[object Event]". Name the URL instead —
      // it is the one thing that tells you whether the file is missing, misnamed,
      // or being served as an HTML 404 page.
      throw new GroundTextureError(
        `The ${surface} ground texture ${entry.file} could not be loaded.`,
        cause instanceof Error ? cause.message : `The image at ${url} did not load.`,
      )
    }

    configureFloorTexture(texture, maxAnisotropy)
    loaded[surface] = texture
  }
  return loaded
}

/**
 * Texture settings, each a decision rather than a default. Applied identically
 * to all three ground textures — they are the same kind of image doing the same
 * job, and a per-texture difference here would be a per-texture bug.
 *
 * - `RepeatWrapping` on BOTH axes. The UVs from `core/view/floor-uv` are world
 *   position over a repeat distance and are therefore unbounded and negative
 *   over half the map; the wrap mode is what folds them. `ClampToEdgeWrapping`
 *   (the default) would smear the texture's edge row across everything past the
 *   first repeat.
 * - `SRGBColorSpace`: painted artwork, not data. Left linear the floor renders
 *   washed out and pale against terrain that is correctly lit.
 * - `generateMipmaps` + `LinearMipmapLinearFilter`, following the atlas's
 *   precedent in `sprite-atlas.ts` and for a sharper version of the same reason.
 *   At maximum zoom-out one repeat — 512 texels over `FLOOR_REPEAT_WORLD_UNITS`
 *   world units — covers well under a hundred screen pixels, and unlike the
 *   sprites the floor covers EVERY pixel of the view. Halving the repeat to 3
 *   doubled that minification rather than easing it. A 2x2 bilinear kernel over
 *   a reduction that steep takes a handful of texels out of dozens and discards
 *   the rest, and which ones it takes changes as the camera moves: the whole map
 *   would crawl and sparkle for the entire length of a pan, which is this
 *   build's headline interaction. The chain costs 33% more texture memory on a
 *   512x512 image — under 350 KB — which is nothing.
 *   A seamless source has no bleed problem: the wrap is what the mip filter
 *   would blend into anyway.
 * - `LinearFilter` magnification: painted art at a non-integer on-screen size
 *   that changes with every zoom step. `NearestFilter` would stairstep.
 * - `flipY = false`, and this one is load-bearing rather than cosmetic. Three
 *   flips images on upload by default, putting the PNG's BOTTOM row at v = 0.
 *   `floorUv` maps world +z straight to +v, and world +z is screen-DOWN, so with
 *   the flip left on, walking down the screen walks UP the image and the whole
 *   floor renders vertically mirrored. On a seamless organic texture that is
 *   invisible as a seam and shows only as art that reads subtly wrong — leaves
 *   lit from the wrong side, stones with their shadows above them.
 *   The atlas takes the opposite decision for the same reason: it keeps the flip
 *   and compensates in its UVs, because its rects are addressed in PNG
 *   coordinates. Here the UVs come from world space, so removing the flip is the
 *   fix that keeps `floor-uv.ts` honest about what v means.
 */
export function configureFloorTexture(texture: THREE.Texture, maxAnisotropy = 1): void {
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.flipY = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = Math.max(1, Math.min(MAX_ANISOTROPY, maxAnisotropy))
  texture.needsUpdate = true
}
