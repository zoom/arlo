import { vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDynamicIndicator, COALESCE_MS, DID_MS } from './useDynamicIndicator';
import { INDICATOR_STYLES, INDICATOR_STRINGS } from '../lib/dynamicIndicator';
import { createIndicatorTimer, endTimerStoppedElsewhere } from '../lib/indicatorTimer';

const ACTIVE = { phase: 'active', startedHere: true, guest: false, voiceEnabled: false, voiceProcessing: false, thinking: false, waiting: false };
const fakeSdk = () => ({
  setDynamicIndicator: vi.fn(async () => ({ message: 'Success' })),
  removeDynamicIndicator: vi.fn(async () => ({ message: 'Success' })),
});
/** Let the coalescing time pass and every promise settle. */
const settle = async (ms = COALESCE_MS) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const mount = (props) => renderHook((given) => useDynamicIndicator(given), {
  initialProps: { supported: true, inputs: ACTIVE, did: null, timer: null, meetingKey: 'm-1', ...props },
});
const sets = (sdk) => sdk.setDynamicIndicator.mock.calls.map((call) => call[0]);

describe('useDynamicIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('sets the state\'s text, with its style when it has one, and removes the indicator when there is no state', async () => {
    const zoomSdk = fakeSdk();
    const { rerender } = mount({ zoomSdk });
    await settle();
    expect(sets(zoomSdk)).toEqual([{ text: 'Arlo is transcribing' }]);

    rerender({ zoomSdk, supported: true, inputs: { ...ACTIVE, thinking: true }, did: null, timer: null, meetingKey: 'm-1' });
    await settle();
    expect(sets(zoomSdk).at(-1)).toEqual({ text: 'Arlo is thinking…', ...INDICATOR_STYLES.thinking });

    rerender({ zoomSdk, supported: true, inputs: { ...ACTIVE, phase: 'paused' }, did: null, timer: null, meetingKey: 'm-1' });
    await settle();
    expect(sets(zoomSdk).at(-1)).toEqual({ text: 'Arlo is paused', ...INDICATOR_STYLES.paused });
    expect(zoomSdk.removeDynamicIndicator).not.toHaveBeenCalled();

    // the stream stopped: removed, as before
    rerender({ zoomSdk, supported: true, inputs: { ...ACTIVE, phase: 'stopped' }, did: null, timer: null, meetingKey: 'm-1' });
    await settle();
    expect(zoomSdk.removeDynamicIndicator).toHaveBeenCalledTimes(1);
    expect(zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(3);
  });

  test('no call when nothing changed, and changes within the coalescing time are one call', async () => {
    const zoomSdk = fakeSdk();
    const props = { zoomSdk, supported: true, did: null, timer: null, meetingKey: 'm-1' };
    const { rerender } = mount({ zoomSdk });
    await settle();
    // the same state again, as a new object
    rerender({ ...props, inputs: { ...ACTIVE } });
    rerender({ ...props, inputs: { ...ACTIVE, voiceProcessing: true } });
    await settle();
    expect(zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(1);

    // thinking on and off again within the time: nothing is sent
    rerender({ ...props, inputs: { ...ACTIVE, thinking: true } });
    await settle(COALESCE_MS - 50);
    rerender({ ...props, inputs: ACTIVE });
    await settle();
    expect(zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(1);

    // three changes in a row: the last one, once
    rerender({ ...props, inputs: { ...ACTIVE, thinking: true } });
    rerender({ ...props, inputs: { ...ACTIVE, waiting: true, thinking: true } });
    rerender({ ...props, inputs: { ...ACTIVE, phase: 'paused' } });
    await settle();
    expect(zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(2);
    expect(sets(zoomSdk).at(-1).text).toBe('Arlo is paused');

    // a stream that drops and is back within the time: neither removed nor set again
    rerender({ ...props, inputs: { ...ACTIVE, phase: 'interrupted' } });
    rerender({ ...props, inputs: { ...ACTIVE, phase: 'paused' } });
    await settle();
    expect(zoomSdk.removeDynamicIndicator).not.toHaveBeenCalled();
    expect(zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(2);
  });

  test('Zoom refuses a style: the same text is sent without one, and from then on text only', async () => {
    const zoomSdk = fakeSdk();
    zoomSdk.setDynamicIndicator.mockImplementation(async (options) => {
      if ('textColor' in options) throw Object.assign(new Error('invalid color'), { code: '10001' });
      return { message: 'Success' };
    });
    const props = { zoomSdk, supported: true, did: null, timer: null, meetingKey: 'm-1' };
    const { rerender } = mount({ zoomSdk, inputs: { ...ACTIVE, thinking: true } });
    await settle();
    expect(sets(zoomSdk)).toEqual([{ text: 'Arlo is thinking…', ...INDICATOR_STYLES.thinking }, { text: 'Arlo is thinking…' }]);

    rerender({ ...props, inputs: { ...ACTIVE, phase: 'paused' } });
    await settle();
    rerender({ ...props, inputs: { ...ACTIVE, waiting: true } });
    await settle();
    expect(sets(zoomSdk).slice(2)).toEqual([{ text: 'Arlo is paused' }, { text: 'Arlo is waiting for an OK' }]);
  });

  test('Zoom refuses a text without a style: logged and left, as before', async () => {
    const zoomSdk = fakeSdk();
    zoomSdk.setDynamicIndicator.mockRejectedValue(Object.assign(new Error('no'), { code: '10002' }));
    mount({ zoomSdk });
    await settle();
    expect(zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(1);
    // with a style: the one retry, and no more
    const styled = fakeSdk();
    styled.setDynamicIndicator.mockRejectedValue(new Error('no'));
    mount({ zoomSdk: styled, inputs: { ...ACTIVE, thinking: true } });
    await settle();
    await settle(5000);
    expect(styled.setDynamicIndicator).toHaveBeenCalledTimes(2);
  });

  test('what Arlo did is shown for four seconds, then the state before it', async () => {
    const zoomSdk = fakeSdk();
    const props = { zoomSdk, supported: true, inputs: ACTIVE, timer: null, meetingKey: 'm-1' };
    const { rerender } = mount({ zoomSdk });
    await settle();
    rerender({ ...props, did: { id: 'a-1', tool: 'post_to_chat' } });
    await settle();
    expect(sets(zoomSdk).at(-1)).toEqual({ text: 'Arlo posted to the chat', ...INDICATOR_STYLES.did });
    await settle(DID_MS - COALESCE_MS - 1);
    expect(zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(2);
    await settle(1);
    await settle();
    expect(sets(zoomSdk).at(-1)).toEqual({ text: 'Arlo is transcribing' });
    expect(zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(3);

    // the same action told again shows nothing again
    rerender({ ...props, did: { id: 'a-1', tool: 'post_to_chat' } });
    await settle();
    expect(zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(3);

    // a tool without a sentence shows nothing, and does not cut short the one that shows
    rerender({ ...props, did: { id: 'a-2', tool: 'share_notes' } });
    await settle();
    rerender({ ...props, did: { id: 'a-3', tool: 'send_reaction' } });
    await settle(1000);
    expect(sets(zoomSdk).at(-1).text).toBe('Arlo shared the notes');
    await settle(DID_MS);
    await settle();
    expect(sets(zoomSdk).at(-1).text).toBe('Arlo is transcribing');
  });

  test('what Arlo did is not kept for later: gone with the stream, and its timer with the panel', async () => {
    const zoomSdk = fakeSdk();
    const props = { zoomSdk, supported: true, timer: null, meetingKey: 'm-1' };
    const { rerender, unmount } = mount({ zoomSdk });
    await settle();
    rerender({ ...props, inputs: ACTIVE, did: { id: 'a-1', tool: 'post_to_chat' } });
    await settle();
    rerender({ ...props, inputs: { ...ACTIVE, phase: 'stopped' }, did: { id: 'a-1', tool: 'post_to_chat' } });
    await settle();
    rerender({ ...props, inputs: ACTIVE, did: { id: 'a-1', tool: 'post_to_chat' } });
    await settle();
    expect(sets(zoomSdk).at(-1).text).toBe('Arlo is transcribing');

    rerender({ ...props, inputs: ACTIVE, did: { id: 'a-2', tool: 'share_notes' } });
    await settle();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('nothing when the client did not accept the API; removed when the panel closes', async () => {
    const off = fakeSdk();
    mount({ zoomSdk: off, supported: false });
    await settle();
    expect(off.setDynamicIndicator).not.toHaveBeenCalled();

    const zoomSdk = fakeSdk();
    const { unmount } = mount({ zoomSdk });
    await settle();
    unmount();
    expect(zoomSdk.removeDynamicIndicator).toHaveBeenCalledTimes(1);
  });

  describe('while a timer this panel started runs', () => {
    const withTimer = async (inputs = ACTIVE) => {
      const zoomSdk = fakeSdk();
      const timer = createIndicatorTimer();
      const props = { zoomSdk, supported: true, did: null, timer, meetingKey: 'm-1' };
      const view = mount({ zoomSdk, timer, inputs });
      await settle();
      zoomSdk.setDynamicIndicator.mockClear();
      zoomSdk.removeDynamicIndicator.mockClear();
      return { zoomSdk, timer, props, ...view };
    };

    test('no status is sent, whatever changes; at its end the state of that moment is set', async () => {
      const { zoomSdk, timer, props, rerender } = await withTimer();
      timer.start(1);
      rerender({ ...props, inputs: { ...ACTIVE, thinking: true } });
      await settle();
      rerender({ ...props, inputs: { ...ACTIVE, phase: 'paused' } });
      await settle();
      rerender({ ...props, inputs: ACTIVE, did: { id: 'a-1', tool: 'post_to_chat' } });
      await settle(DID_MS + COALESCE_MS);
      rerender({ ...props, inputs: { ...ACTIVE, waiting: true } });
      await settle(30 * 1000);
      expect(zoomSdk.setDynamicIndicator).not.toHaveBeenCalled();
      expect(zoomSdk.removeDynamicIndicator).not.toHaveBeenCalled();

      await settle(60 * 1000);
      expect(timer.running()).toBe(false);
      expect(sets(zoomSdk)).toEqual([{ text: 'Arlo is waiting for an OK', ...INDICATOR_STYLES.waiting }]);
    });

    test('at its end the same state as before it is set again: Zoom shows the timer, not that state', async () => {
      const { zoomSdk, timer } = await withTimer();
      timer.start(1);
      await settle(2 * 60 * 1000);
      expect(sets(zoomSdk)).toEqual([{ text: 'Arlo is transcribing' }]);
      expect(zoomSdk.removeDynamicIndicator).not.toHaveBeenCalled();
    });

    test('stopped: the indicator was taken down, so the state is set again, and not removed twice', async () => {
      const { zoomSdk, timer } = await withTimer();
      timer.start(5);
      timer.end('stopped');
      await settle();
      expect(sets(zoomSdk)).toEqual([{ text: 'Arlo is transcribing' }]);
      expect(zoomSdk.removeDynamicIndicator).not.toHaveBeenCalled();
    });

    test('a panel that does not own the indicator: at the end it takes the timer down; after a stop there is nothing left to take down', async () => {
      const { zoomSdk, timer } = await withTimer({ ...ACTIVE, startedHere: false });
      timer.start(1);
      await settle(2 * 60 * 1000);
      expect(zoomSdk.setDynamicIndicator).not.toHaveBeenCalled();
      expect(zoomSdk.removeDynamicIndicator).toHaveBeenCalledTimes(1);

      timer.start(1);
      timer.end('stopped');
      await settle();
      expect(zoomSdk.removeDynamicIndicator).toHaveBeenCalledTimes(1);
    });

    test('the stream this panel started stops: the timer ends with it and the indicator is removed once', async () => {
      const { zoomSdk, timer, props, rerender } = await withTimer();
      timer.start(5);
      rerender({ ...props, inputs: { ...ACTIVE, phase: 'stopped' } });
      await settle();
      expect(timer.running()).toBe(false);
      expect(zoomSdk.removeDynamicIndicator).toHaveBeenCalledTimes(1);
      expect(zoomSdk.setDynamicIndicator).not.toHaveBeenCalled();
    });

    test('another meeting, or none: the timer ends; the panel closes: the indicator is removed', async () => {
      const first = await withTimer({ ...ACTIVE, startedHere: false });
      first.timer.start(5);
      first.rerender({ ...first.props, inputs: { ...ACTIVE, startedHere: false }, meetingKey: null });
      await settle();
      expect(first.timer.running()).toBe(false);
      expect(first.zoomSdk.removeDynamicIndicator).toHaveBeenCalledTimes(1);

      const second = await withTimer();
      second.timer.start(5);
      second.unmount();
      expect(second.timer.running()).toBe(false);
      expect(second.zoomSdk.removeDynamicIndicator).toHaveBeenCalledTimes(1);
      expect(second.zoomSdk.setDynamicIndicator).not.toHaveBeenCalled();
    });

    test('a style Zoom refuses while a timer starts is not sent again as text over the timer', async () => {
      const zoomSdk = fakeSdk();
      const timer = createIndicatorTimer();
      let refuse;
      zoomSdk.setDynamicIndicator.mockImplementation(() => new Promise((resolve, reject) => { refuse = reject; }));
      mount({ zoomSdk, timer, inputs: { ...ACTIVE, thinking: true } });
      await settle();
      expect(zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(1);
      timer.start(1);
      await act(async () => { refuse(new Error('no')); });
      await settle();
      expect(zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(1);
      // when the timer is over: the text, without a style
      zoomSdk.setDynamicIndicator.mockImplementation(async () => ({}));
      await settle(2 * 60 * 1000);
      expect(sets(zoomSdk).at(-1)).toEqual({ text: 'Arlo is thinking…' });
    });
  });

  describe('two owners\' panels and one timer', () => {
    const STOP_DONE = { id: 'act-stop', tool: 'stop_timer', status: 'done' };
    /** Panel A started the stream (it keeps Arlo's status); panel B is another owner's. Each has its own record and its own Zoom client. */
    const twoPanels = async () => {
      const a = { zoomSdk: fakeSdk(), timer: createIndicatorTimer() };
      const b = { zoomSdk: fakeSdk(), timer: createIndicatorTimer() };
      a.view = mount({ zoomSdk: a.zoomSdk, timer: a.timer, inputs: ACTIVE });
      b.view = mount({ zoomSdk: b.zoomSdk, timer: b.timer, inputs: { ...ACTIVE, startedHere: false } });
      await settle();
      for (const panel of [a, b]) {
        panel.zoomSdk.setDynamicIndicator.mockClear();
        panel.zoomSdk.removeDynamicIndicator.mockClear();
      }
      return { a, b };
    };
    /** What the panel that runs "stop the timer" does (lib/arloActions.js): the indicator comes down, its record is told. */
    const stopsOn = (panel) => {
      panel.zoomSdk.removeDynamicIndicator();
      panel.timer.end('stopped');
    };
    /** Every owner's panel is told the action ended (`arlo.did`). */
    const tellBoth = ({ a, b }, action = STOP_DONE) => [a, b].map((panel) => endTimerStoppedElsewhere(panel.timer, action));

    test('A started the timer, B stops it: A\'s record ends and A sets the status again, at once and not at the timer\'s end', async () => {
      const panels = await twoPanels();
      const { a, b } = panels;
      a.timer.start(30);
      stopsOn(b);
      expect(a.timer.running()).toBe(true);
      expect(tellBoth(panels)).toEqual([true, false]);
      await settle();
      expect(a.timer.running()).toBe(false);
      expect(sets(a.zoomSdk)).toEqual([{ text: 'Arlo is transcribing' }]);
      expect(a.zoomSdk.removeDynamicIndicator).not.toHaveBeenCalled();
      // B has no status of its own: it removed the indicator once, and sets nothing
      expect(b.zoomSdk.removeDynamicIndicator).toHaveBeenCalledTimes(1);
      expect(b.zoomSdk.setDynamicIndicator).not.toHaveBeenCalled();
      // and nothing more happens when A's timer would have run out
      await settle(31 * 60 * 1000);
      expect(a.zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(1);
    });

    test('the same text as before the timer is sent again: the memo of what was shown is reset by the stop', async () => {
      const panels = await twoPanels();
      const { a, b } = panels;
      b.timer.start(5); // B's timer covers A's status on Zoom's indicator; A never knew
      stopsOn(b);
      tellBoth(panels);
      await settle();
      expect(sets(a.zoomSdk)).toEqual([{ text: 'Arlo is transcribing' }]);
      expect(b.timer.running()).toBe(false);
    });

    test('A stops its own timer: its status is set once, not again when the report of that stop arrives', async () => {
      const panels = await twoPanels();
      const { a, b } = panels;
      a.timer.start(5);
      stopsOn(a);
      await settle();
      expect(sets(a.zoomSdk)).toEqual([{ text: 'Arlo is transcribing' }]);
      expect(tellBoth(panels)).toEqual([false, true]);
      await settle();
      expect(a.zoomSdk.setDynamicIndicator).toHaveBeenCalledTimes(1);
      expect(a.zoomSdk.removeDynamicIndicator).toHaveBeenCalledTimes(1);
      expect(b.zoomSdk.removeDynamicIndicator).not.toHaveBeenCalled();
      expect(b.zoomSdk.setDynamicIndicator).not.toHaveBeenCalled();
    });

    test('a stop that was not done changes nothing on either panel', async () => {
      const panels = await twoPanels();
      const { a, b } = panels;
      a.timer.start(5);
      for (const status of ['failed', 'declined', 'expired', 'waiting_approval']) tellBoth(panels, { ...STOP_DONE, status });
      await settle();
      expect(a.timer.running()).toBe(true);
      for (const panel of [a, b]) {
        expect(panel.zoomSdk.setDynamicIndicator).not.toHaveBeenCalled();
        expect(panel.zoomSdk.removeDynamicIndicator).not.toHaveBeenCalled();
      }
    });
  });

  test('every text this hook ever sends is one of the fixed sentences', async () => {
    const zoomSdk = fakeSdk();
    const props = { zoomSdk, supported: true, timer: null, meetingKey: 'm-1' };
    const { rerender } = mount({ zoomSdk });
    const hostile = [
      { inputs: { ...ACTIVE, thinking: true, step: 'Muting Danny Reyes', askedBy: 'Danny Reyes' }, did: null },
      { inputs: ACTIVE, did: { id: 'a-1', tool: 'mute_participant', label: 'Muted Danny Reyes', askedBy: 'Priya' } },
      { inputs: ACTIVE, did: { id: 'a-2', tool: 'Muted Danny Reyes' } },
      { inputs: { ...ACTIVE, waiting: true, question: 'Admit Danny Reyes?' }, did: null },
      { inputs: ACTIVE, did: { id: 'a-3', tool: 'open_ticket', label: 'Opened PROJ-123' } },
      { inputs: { ...ACTIVE, phase: 'paused', text: 'Buy now' }, did: null },
    ];
    for (const given of hostile) {
      rerender({ ...props, ...given });
      await settle();
      await settle(DID_MS);
      await settle();
    }
    expect(zoomSdk.setDynamicIndicator.mock.calls.length).toBeGreaterThan(5);
    for (const options of sets(zoomSdk)) {
      expect(INDICATOR_STRINGS.has(options.text)).toBe(true);
      expect(JSON.stringify(options)).not.toMatch(/Danny|Priya|PROJ|Buy|Admit/);
    }
  });
});
