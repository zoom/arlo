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

  const end = (reason) => {
    if (handle !== null) clearTimeout(handle);
    handle = null;
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
      handle = setTimeout(() => {
        handle = null;
        end('expired');
      }, minutes * 60 * 1000 + INDICATOR_GUESSES.timerEndGraceMs);
      return true;
    },
    end,
    running: () => handle !== null,
    onEnd(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** This panel's timer: the action that starts one and the hook that keeps the status share it. */
export const indicatorTimer = createIndicatorTimer();
