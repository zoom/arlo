import { getZoomUserContext, probeZoomSdk } from './ZoomSdkContext';

const configResponse = { runningContext: 'inMeeting' };

describe('probeZoomSdk', () => {
  it('returns the SDK configuration response inside Zoom', async () => {
    const zoomSdk = {
      config: jest.fn().mockResolvedValue(configResponse),
    };

    await expect(probeZoomSdk(zoomSdk, 50)).resolves.toEqual(configResponse);
    expect(zoomSdk.config).toHaveBeenCalledWith(expect.objectContaining({
      version: '0.16.0',
    }));
  });

  it('rejects when SDK configuration fails in a browser', async () => {
    const zoomSdk = {
      config: jest.fn().mockRejectedValue(new Error('not in Zoom')),
    };

    await expect(probeZoomSdk(zoomSdk, 50)).rejects.toThrow('not in Zoom');
  });

  it('rejects when SDK configuration does not settle', async () => {
    const zoomSdk = {
      config: jest.fn(() => new Promise(() => {})),
    };

    await expect(probeZoomSdk(zoomSdk, 10)).rejects.toThrow('timed out');
  });

  it('rejects when the SDK is unavailable', async () => {
    await expect(probeZoomSdk(null, 50)).rejects.toThrow('unavailable');
  });
});

describe('getZoomUserContext', () => {
  it('does not call the meeting-only API outside a meeting', async () => {
    const zoomSdk = { getUserContext: jest.fn() };

    await expect(getZoomUserContext(zoomSdk, 'inMainClient')).resolves.toBeNull();
    expect(zoomSdk.getUserContext).not.toHaveBeenCalled();
  });

  it('gets the user context while running in a meeting', async () => {
    const user = { status: 'authorized' };
    const zoomSdk = { getUserContext: jest.fn().mockResolvedValue(user) };

    await expect(getZoomUserContext(zoomSdk, 'inMeeting')).resolves.toEqual(user);
    expect(zoomSdk.getUserContext).toHaveBeenCalledTimes(1);
  });
});
