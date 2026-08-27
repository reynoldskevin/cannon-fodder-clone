/**
 * THE PAUSE BETWEEN THE LAST SHOT AND THE NEXT SCREEN (ticket 058).
 *
 * A mission used to end on the frame it was decided. `objectives.outcome()` is
 * latched, so the first frame it stops reading `playing` is the frame `main.ts`
 * calls `endMission`, records the mission against the campaign, and lets the
 * router put Boot Hill or the Briefing up. Total elapsed time between the
 * deciding event and the field disappearing: one frame.
 *
 * WHICH MADE THE VICTORY AND DEFEAT CUES PLAY UNDER THE WRONG SCREEN. `main.ts`
 * exempts exactly those two cues from the `onMission` gate — a deliberate
 * exception, written because they land on the very frame the mission ends and
 * would otherwise be swallowed. They survived, and then played over a memorial.
 * The sound belonged to the field and the field was already gone.
 *
 * SO THE MISSION HOLDS. Three seconds on the live view with MISSION COMPLETE or
 * MISSION FAILED across it, and then the screen changes.
 *
 * TIME IS A PARAMETER AND NEVER A READING. Nothing here calls `Date.now` or
 * `performance.now`; every method that cares is handed `now`. That is what keeps
 * this in `core` — where the rule is testable — and it is also why `main.ts` can
 * drive the hold off the render loop's own `elapsed` instead of a `setTimeout`,
 * which would go on running after a teardown and fire into a disposed scene.
 *
 * IT DRAWS NOTHING AND KNOWS NOTHING ABOUT THE DOM. `src/ui/mission-banner.ts`
 * is the picture; this is the policy. Same split as `fx.ts` and `fx-renderer.ts`
 * next door.
 */

/**
 * A mission that is over, which is the only kind that gets a banner.
 *
 * NOT `MissionOutcome`, which also spells `'playing'`. `begin('playing', now)`
 * is not a thing that should typecheck — there is no banner for a mission that
 * is still being fought, and a hold that could be started with one would be a
 * hold that could put an empty string across the screen. `main.ts` narrows at
 * its guard, which it was already doing to decide whether to end at all.
 */
export type DecidedOutcome = 'complete' | 'failed'

/**
 * How long the field stays up after the mission is decided.
 *
 * THREE SECONDS, AND IT IS A REQUIREMENT RATHER THAN A TASTE. Long enough to
 * hear the cue out and watch the last man fall; short enough that a player who
 * has already read the words is not kept from Boot Hill.
 */
export const MISSION_END_HOLD_SECONDS = 3

/** The words that go across the screen. */
export function bannerFor(outcome: DecidedOutcome): string {
  return outcome === 'complete' ? 'MISSION COMPLETE' : 'MISSION FAILED'
}

/**
 * The latch.
 *
 * FOUR METHODS AND EACH ANSWERS ONE QUESTION, because the caller is a render
 * loop and every one of these is asked on every frame of the hold. In
 * particular `elapsed` is a QUERY and does not fire anything — `done` is the
 * caller saying it has acted, and until it does, `elapsed` goes on answering
 * `true` rather than being a one-shot that the caller could miss.
 */
export interface MissionEndHold {
  /**
   * Start holding.
   *
   * IDEMPOTENT, AND THAT IS LOAD-BEARING RATHER THAN DEFENSIVE. `main.ts` calls
   * this from inside the render loop on every frame where the outcome is
   * decided and the runner is still on the mission — which is every frame of the
   * hold, by construction. A `begin` that reset the start would push the finish
   * line forward by one frame per frame and the mission would never end.
   */
  begin(outcome: DecidedOutcome, now: number): void
  /** The words to show right now, or `null` if there is nothing to show. */
  banner(): string | null
  /** Has the hold run its course? `false` if it never started, or is finished. */
  elapsed(now: number): boolean
  /** The caller has made the transition. Takes the banner down and resets. */
  done(): void
}

export function createMissionEndHold(): MissionEndHold {
  /**
   * `null` UNTIL A MISSION IS DECIDED, rather than a start of 0 and a separate
   * flag. A hold that defaulted `startedAt` to 0 and answered
   * `now - startedAt >= 3` would report itself elapsed from three seconds into
   * EVERY mission, decided or not — which is to say it would end them all.
   */
  let held: { readonly outcome: DecidedOutcome; readonly startedAt: number } | null = null

  return {
    begin(outcome, now) {
      // First outcome wins. See the interface: this is called every frame.
      if (held !== null) return
      held = { outcome, startedAt: now }
    },
    banner() {
      return held === null ? null : bannerFor(held.outcome)
    },
    elapsed(now) {
      return held !== null && now - held.startedAt >= MISSION_END_HOLD_SECONDS
    },
    done() {
      // A RESET, NOT A TOMBSTONE. One session is built per mission, but a hold
      // that could only fire once would leave the next mission cutting
      // instantly if this ever outlived one — and clearing costs nothing.
      held = null
    },
  }
}
