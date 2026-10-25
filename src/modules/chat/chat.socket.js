/**
 * Chat real-time layer - a WebSocket at /ws that tells signed-in staff "something
 * changed in conversation X" the moment it happens.
 *
 * It carries NO message content. A client that hears the signal re-fetches over
 * the ordinary authenticated REST API, so permissions, membership and privacy are
 * enforced in exactly one place. Messages are never sent over the socket either.
 *
 * Production runs several PM2 processes and a socket lives in only one of them,
 * so a message sent through process A must reach a socket held by process B.
 * Every process therefore watches the `conversations` collection with a MongoDB
 * change stream and delivers to its own local sockets. Every visible change bumps
 * `Conversation.revision` in the same write (chat.service.js), which is what the
 * stream filters on, so bookkeeping writes (the push throttle) stay silent.
 *
 * Auth: a browser cannot set headers on a WebSocket and a token in the URL would
 * land in proxy logs, so the first message must be `{type:'auth', token}` within a
 * few seconds. It is checked like requireAuth (signature, active user, token
 * version, no forced password change) plus the chat role floor, re-checked every
 * few minutes, and the socket is closed with 4401 when the token expires so the
 * client refreshes it and reconnects.
 */
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import env from '../../config/env.js';
import logger from '../../config/logger.js';
import User from '../auth/user.model.js';
import Conversation from './conversation.model.js';
import { CHAT_ROLES } from './chat.service.js';

export const SOCKET_PATH = '/ws';

const MAX_PAYLOAD_BYTES = 4096;
const HEARTBEAT_MS = 30_000; // below typical proxy idle timeouts
const RECHECK_MS = 5 * 60_000;
const STREAM_RETRY_MS = 5_000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 20;

/** Close codes the clients act on. */
export const CLOSE_UNAUTHORIZED = 4401; // refresh the token, then reconnect
export const CLOSE_RATE_LIMITED = 4429;

/** The user behind a verified token, or null when the account may not chat (any more). */
async function authenticate(token) {
  let payload;
  try {
    payload = jwt.verify(token, env.jwtAccessSecret);
  } catch {
    return null;
  }
  const user = await User.findById(payload.sub).select('role isActive tokenVersion forcePasswordChange').lean();
  if (!user || !user.isActive || user.forcePasswordChange) return null;
  if ((payload.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) return null;
  if (!CHAT_ROLES.includes(user.role)) return null;
  return { userId: String(user._id), expiresAt: payload.exp * 1000 };
}

function originAllowed(origin, host) {
  if (!origin || env.clientUrls.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * Attach the chat socket to the HTTP server. Returns `{ close }` for graceful shutdown.
 * `authTimeoutMs` is how long a new connection has to send its auth message.
 */
export function attachChatSocket(httpServer, { authTimeoutMs = 5000 } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  /** userId -> that user's sockets in THIS process (a person may have web and phone open). */
  const socketsByUser = new Map();
  let stream = null;
  let retryTimer = null;
  let closing = false;

  httpServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== SOCKET_PATH) return socket.destroy();
    // Defence in depth only: nothing is trusted until the auth message below, and the token is not a cookie, so
    // another site cannot ride on someone's session. A browser sends its Origin and it must be ours; the phone app
    // sends none, or (React Native on Android) the API's own origin, which is the same host as this request.
    if (!originAllowed(req.headers.origin, req.headers.host)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    let session = null;
    let alive = true;
    const timers = [];
    const recent = [];

    const authTimer = setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'auth timeout'), authTimeoutMs);
    timers.push(authTimer);

    ws.on('pong', () => {
      alive = true;
    });

    ws.on('message', async (raw) => {
      const now = Date.now();
      recent.push(now);
      while (recent.length && recent[0] < now - RATE_WINDOW_MS) recent.shift();
      if (recent.length > RATE_MAX_MESSAGES) return ws.close(CLOSE_RATE_LIMITED, 'too many messages');

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message?.type === 'ping') return send(ws, { type: 'pong' });
      if (message?.type !== 'auth' || session || typeof message.token !== 'string') return;

      const identity = await authenticate(message.token).catch((err) => {
        logger.warn(`[chatSocket] auth lookup failed: ${err.message}`);
        return null;
      });
      if (!identity || ws.readyState !== WebSocket.OPEN) return ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');

      session = identity;
      const { token } = message;
      clearTimeout(authTimer);
      if (!socketsByUser.has(session.userId)) socketsByUser.set(session.userId, new Set());
      socketsByUser.get(session.userId).add(ws);

      // The access token is short-lived; when it runs out the client refreshes and reconnects.
      timers.push(setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'token expired'), Math.max(session.expiresAt - Date.now(), 0)));
      timers.push(
        setInterval(async () => {
          const stillValid = await authenticate(token).catch(() => session);
          if (!stillValid) ws.close(CLOSE_UNAUTHORIZED, 'no longer allowed');
        }, RECHECK_MS)
      );
      send(ws, { type: 'ready' });
    });

    timers.push(
      setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, HEARTBEAT_MS)
    );

    ws.on('close', () => {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      if (!session) return;
      const sockets = socketsByUser.get(session.userId);
      sockets?.delete(ws);
      if (sockets?.size === 0) socketsByUser.delete(session.userId);
    });

    ws.on('error', (err) => logger.warn(`[chatSocket] socket error: ${err.message}`));
  });

  function deliver(userId, message) {
    for (const socket of socketsByUser.get(userId) ?? []) send(socket, message);
  }

  function watch() {
    if (closing) return;
    try {
      stream = Conversation.watch(
        [{ $match: { $or: [{ operationType: 'insert' }, { 'updateDescription.updatedFields.revision': { $exists: true } }] } }],
        { fullDocument: 'updateLookup' }
      );
    } catch (err) {
      return scheduleRetry(err);
    }
    stream.on('change', (change) => {
      const conversation = change.fullDocument;
      if (!conversation) return; // deleted between the write and the lookup
      const event = { type: 'conversation.changed', conversationId: String(conversation._id) };
      for (const member of conversation.members) deliver(String(member.user), event);
    });
    stream.on('error', scheduleRetry);
    stream.on('close', () => scheduleRetry(new Error('change stream closed')));
  }

  function scheduleRetry(err) {
    if (closing || retryTimer) return;
    logger.error(`[chatSocket] change stream lost, retrying in ${STREAM_RETRY_MS / 1000}s: ${err.message}`);
    stream?.removeAllListeners();
    stream?.close().catch(() => {});
    stream = null;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      watch();
      // Whatever happened while the stream was down was missed: tell everyone to re-fetch.
      for (const userId of socketsByUser.keys()) deliver(userId, { type: 'resync' });
    }, STREAM_RETRY_MS);
  }

  watch();

  return {
    close() {
      closing = true;
      clearTimeout(retryTimer);
      stream?.removeAllListeners();
      stream?.close().catch(() => {});
      for (const client of wss.clients) client.close(1001, 'server shutting down');
      wss.close();
    },
  };
}
