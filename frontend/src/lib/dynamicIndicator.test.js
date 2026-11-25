import {
  indicatorText, indicatorState, INDICATOR_TEXT, INDICATOR_STYLES, DID_TEXT, INDICATOR_STRINGS, INDICATOR_GUESSES,
} from './dynamicIndicator';

const base = { phase: 'active', startedHere: true, guest: false, voiceEnabled: false, voiceProcessing: false };
const text = (overrides) => indicatorText({ ...base, ...overrides });

describe('indicatorText', () => {
  test('confirmed transcription started here: "Arlo is transcribing"', () => {
    expect(text({})).toBe('Arlo is transcribing');
  });

  test('with voice commands on, it also says how to call Arlo', () => {
    expect(text({ voiceEnabled: true })).toBe(INDICATOR_TEXT.listening);
    expect(INDICATOR_TEXT.listening).toContain('Say "Hey Arlo"');
  });

  test('while a voice command is processed: "Arlo is thinking…"', () => {
    expect(text({ voiceEnabled: true, voiceProcessing: true })).toBe('Arlo is thinking…');
    expect(text({ voiceEnabled: false, voiceProcessing: true })).toBe('Arlo is transcribing');
  });

  test('nothing unless transcription is confirmed', () => {
    for (const phase of ['idle', 'requested', 'starting', 'stalled', 'interrupted', 'stopped', 'failed', 'denied', 'expired']) {
      expect(text({ phase })).toBeNull();
      // the server's word about a pause does not bring an indicator back
      expect(text({ phase, pausedOnServer: true })).toBeNull();
    }
  });

  test('while this user\'s stream is paused: "Arlo is paused", whoever says so', () => {
    expect(INDICATOR_TEXT.paused).toBe('Arlo is paused');
    expect(text({ phase: 'paused' })).toBe('Arlo is paused');
    // paused with Zoom's own controls: this panel still thinks it runs, the server knows
    expect(text({ phase: 'active', pausedOnServer: true })).toBe('Arlo is paused');
    // voice commands do not change that
    expect(text({ phase: 'paused', voiceEnabled: true, voiceProcessing: true })).toBe('Arlo is paused');
    expect(text({ phase: 'active', pausedOnServer: true, voiceEnabled: true })).toBe('Arlo is paused');
  });

  test('resumed: the transcribing text again', () => {
    expect(text({ phase: 'active', pausedOnServer: false })).toBe('Arlo is transcribing');
  });

  test('a paused stream this panel did not start, or a guest\'s panel: nothing', () => {
    expect(text({ phase: 'paused', startedHere: false })).toBeNull();
    expect(text({ phase: 'active', pausedOnServer: true, startedHere: false })).toBeNull();
    expect(text({ phase: 'paused', guest: true })).toBeNull();
  });

  test('nothing from a panel that did not start the stream, or from a guest', () => {
    expect(text({ startedHere: false })).toBeNull();
    expect(text({ guest: true })).toBeNull();
  });

  test('while Arlo handles a request (the server says so): "Arlo is thinking…", voice commands or not', () => {
    expect(text({ thinking: true })).toBe('Arlo is thinking…');
    expect(text({ thinking: true, voiceEnabled: true })).toBe('Arlo is thinking…');
    expect(text({ thinking: false })).toBe('Arlo is transcribing');
    expect(text({ thinking: 'yes' })).toBe('Arlo is transcribing');
  });

  test('thinking changes nothing about who sets the indicator, or when; paused wins', () => {
    expect(text({ thinking: true, startedHere: false })).toBeNull();
    expect(text({ thinking: true, guest: true })).toBeNull();
    expect(text({ thinking: true, phase: 'interrupted' })).toBeNull();
    expect(text({ thinking: true, phase: 'paused' })).toBe('Arlo is paused');
    expect(text({ thinking: true, pausedOnServer: true })).toBe('Arlo is paused');
  });
});

describe('indicatorState: the state table', () => {
  const state = (overrides) => indicatorState({ ...base, ...overrides });
  const HEX = /^#[0-9A-F]{6}$/;

  test('each state has its key, its text and its style', () => {
    expect(state({})).toEqual({ key: 'transcribing', text: 'Arlo is transcribing', style: null });
    expect(state({ voiceEnabled: true })).toEqual({ key: 'transcribing', text: INDICATOR_TEXT.listening, style: null });
    expect(state({ phase: 'paused' })).toEqual({ key: 'paused', text: 'Arlo is paused', style: INDICATOR_STYLES.paused });
    expect(state({ waiting: true })).toEqual({ key: 'waiting', text: 'Arlo is waiting for an OK', style: INDICATOR_STYLES.waiting });
    expect(state({ thinking: true })).toEqual({ key: 'thinking', text: 'Arlo is thinking…', style: INDICATOR_STYLES.thinking });
    expect(state({ voiceEnabled: true, voiceProcessing: true }).key).toBe('thinking');
    expect(state({ didTool: 'post_to_chat' })).toEqual({ key: 'did', text: 'Arlo posted to the chat', style: INDICATOR_STYLES.did });
    expect(INDICATOR_STYLES.paused.textStyle).toBe('italic');
    expect(INDICATOR_STYLES.waiting.textStyle).toBe('bold');
    expect('textStyle' in INDICATOR_STYLES.thinking).toBe(false);
  });

  test('what Arlo just did, by tool: a fixed sentence; none for a reaction, an answer or a summary', () => {
    expect(DID_TEXT).toEqual({
      post_to_chat: 'Arlo posted to the chat',
      admit_from_waiting_room: 'Arlo let someone in',
      share_notes: 'Arlo shared the notes',
      invite_everyone: 'Arlo invited everyone to the notes',
      open_notes_for_everyone: 'Arlo opened the notes for everyone',
      mute_participant: 'Arlo muted a participant',
      open_issue: 'Arlo opened an issue',
    });
    for (const [tool, sentence] of Object.entries(DID_TEXT)) expect(state({ didTool: tool }).text).toBe(sentence);
    for (const tool of ['send_reaction', 'answer_from_meeting', 'summarize_so_far', 'web_search', 'set_timer', 'stop_timer',
      'none', 'toString', '__proto__', 'constructor', '', null, undefined, 5, {}]) {
      expect(state({ didTool: tool }).key).toBe('transcribing');
    }
  });

  test('priority: paused, waiting, thinking, did, transcribing', () => {
    const all = { waiting: true, thinking: true, didTool: 'share_notes' };
    expect(state({ ...all, phase: 'paused' }).key).toBe('paused');
    expect(state({ ...all, pausedOnServer: true }).key).toBe('paused');
    expect(state(all).key).toBe('waiting');
    expect(state({ ...all, waiting: false }).key).toBe('thinking');
    expect(state({ ...all, waiting: false, thinking: false }).key).toBe('did');
    expect(state({}).key).toBe('transcribing');
    // only exactly `true` counts
    expect(state({ waiting: 1 }).key).toBe('transcribing');
  });

  test('who sets the indicator and when stay as they were: no state changes that', () => {
    const all = { waiting: true, thinking: true, didTool: 'share_notes' };
    expect(state({ ...all, startedHere: false })).toBeNull();
    expect(state({ ...all, guest: true })).toBeNull();
    for (const phase of ['idle', 'requested', 'starting', 'stalled', 'interrupted', 'stopped', 'failed', 'denied', 'expired']) {
      expect(state({ ...all, phase })).toBeNull();
    }
  });

  test('every text and style there is belongs to a fixed set; nothing given to the table is ever shown', () => {
    expect([...INDICATOR_STRINGS].sort()).toEqual([
      'Arlo invited everyone to the notes', 'Arlo is paused', 'Arlo is thinking…', 'Arlo is transcribing',
      'Arlo is transcribing · Say "Hey Arlo"', 'Arlo is waiting for an OK', 'Arlo let someone in', 'Arlo muted a participant',
      'Arlo opened an issue', 'Arlo opened the notes for everyone', 'Arlo posted to the chat', 'Arlo shared the notes', 'Timer',
    ].sort());
    const hostile = ['Danny Reyes', 'Muting Danny Reyes', 'Asked to admit Priya from the waiting room', 'PROJ-123', 'Buy now', { name: 'Danny' }];
    const styles = new Set([null, ...Object.values(INDICATOR_STYLES)]);
    for (const phase of ['active', 'paused', 'idle']) {
      for (const flag of [true, false]) {
        for (const value of [...hostile, ...Object.keys(DID_TEXT), 'send_reaction']) {
          const got = indicatorState({
            phase, startedHere: true, guest: false, pausedOnServer: !flag && value, voiceEnabled: flag, voiceProcessing: value,
            thinking: flag ? true : value, waiting: flag ? value : false, didTool: value,
            // things the table does not take
            label: value, askedBy: value, step: value, text: value, name: value, style: { textColor: value },
          });
          if (got !== null) {
            expect(INDICATOR_STRINGS.has(got.text)).toBe(true);
            expect(styles.has(got.style)).toBe(true);
            expect(JSON.stringify(got)).not.toMatch(/Danny|Priya|PROJ|Buy/);
          }
        }
      }
    }
  });

  test('the colors are #RRGGBB, and text on background has a contrast of at least 4.5 to 1', () => {
    const luminance = (hex) => {
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(Object.keys(INDICATOR_STYLES).sort()).toEqual(['did', 'paused', 'thinking', 'waiting']);
    for (const [key, style] of Object.entries(INDICATOR_STYLES)) {
      expect(Object.isFrozen(style)).toBe(true);
      expect(Object.keys(style).filter((name) => !['textColor', 'borderColor', 'backgroundColor', 'textStyle'].includes(name))).toEqual([]);
      for (const name of ['textColor', 'borderColor', 'backgroundColor']) expect(style[name], `${key}.${name}`).toMatch(HEX);
      if ('textStyle' in style) expect(['bold', 'italic']).toContain(style.textStyle);
      expect(contrast(style.textColor, style.backgroundColor), key).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('the guesses about Zoom\'s API are in one frozen block', () => {
    expect(Object.isFrozen(INDICATOR_GUESSES)).toBe(true);
    expect(INDICATOR_GUESSES.timerStartPerMinute).toBe(60);
    expect(INDICATOR_GUESSES.timerText).toBe('Timer');
  });
});
