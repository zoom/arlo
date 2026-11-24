import { INDICATOR_GUESSES } from './dynamicIndicator';

/**
 * The countdown this panel started on Zoom's Dynamic Indicator ("Arlo, set a
 * five minute timer"), as far as the panel can know it: Zoom runs the
 * countdown and tells nobody when it is over, so the panel keeps the end time
 * itself.
 *
 * Why it is kept: a status text sent while a timer runs may cancel the timer
 * (not documented, not tried). So while running() is true the hook that keeps
 * Arlo's status on the indicator (hooks/useDynamicIndicator.js) sends
 * nothing, and when the timer is over it is told (onEnd) and puts the status
 * back, or takes the indicator down when this panel has no status to show.
 *
 *   start(minutes)  a timer of this panel runs from now for that long (plus a
 *                   moment, INDICATOR_GUESSES.timerEndGraceMs). Replaces one
 *                   that runs. false for a length that is not one
 *   end(reason)     it is over, and every listener is told why:
 *                     'expired'  its time is up
 *                     'stopped'  someone asked to stop it, and the indicator
 *                                was taken down already
 *                     'failed'   Zoom refused to start it
 *                     'stream'   the stream this panel started stopped
 *                     'meeting'  the panel is in another meeting, or in none
 *                     'closed'   the panel is closing
 *                   Told also when none runs here: after a "stop the timer"
 *                   the indicator is gone whoever's timer it was
 *   running()       whether a timer of this panel runs now
 *   onEnd(fn)       → a function that stops listening
 *
 * A timer is the meeting's, and any owner's panel can stop it: the panel that
 * did calls end('stopped') itself; every other owner's panel learns of it
 * from `arlo.did` and ends its own record the same way
 * (endTimerStoppedElsewhere). Without that, the panel that keeps Arlo's status
 * would stay silent until its own record ran out.
 *
 * In memory only: a panel that reloads no longer knows of its timer, and its
 * next status may then end the countdown early.
 */
const MIN_MINUTES = 1;
const MAX_MINUTES = 120;

/** Whether this is a timer's length: whole minutes, from one to two hours (the server's rule too). */
export const isTimerMinutes = (value) => Number.isInteger(value) && value >= MIN_MINUTES && value <= MAX_MINUTES;

export function createIndicatorTimer() {
  let handle = null;
  const listeners = new Set();

  // When end('stopped') was last told, by this record's own clock
  let stoppedAt = null;
  const end = (reason) => {
    if (handle !== null) clearTimeout(handle);
    handle = null;
    stoppedAt = reason === 'stopped' ? Date.now() : null;
    [...listeners].forEach((listener) => {
      try {
        listener(reason);
      } catch {
        // one listener's trouble is not the others'
      }
    });
  };

  return {
    start(minutes) {
      if (!isTimerMinutes(minutes)) return false;
      if (handle !== null) clearTimeout(handle);
      stoppedAt = null;
      handle = setTimeout(() => {
        handle = null;
        end('expired');
      }, minutes * 60 * 1000 + INDICATOR_GUESSES.timerEndGraceMs);
      return true;
    },
    end,
    running: () => handle !== null,
    /**
     * Whether a stop was told here within the last `withinMs` and no timer was
     * started since. Answered true once per stop: the next question is about
     * another one.
     */
    takeOwnStop(withinMs) {
      const recent = stoppedAt !== null && Date.now() - stoppedAt <= withinMs;
      stoppedAt = null;
      return recent;
    },
    onEnd(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

// The report of a stop this panel did itself comes back within this time
const OWN_STOP_ECHO_MS = 30 * 1000;

/**
 * An action that ended, as `arlo.did` tells an owner's panel. When it is a
 * "stop the timer" that was done, the indicator was taken down by whoever
 * stopped it: this panel's record ends as 'stopped', and the hook that keeps
 * the status sets it again (or knows there is nothing left to take down).
 * Not a second time for the stop this panel just did itself. true when the
 * record was told.
 */
export function endTimerStoppedElsewhere(timer, action) {
  if (action === null || typeof action !== 'object' || action.tool !== 'stop_timer' || action.status !== 'done') return false;
  if (timer === null || typeof timer !== 'object' || typeof timer.end !== 'function') return false;
  if (!timer.running() && typeof timer.takeOwnStop === 'function' && timer.takeOwnStop(OWN_STOP_ECHO_MS)) return false;
  timer.end('stopped');
  return true;
}

/** This panel's timer: the action that starts one and the hook that keeps the status share it. */
export const indicatorTimer = createIndicatorTimer();
