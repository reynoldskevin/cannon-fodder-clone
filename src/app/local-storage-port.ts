/**
 * The real `PersistencePort`, over `window.localStorage` (ticket 019).
 *
 * IT LIVES IN `app/` BECAUSE `localStorage` IS A DOM GLOBAL. `core/campaign` is
 * engine-free, DOM-free and testable under plain Node, and a single storage call
 * in there would end all three at once — which is the entire reason the port is
 * an interface rather than a convenience wrapper. `core` is tested against an
 * in-memory fake; this file is the one place a browser store is touched, and
 * `src/app` has no tests precisely because there is no DOM under Node to run
 * them against.
 *
 * THE FAILURE MODE THAT CATCHES PEOPLE OUT: in Safari's private browsing (and
 * any browser with site data blocked) touching `window.localStorage` THROWS a
 * SecurityError before a key is ever named, and a full quota throws on the
 * write. Neither is exotic — the quota one arrives at a mission boundary, with
 * a squad the player just spent ten minutes on.
 *
 * NEITHER METHOD CATCHES, AND THAT IS THE DEGRADATION, NOT A GAP IN IT.
 * `loadCampaign` and `saveCampaign` already catch, and each turns the throw
 * into a `notice` the player can be shown; catching here as well would swallow
 * the failure twice and report a dropped save as a successful one — the exact
 * defect this file was rewritten to remove. What this port owes the game is
 * accuracy about which failure happened, and a swallowed error carries none.
 *
 * A read that fails must therefore NOT come back as `null` either: `null` is
 * the campaign loader's "first run", and it is SILENT. Telling a player in a
 * private window that they had never played, when their campaign is sitting
 * there unread, is precisely the silent loss this whole seam exists to prevent.
 * Letting the SecurityError through gets them the accurate notice instead.
 */

import type { PersistencePort } from '../core/campaign'

/**
 * The key everything is stored under. Namespaced because a browser origin is
 * shared with whatever else is served from it, and a bare `campaign` is exactly
 * the name a second thing would also choose.
 */
export const CAMPAIGN_STORAGE_KEY = 'game-week:campaign:v1'

/**
 * Read the store, or throw. Reached through a function rather than a module
 * constant on purpose: hoisting `window.localStorage` to module scope would
 * move the private-browsing throw to IMPORT time, where no `try` is around to
 * catch it and the failure becomes a blank page instead of a notice.
 */
function store(): Storage {
  return window.localStorage
}

/** A `PersistencePort` backed by `window.localStorage`. */
export function createLocalStoragePort(key: string = CAMPAIGN_STORAGE_KEY): PersistencePort {
  return {
    load(): unknown {
      // Both the property access and `getItem` can throw. Deliberately
      // unguarded — see the header: `loadCampaign` catches and reports.
      const raw = store().getItem(key)
      // `getItem` returns `null` for a key that was never written, which is the
      // "first run" the campaign loader treats as silence.
      if (raw === null) return null
      // Handed back as the STRING it is. `loadCampaign` parses and validates —
      // parsing here would move the decision about what a damaged document
      // means out of the layer that has a notice to report it with.
      return raw
    },

    save(state: unknown): void {
      // Unguarded for the same reason, and it matters more on this side:
      // `saveCampaign` reports `{ saved: false }` off this throw, and a `catch`
      // here would turn every dropped write into a reported success.
      store().setItem(key, JSON.stringify(state))
    },
  }
}
