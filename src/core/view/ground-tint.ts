/**
 * What a tile's vertex colour has to BE, once three different ground textures
 * can sit under it (ticket 034; the jungle maths is ticket 009c's, moved here).
 *
 * The terrain material computes `texture * vertexColour`, so the vertex colour
 * was never "the colour of the tile" — it is "what this texture must be
 * multiplied by to LOOK like that tile". With one texture that distinction was
 * academic. With three it is the whole point, because the multiplier depends on
 * which image is underneath.
 *
 * It lives in `core/view` rather than in `src/render` for the reason
 * `ground-surface` gives: this is a decision, not plumbing, and `core` is the
 * engine-free layer where the simulation can read it as well as the renderer.
 * Engine-free on purpose — `THREE.Color` is three channels of float and
 * `LinearRgb` says so without the dependency.
 */

import type { GroundSurface } from './ground-surface'

/** Three linear-space channels. Values above 1 are legal — this is a multiplier, not a colour. */
export interface LinearRgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** Rec. 709 luminance — the same weighting three uses internally. */
export function linearLuminance(c: LinearRgb): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

/**
 * Mean colour of each ground texture in LINEAR space, measured off the source
 * art with:
 *
 *     node -e "const {PNG}=require('pngjs'),fs=require('fs');
 *       const p=PNG.sync.read(fs.readFileSync('assets/source/sprites/water.png'));
 *       const lin=v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4};
 *       let a=[0,0,0];for(let i=0;i<p.data.length;i+=4)for(let c=0;c<3;c++)a[c]+=lin(p.data[i+c]);
 *       console.log(a.map(v=>(v/(p.width*p.height)).toFixed(4)))"
 *
 * Measured off the SOURCE art rather than the emitted half-size file. The build's
 * halving averages exact 2x2 blocks but does so in GAMMA bytes, so the linear
 * mean does not survive it as an identity: the source water above emits as
 * 0.0680, 0.1664, 0.1158, a drift of about 0.3%. Immaterial at the scale these
 * feed — a gain divided by a luminance — but it is a drift, not a no-op.
 *
 * IT HAS TO BE PER TEXTURE, and that is the failure mode this ticket exists to
 * prevent. Water and the bridge are both over twice the jungle's luminance, so a
 * gain computed against the jungle's mean renders them badly hot — and it
 * presents as a lighting bug rather than as the lookup bug it is.
 *
 * THE JUNGLE ENTRY IS 009c'S COMMITTED CONSTANT, NOT A FRESH MEASUREMENT. It is
 * the number the whole of that ticket's tint maths was tuned against; re-deriving
 * it slightly differently would shift the brightness of every grass, canopy and
 * rock tile in the game while looking like a no-op. (The one-liner above puts the
 * jungle at 0.0695, 0.0646, 0.0093 — which matches the committed constants to
 * three places only if you TRUNCATE. Rounded, 0.0695 and 0.0646 go to 0.070 and
 * 0.065 where 0.0693 and 0.0642 go to 0.069 and 0.064. The agreement is to about
 * a third of a percent, not to three decimal places.)
 *
 * Hardcoded rather than measured at runtime: reading them back from the GPU would
 * mean a canvas round trip on boot to recover constants that only change when the
 * art does.
 */
export const GROUND_MEAN_LINEAR: Readonly<Record<GroundSurface, LinearRgb>> = {
  jungle: { r: 0.0693, g: 0.0642, b: 0.0093 },
  water: { r: 0.0678, g: 0.1661, b: 0.1155 },
  bridge: { r: 0.3281, g: 0.1336, b: 0.0433 },
}

/**
 * How much of a tile's own HUE is pushed onto the JUNGLE floor texture, 0..1.
 *
 * 0 leaves the texture's own colour alone and only matches its brightness to the
 * tile; 1 forces the tile's average colour to equal ticket 009's flat colour
 * exactly. 1 is wrong here: the floor's blue channel is nearly empty (0.009
 * linear), so an exact match needs an 8x blue gain, and that turns every grey
 * pebble in the art violet and drains the greens.
 *
 * 0.35 is the compromise that shipped. It is enough that canopy tiles pull the
 * floor visibly greener and deeper, and that rock tiles pull it paler and
 * greyer, while the ferns and leaf litter keep their painted colour on all of
 * them. Below about 0.2 the terrain types stop separating by hue and rely on
 * brightness alone; above about 0.5 the rock tiles go grey enough that the
 * jungle art stops reading as jungle on them.
 *
 * IT APPLIES TO THE JUNGLE ALONE. See `groundTint`.
 */
export const TINT_HUE_STRENGTH = 0.35

/**
 * What fraction of ticket 009's flat albedo the textured ground reproduces.
 *
 * 1.0 makes the texture's MEAN colour equal the old flat colour exactly — which
 * sounds like the obviously correct answer and is not. The floor has a wide
 * dynamic range (deep soil against sunlit fronds) where the flat colour had
 * none, so a gain that lifts its mean to 0.288 linear takes the fronds to about
 * 1.9 before the sun is even applied. Everything above white clips, the greens
 * flatten into a pale yellow wash, and the map stops looking like jungle floor
 * and starts looking like straw. That is exactly what 1.0 rendered.
 *
 * 0.5 is the value that keeps the fronds inside the range once the sun and the
 * hemisphere fill are applied, so the floor arrives on screen looking like the
 * art it was painted as: deep soil, mossy green, orange leaf litter. It costs
 * half a stop of overall map brightness against ticket 009, which is a fair
 * trade and arguably an improvement — the old map was a bright green that no
 * jungle floor is.
 *
 * It is applied to the SKIRTS as well, so the tops/sides relationship is
 * untouched by it.
 */
export const TINT_EXPOSURE = 0.5

/**
 * The tint a tile's flat colour becomes once its ground texture is multiplied in.
 *
 * Both branches share one invariant, and it is what preserves ticket 009's
 * brightness hierarchy BY CONSTRUCTION rather than by eye: texture mean times
 * tint has the tile's own luminance scaled by `TINT_EXPOSURE`. Canopy stays
 * darker than grass, and a water tile stays darker than the bank beside it
 * because its STYLE colour is darker — not because its texture happens to be.
 *
 * THE JUNGLE ALSO TAKES A HUE PUSH. Grass, canopy and rock are three terrains on
 * ONE image, and the per-channel correction — mixed in at `TINT_HUE_STRENGTH`,
 * then renormalised because mixing preserves hue direction but not luminance
 * exactly — is the only thing separating them by colour.
 *
 * WATER AND THE BRIDGE TAKE THE SCALAR GAIN AND NOTHING ELSE. They have their own
 * art, so pushing `#4d86b5` onto water is insisting on a blue the texture already
 * is; and 009c measured what a hue push does at full strength — it drains the
 * painted highlights. Equal on all three channels is therefore the decision, not
 * an omission.
 *
 * Values above 1 are expected and fine: this is a linear float multiplier, not a
 * colour, and it is only clamped at output.
 */
export function groundTint(surface: GroundSurface, tile: LinearRgb): LinearRgb {
  const tileLuminance = linearLuminance(tile)
  // A tile whose style colour is black has zero luminance, and the gain is a
  // division by it. Black in, black out — never a NaN on screen.
  if (tileLuminance <= 0) return { r: 0, g: 0, b: 0 }

  const mean = GROUND_MEAN_LINEAR[surface]
  const meanLuminance = linearLuminance(mean)
  const target = tileLuminance * TINT_EXPOSURE
  const gain = target / meanLuminance

  if (surface !== 'jungle') return { r: gain, g: gain, b: gain }

  const mix = (channel: number, meanChannel: number): number => {
    // Both normalised to luminance 1 first, so this is hue and nothing else.
    const correction = channel / tileLuminance / (meanChannel / meanLuminance)
    return 1 - TINT_HUE_STRENGTH + TINT_HUE_STRENGTH * correction
  }

  const r = gain * mix(tile.r, mean.r)
  const g = gain * mix(tile.g, mean.g)
  const b = gain * mix(tile.b, mean.b)

  // Renormalise: `mix` preserves hue direction but not luminance exactly.
  const achieved = linearLuminance({ r: r * mean.r, g: g * mean.g, b: b * mean.b })
  if (!(achieved > 0)) return { r, g, b }
  const k = target / achieved
  return { r: r * k, g: g * k, b: b * k }
}
