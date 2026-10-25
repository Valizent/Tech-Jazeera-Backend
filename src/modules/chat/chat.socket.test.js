/**
 * chat.socket.test.js - the real-time layer against a real HTTP server, a real
 * WebSocket client and a real change stream (the test database is a replica set).
 */
import http from 'node:http';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import env from '../../config/env.js';
import User from '../auth/user.model.js';
import { attachChatSocket, CLOSE_UNAUTHORIZED, CLOSE_RATE_LIMITED } from './chat.socket.js';
import { createConversation, sendMessage, markRead } from './chat.service.js';

vi.mock('../../middleware/upload.js', () => ({
  signedDownloadUrl: vi.fn(),
  destroyDocumentFile: vi.fn().mockResolvedValue('ok'),
  DOCUMENT_RESOURCE_TYPE: 'raw',
}));
vi.mock('../notifications/notification.service.js', () => ({ pushOnly: vi.fn() }));

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function makeUser(role = 'HR') {
  const user = await User.create({ name: `${role} ${unique()}`, email: `s-${unique()}@example.com`, passwordHash: 'x', role });
  const id = user._id.toString();
  return { id, actor: { userId: id, userName: user.name, role, ip: '127.0.0.1' }, token: tokenFor(id, role) };
}

const tokenFor = (id, role, expiresIn = '15m') => jwt.sign({ sub: id, role, tokenVersion: 0 }, env.jwtAccessSecret, { expiresIn });

async function startServer(options = { authTimeoutMs: 400 }) {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const socket = attachChatSocket(server, options);
  cleanups.push(async () => {
    socket.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

/** Opens a socket; `events` collects every JSON message, `closed` resolves with the close code. */
function connect(port, { token, origin, authenticate = true } = {}) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, origin ? { origin } : undefined);
  const events = [];
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  ws.on('error', () => {});
  if (authenticate) ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  cleanups.push(async () => ws.terminate());
  const waitFor = async (predicate, ms = 4000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for an event; saw ${JSON.stringify(events)}`);
  };
  return { ws, events, closed, waitFor };
}

describe('chat socket', () => {
  it('tells members, and only members, that a conversation changed', async () => {
    const [a, b, outsider] = [await makeUser(), await makeUser('Manager'), await makeUser()];
    const conversation = await createConversation(a.actor, { type: 'direct', memberIds: [b.id] });
    const port = await startServer();
    const [forB, forOutsider] = [connect(port, { token: b.token }), connect(port, { token: outsider.token })];
    await forB.waitFor((e) => e.type === 'ready');
    await forOutsider.waitFor((e) => e.type === 'ready');

    await sendMessage(a.actor, conversation.id, { body: 'hi' });

    const event = await forB.waitFor((e) => e.type === 'conversation.changed');
    expect(event.conversationId).toBe(conversation.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(forOutsider.events.filter((e) => e.type === 'conversation.changed')).toHaveLength(0);
  });

  it('carries no message content', async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const conversation = await createConversation(a.actor, { type: 'direct', memberIds: [b.id] });
    const port = await startServer();
    const forB = connect(port, { token: b.token });
    await forB.waitFor((e) => e.type === 'ready');
    await sendMessage(a.actor, conversation.id, { body: 'a secret sentence' });
    await forB.waitFor((e) => e.type === 'conversation.changed');
    expect(JSON.stringify(forB.events)).not.toContain('secret');
  });

  it('signals a read to the other member (their unread badge on another device)', async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const conversation = await createConversation(a.actor, { type: 'direct', memberIds: [b.id] });
    await sendMessage(a.actor, conversation.id, { body: 'one' });
    const port = await startServer();
    const forA = connect(port, { token: a.token });
    await forA.waitFor((e) => e.type === 'ready');
    await markRead(b.id, conversation.id);
    await forA.waitFor((e) => e.type === 'conversation.changed');
  });

  it('answers a ping', async () => {
    const a = await makeUser();
    const client = connect(await startServer(), { token: a.token });
    await client.waitFor((e) => e.type === 'ready');
    client.ws.send(JSON.stringify({ type: 'ping' }));
    await client.waitFor((e) => e.type === 'pong');
  });

  it('closes a socket with a bad token', async () => {
    const port = await startServer();
    expect(await connect(port, { token: 'not-a-token' }).closed).toBe(CLOSE_UNAUTHORIZED);
  });

  it('closes a socket that never authenticates', async () => {
    const port = await startServer();
    expect(await connect(port, { authenticate: false }).closed).toBe(CLOSE_UNAUTHORIZED);
  });

  it('refuses a Worker login, a deactivated user and a stale token version', async () => {
    const port = await startServer();
    const worker = await makeUser('Worker');
    expect(await connect(port, { token: worker.token }).closed).toBe(CLOSE_UNAUTHORIZED);

    const inactive = await makeUser();
    await User.updateOne({ _id: inactive.id }, { isActive: false });
    expect(await connect(port, { token: inactive.token }).closed).toBe(CLOSE_UNAUTHORIZED);

    const reset = await makeUser();
    await User.updateOne({ _id: reset.id }, { $inc: { tokenVersion: 1 } });
    expect(await connect(port, { token: reset.token }).closed).toBe(CLOSE_UNAUTHORIZED);
  });

  it('refuses a browser connection from a foreign origin', async () => {
    const a = await makeUser();
    const port = await startServer();
    const client = connect(port, { token: a.token, origin: 'http://evil.example' });
    expect(await Promise.race([client.closed, new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000))])).not.toBe('timeout');
    expect(client.events).toHaveLength(0);
  });

  it("accepts the API's own origin (React Native on Android sends it) but still needs the token", async () => {
    const a = await makeUser();
    const port = await startServer();
    const ok = connect(port, { token: a.token, origin: `http://localhost:${port}` });
    await ok.waitFor((e) => e.type === 'ready');
    const noToken = connect(port, { token: 'not-a-token', origin: `http://localhost:${port}` });
    expect(await noToken.closed).toBe(CLOSE_UNAUTHORIZED);
  });

  it('closes with 4401 when the access token runs out, so the client refreshes', async () => {
    const a = await makeUser();
    const client = connect(await startServer(), { token: tokenFor(a.id, 'HR', 1) });
    await client.waitFor((e) => e.type === 'ready');
    expect(await client.closed).toBe(CLOSE_UNAUTHORIZED);
  });

  it('closes a socket that floods it', async () => {
    const a = await makeUser();
    const client = connect(await startServer(), { token: a.token });
    await client.waitFor((e) => e.type === 'ready');
    for (let i = 0; i < 30; i += 1) client.ws.send(JSON.stringify({ type: 'ping' }));
    expect(await client.closed).toBe(CLOSE_RATE_LIMITED);
  });
});
