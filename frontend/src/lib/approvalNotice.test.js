import { vi } from 'vitest';
import { createApprovalNotifier, APPROVAL_NOTICE } from './approvalNotice';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const sdk = () => ({ showNotification: vi.fn(async () => ({ message: 'Success' })) });
const hidden = { visibilityState: 'hidden' };
const visible = { visibilityState: 'visible' };
/** A clock for the notifier: `clock.now` for it, `clock.advance(ms)` for the test. */
function clockAt(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

test('the panel is visible: no notification', () => {
  const zoomSdk = sdk();
  const notify = createApprovalNotifier();
  expect(notify(zoomSdk, ID1, visible)).toBe(false);
  expect(zoomSdk.showNotification).not.toHaveBeenCalled();
});

test('the panel is not visible: one notification, with fixed words and nothing of the request', () => {
  const zoomSdk = sdk();
  const notify = createApprovalNotifier();
  expect(notify(zoomSdk, ID1, hidden)).toBe(true);
  expect(zoomSdk.showNotification).toHaveBeenCalledTimes(1);
  expect(zoomSdk.showNotification).toHaveBeenCalledWith({ type: 'info', title: 'Arlo', message: 'Arlo needs your OK' });
  expect(APPROVAL_NOTICE).toEqual({ type: 'info', title: 'Arlo', message: 'Arlo needs your OK' });
  expect(Object.isFrozen(APPROVAL_NOTICE)).toBe(true);
});

test('any state but "visible" counts as not visible', () => {
  const zoomSdk = sdk();
  const clock = clockAt();
  const notify = createApprovalNotifier({ now: clock.now });
  expect(notify(zoomSdk, ID1, { visibilityState: 'prerender' })).toBe(true);
  clock.advance(30_000);
  expect(notify(zoomSdk, ID2, {})).toBe(true);
  expect(zoomSdk.showNotification).toHaveBeenCalledTimes(2);
});

test('the same approval twice: one notification; another approval, later: its own', () => {
  const zoomSdk = sdk();
  const clock = clockAt();
  const notify = createApprovalNotifier({ now: clock.now });
  notify(zoomSdk, ID1, hidden);
  clock.advance(60_000);
  expect(notify(zoomSdk, ID1, hidden)).toBe(false);
  expect(zoomSdk.showNotification).toHaveBeenCalledTimes(1);
  expect(notify(zoomSdk, ID2, hidden)).toBe(true);
  expect(zoomSdk.showNotification).toHaveBeenCalledTimes(2);
});

test('an approval that arrived while the panel was visible is not announced when it comes again', () => {
  const zoomSdk = sdk();
  const notify = createApprovalNotifier();
  notify(zoomSdk, ID1, visible);
  expect(notify(zoomSdk, ID1, hidden)).toBe(false);
  expect(zoomSdk.showNotification).not.toHaveBeenCalled();
});

test('a client without the API, or no client: nothing happens', () => {
  const notify = createApprovalNotifier();
  expect(notify({}, ID1, hidden)).toBe(false);
  expect(notify(undefined, ID2, hidden)).toBe(false);
  expect(notify({ showNotification: 'yes' }, ID2, hidden)).toBe(false);
});

test('Zoom refuses (do not disturb), or throws at once: swallowed, and not tried again for that approval', async () => {
  const rejects = { showNotification: vi.fn(async () => { throw new Error('10042'); }) };
  const notify = createApprovalNotifier();
  expect(() => notify(rejects, ID1, hidden)).not.toThrow();
  await Promise.resolve();
  await Promise.resolve();
  notify(rejects, ID1, hidden);
  expect(rejects.showNotification).toHaveBeenCalledTimes(1);
  const throws = { showNotification: vi.fn(() => { throw new Error('no'); }) };
  expect(() => createApprovalNotifier()(throws, ID2, hidden)).not.toThrow();
  expect(throws.showNotification).toHaveBeenCalledTimes(1);
});

test('an id that is not one: nothing', () => {
  const zoomSdk = sdk();
  const notify = createApprovalNotifier();
  expect(notify(zoomSdk, '', hidden)).toBe(false);
  expect(notify(zoomSdk, undefined, hidden)).toBe(false);
  expect(notify(zoomSdk, 7, hidden)).toBe(false);
  expect(zoomSdk.showNotification).not.toHaveBeenCalled();
});

test('only so many ids are remembered: the oldest is forgotten first', () => {
  const zoomSdk = sdk();
  const notify = createApprovalNotifier({ remember: 2, minGapMs: 0 });
  notify(zoomSdk, 'a', hidden);
  notify(zoomSdk, 'b', hidden);
  notify(zoomSdk, 'c', hidden);
  expect(notify(zoomSdk, 'c', hidden)).toBe(false);
  expect(notify(zoomSdk, 'b', hidden)).toBe(false);
  expect(notify(zoomSdk, 'a', hidden)).toBe(true);
});

test('at most one notification in 30 seconds, however many approvals arrive', () => {
  const zoomSdk = sdk();
  const clock = clockAt();
  const notify = createApprovalNotifier({ now: clock.now });
  expect(notify(zoomSdk, 'a', hidden)).toBe(true);
  // a run of requests (anyone in the meeting can speak them): nothing more is shown
  for (let i = 0; i < 20; i += 1) {
    clock.advance(1000);
    expect(notify(zoomSdk, `burst-${i}`, hidden)).toBe(false);
  }
  clock.advance(9_999);
  expect(notify(zoomSdk, 'b', hidden)).toBe(false);
  expect(zoomSdk.showNotification).toHaveBeenCalledTimes(1);
  clock.advance(1);
  expect(notify(zoomSdk, 'c', hidden)).toBe(true);
  expect(zoomSdk.showNotification).toHaveBeenCalledTimes(2);
  // one that was held back is not announced later either: it is not news then
  clock.advance(60_000);
  expect(notify(zoomSdk, 'b', hidden)).toBe(false);
  expect(zoomSdk.showNotification).toHaveBeenCalledTimes(2);
});

test('what was not shown does not start the 30 seconds: a visible panel, a client without the API', () => {
  const zoomSdk = sdk();
  const clock = clockAt();
  const notify = createApprovalNotifier({ now: clock.now });
  expect(notify(zoomSdk, 'a', visible)).toBe(false);
  expect(notify({}, 'b', hidden)).toBe(false);
  expect(notify(zoomSdk, 'c', hidden)).toBe(true);
  // a refusal counts: Zoom was asked
  const rejects = { showNotification: vi.fn(async () => { throw new Error('10042'); }) };
  const other = createApprovalNotifier({ now: clock.now });
  expect(other(rejects, 'a', hidden)).toBe(true);
  expect(other(rejects, 'b', hidden)).toBe(false);
  expect(rejects.showNotification).toHaveBeenCalledTimes(1);
});

test('a clock that fails or goes backwards shows nothing more, and never throws', () => {
  const zoomSdk = sdk();
  let at = 5000;
  const notify = createApprovalNotifier({ now: () => at });
  expect(notify(zoomSdk, 'a', hidden)).toBe(true);
  at = 1000;
  expect(notify(zoomSdk, 'b', hidden)).toBe(false);
  at = NaN;
  expect(notify(zoomSdk, 'c', hidden)).toBe(false);
  const broken = createApprovalNotifier({ now: () => { throw new Error('no clock'); } });
  expect(() => broken(zoomSdk, 'd', hidden)).not.toThrow();
  expect(zoomSdk.showNotification).toHaveBeenCalledTimes(1);
});
