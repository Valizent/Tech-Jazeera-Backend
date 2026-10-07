/**
 * Phone push for the native mobile app (2026-10-06, M2 — see
 * docs/MOBILE-RN-notes.md). `fetch` to Expo's push service is stubbed; the
 * database is the suite's real in-memory MongoDB.
 */
import mongoose from 'mongoose';
import DevicePushToken from './devicePushToken.model.js';
import RefreshToken from '../auth/refreshToken.model.js';
import { EXPO_PUSH_URL, sendExpoPush } from './expoPush.service.js';
import { registerDevice, unregisterDevice } from './notification.service.js';
import { revokeAllSessions } from '../auth/auth.service.js';

const userId = () => new mongoose.Types.ObjectId();
const notification = { _id: new mongoose.Types.ObjectId(), title: 'Leave approved', body: 'Your leave was approved.', url: '/me/leave' };

function stubExpo(tickets, { ok = true, status = 200 } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status, json: async () => ({ data: tickets }) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('sendExpoPush', () => {
  it('sends one message per signed-in phone, with the url and notification id for the tap', async () => {
    const user = userId();
    await registerDevice(user, { token: 'ExponentPushToken[aaa]', platform: 'android' });
    await registerDevice(user, { token: 'ExponentPushToken[bbb]', platform: 'ios' });
    const fetchMock = stubExpo([{ status: 'ok' }, { status: 'ok' }]);

    await sendExpoPush(user, notification);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(EXPO_PUSH_URL);
    const messages = JSON.parse(init.body);
    expect(messages.map((m) => m.to).sort()).toEqual(['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]']);
    expect(messages[0]).toMatchObject({
      title: 'Leave approved',
      body: 'Your leave was approved.',
      channelId: 'default',
      data: { url: '/me/leave', notificationId: String(notification._id) },
    });
  });

  it('makes no request at all for a user with no phone', async () => {
    const fetchMock = stubExpo([]);
    await sendExpoPush(userId(), notification);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forgets a token Expo reports as DeviceNotRegistered, and keeps the rest', async () => {
    const user = userId();
    await registerDevice(user, { token: 'ExponentPushToken[live]', platform: 'android' });
    await registerDevice(user, { token: 'ExponentPushToken[gone]', platform: 'android' });
    const order = (await DevicePushToken.find({ user }).lean()).map((d) => d.token);
    stubExpo(order.map((token) => (token === 'ExponentPushToken[gone]' ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' })));

    await sendExpoPush(user, notification);

    const left = (await DevicePushToken.find({ user }).lean()).map((d) => d.token);
    expect(left).toEqual(['ExponentPushToken[live]']);
  });

  it('keeps every token when Expo itself is failing (not the device)', async () => {
    const user = userId();
    await registerDevice(user, { token: 'ExponentPushToken[ccc]', platform: 'android' });
    stubExpo([], { ok: false, status: 503 });

    await expect(sendExpoPush(user, notification)).resolves.toBeUndefined();
    expect(await DevicePushToken.countDocuments({ user })).toBe(1);
  });
});

describe('device registration', () => {
  it('moves a phone to whoever signed in on it last', async () => {
    const first = userId();
    const second = userId();
    await registerDevice(first, { token: 'ExponentPushToken[shared]', platform: 'android' });
    await registerDevice(second, { token: 'ExponentPushToken[shared]', platform: 'android' });

    const devices = await DevicePushToken.find({ token: 'ExponentPushToken[shared]' }).lean();
    expect(devices).toHaveLength(1);
    expect(String(devices[0].user)).toBe(String(second));
  });

  it("never lets one user unregister another user's phone", async () => {
    const owner = userId();
    await registerDevice(owner, { token: 'ExponentPushToken[mine]', platform: 'ios' });

    await unregisterDevice(userId(), 'ExponentPushToken[mine]');
    expect(await DevicePushToken.countDocuments({ user: owner })).toBe(1);

    await unregisterDevice(owner, 'ExponentPushToken[mine]');
    expect(await DevicePushToken.countDocuments({ user: owner })).toBe(0);
  });

  it('revoking every session also signs the phones out of push', async () => {
    const user = userId();
    const other = userId();
    await registerDevice(user, { token: 'ExponentPushToken[revoked]', platform: 'android' });
    await registerDevice(other, { token: 'ExponentPushToken[untouched]', platform: 'android' });
    await RefreshToken.create({ tokenHash: 'h1', user, expiresAt: new Date(Date.now() + 60_000) });

    await revokeAllSessions(user);

    expect(await RefreshToken.countDocuments({ user })).toBe(0);
    expect(await DevicePushToken.countDocuments({ user })).toBe(0);
    expect(await DevicePushToken.countDocuments({ user: other })).toBe(1);
  });
});
