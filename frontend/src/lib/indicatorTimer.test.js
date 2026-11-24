import { vi } from 'vitest';
import { createIndicatorTimer, isTimerMinutes, indicatorTimer } from './indicatorTimer';
import { INDICATOR_GUESSES } from './dynamicIndicator';

const GRACE = INDICATOR_GUESSES.timerEndGraceMs;

describe('the timer a panel started on Zoom\'s indicator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('whole minutes from 1 to 120, and nothing else', () => {
    for (const minutes of [1, 5, 120]) expect(isTimerMinutes(minutes)).toBe(true);
    for (const minutes of [0, -1, 121, 5.5, '5', NaN, Infinity, null, undefined, true, [5], {}]) expect(isTimerMinutes(minutes)).toBe(false);
  });

  test('runs from its start to its end time, then says it expired, once', () => {
    const timer = createIndicatorTimer();
    const ended = vi.fn();
    timer.onEnd(ended);
    expect(timer.running()).toBe(false);
    expect(timer.start(5)).toBe(true);
    expect(timer.running()).toBe(true);
    vi.advanceTimersByTime(5 * 60 * 1000 + GRACE - 1);
    expect(timer.running()).toBe(true);
    expect(ended).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timer.running()).toBe(false);
    expect(ended.mock.calls).toEqual([['expired']]);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  test('a length that is not one starts nothing', () => {
    const timer = createIndicatorTimer();
    for (const minutes of [0, 121, 5.5, '5', null]) expect(timer.start(minutes)).toBe(false);
    expect(timer.running()).toBe(false);
    vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    expect(timer.running()).toBe(false);
  });

  test('ended before its time: the reason is passed on, and the end time does not fire later', () => {
    const timer = createIndicatorTimer();
    const ended = vi.fn();
    timer.onEnd(ended);
    timer.start(5);
    timer.end('stopped');
    expect(timer.running()).toBe(false);
    expect(ended.mock.calls).toEqual([['stopped']]);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  test('an end is told also when no timer of this panel runs: the indicator was taken down all the same', () => {
    const timer = createIndicatorTimer();
    const ended = vi.fn();
    timer.onEnd(ended);
    timer.end('stopped');
    expect(ended.mock.calls).toEqual([['stopped']]);
  });

  test('a new timer replaces the one that runs, without an end in between', () => {
    const timer = createIndicatorTimer();
    const ended = vi.fn();
    timer.onEnd(ended);
    timer.start(1);
    vi.advanceTimersByTime(30 * 1000);
    timer.start(2);
    vi.advanceTimersByTime(60 * 1000 + GRACE);
    expect(timer.running()).toBe(true);
    expect(ended).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60 * 1000);
    expect(ended.mock.calls).toEqual([['expired']]);
  });

  test('a listener that left is not told, and one that throws does not stop the others', () => {
    const timer = createIndicatorTimer();
    const gone = vi.fn();
    const stays = vi.fn();
    timer.onEnd(gone)();
    timer.onEnd(() => { throw new Error('x'); });
    timer.onEnd(stays);
    timer.start(1);
    timer.end('stream');
    expect(gone).not.toHaveBeenCalled();
    expect(stays.mock.calls).toEqual([['stream']]);
  });

  test('the panel has one', () => {
    expect(typeof indicatorTimer.start).toBe('function');
    expect(indicatorTimer.running()).toBe(false);
  });
});
