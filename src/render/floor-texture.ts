/**
 * The tileable jungle floor texture (ticket 009c).
 *
 * `tools/spritegen` has emitted `floor.png` — 512x512, seamless — since ticket
 * 004 and kept it OUT of the atlas on purpose: `RepeatWrapping` wraps a whole
 * texture, so the one image that has to tile cannot be a rect inside a packed
 * sheet. This module is the other half of that decision.
 *
 * It is a separate file from `sprite-atlas.ts` because it answers to a different
 * consumer (the terrain, not the entities) and because `UnitVisual` is an
 * interface with a stub implementation in tests — widening it to carry a floor
 * texture would have forced every stub to invent one.
 */

import * as THREE from 'three'
import { resolveAssetUrl, type SpriteManifest } from './sprite-atlas'

/** A failure loading the floor texture, phrased for the boot error overlay. */
export class FloorTextureError extends Error {
  constructor(
    readonly detail: string,
    readonly technical: string,
  ) {
    super(`${detail} (${technical})`)
    this.name = 'FloorTextureError'
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
 * Load and configure the floor texture named by an already-fetched manifest.
 *
 * `maxAnisotropy` comes from `renderer.capabilities.getMaxAnisotropy()`; the
 * caller passes it rather than this module reaching for a renderer, so the
 * function stays a pure "manifest in, texture out".
 */
export async function loadFloorTexture(
  manifest: SpriteManifest,
  manifestUrl: string,
  maxAnisotropy = 1,
): Promise<THREE.Texture> {
  const floor = manifest.floor
  if (!floor) {
    throw new FloorTextureError(
      'The sprite manifest does not declare a jungle floor texture.',
      'Expected a `floor` entry in the manifest — run `npm run build:models`.',
    )
  }
  if (!floor.tileable) {
    // Not pedantry: a non-tiling image under `RepeatWrapping` puts a hard seam
    // on every repeat boundary — nine of them across level 1 — and that is the
    // failure that looks like a rendering bug rather than an asset one.
    throw new FloorTextureError(
      'The jungle floor texture is not marked as tileable, so it cannot be wrapped across the map.',
      `manifest floor.tileable was ${String(floor.tileable)}.`,
    )
  }

  const url = resolveAssetUrl(floor.file, manifestUrl)
  let texture: THREE.Texture
  try {
    texture = await new THREE.TextureLoader().loadAsync(url)
  } catch (cause) {
    // `TextureLoader` rejects with a DOM `ErrorEvent`, not an `Error`, so
    // `String(cause)` is the useless "[object Event]". Name the URL instead —
    // it is the one thing that tells you whether the file is missing, misnamed,
    // or being served as an HTML 404 page.
    throw new FloorTextureError(
      `The jungle floor texture ${floor.file} could not be loaded.`,
      cause instanceof Error ? cause.message : `The image at ${url} did not load.`,
    )
  }

  configureFloorTexture(texture, maxAnisotropy)
  return texture
}

/**
 * Texture settings, each a decision rather than a default.
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
 *   At maximum zoom-out a 6-world-unit repeat — 512 texels — covers roughly 60
 *   screen pixels, an 8x minification, and unlike the sprites the floor covers
 *   EVERY pixel of the view. A 2x2 bilinear kernel over an 8x reduction takes 4
 *   texels out of 64 and discards the rest, and which 4 changes as the camera
 *   moves: the whole map would crawl and sparkle for the entire length of a pan,
 *   which is this build's headline interaction. The chain costs 33% more texture
 *   memory on a 512x512 image — under 350 KB — which is nothing.
 *   A seamless source has no bleed problem: the wrap is what the mip filter
 *   would blend into anyway.
 * - `LinearFilter` magnification: painted art at a non-integer on-screen size
 *   that changes with every zoom step. `NearestFilter` would stairstep.
 */
export function configureFloorTexture(texture: THREE.Texture, maxAnisotropy = 1): void {
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = Math.max(1, Math.min(MAX_ANISOTROPY, maxAnisotropy))
  texture.needsUpdate = true
}
