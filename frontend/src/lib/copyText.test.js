import { vi } from 'vitest';
import { copyText } from './copyText';

// Zoom's embedded webview may have no clipboard API, or may refuse it.

const setClipboard = (value) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

describe('copyText', () => {
  let originalExecCommand;
  beforeEach(() => { originalExecCommand = document.execCommand; });
  afterEach(() => {
    document.execCommand = originalExecCommand;
    setClipboard(undefined);
  });

  test('uses the clipboard API when it works', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    document.execCommand = vi.fn(() => true);

    await expect(copyText('Summary\nA line')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('Summary\nA line');
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  test('falls back to a hidden textarea when the clipboard API refuses', async () => {
    setClipboard({ writeText: vi.fn(async () => { throw new Error('NotAllowedError'); }) });
    let copied = null;
    document.execCommand = vi.fn((command) => {
      copied = { command, value: document.activeElement?.value, hidden: document.activeElement?.getAttribute('aria-hidden') };
      return true;
    });

    await expect(copyText('Summary\nA line')).resolves.toBe(true);
    expect(copied).toEqual({ command: 'copy', value: 'Summary\nA line', hidden: 'true' });
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('falls back when there is no clipboard API at all', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => true);
    await expect(copyText('text')).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  test('gives focus back to what had it', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => true);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    await copyText('text');
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  test('resolves false when both ways fail, and leaves nothing behind', async () => {
    setClipboard({ writeText: vi.fn(async () => { throw new Error('refused'); }) });
    document.execCommand = vi.fn(() => false);
    await expect(copyText('text')).resolves.toBe(false);

    document.execCommand = vi.fn(() => { throw new Error('not supported'); });
    await expect(copyText('text')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('resolves false for anything that is not text, or empty', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    await expect(copyText('')).resolves.toBe(false);
    await expect(copyText(null)).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
