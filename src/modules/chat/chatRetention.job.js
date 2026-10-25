/**
 * Chat retention - the daily job that purges messages (and their stored files)
 * older than CHAT_RETENTION_DAYS, together with any report that pointed at them.
 *
 * Chat history only ever grows, and attachments sit in private storage, so
 * without this the oldest conversations would be kept forever. A conversation's
 * "last message" preview is cleared once the message behind it is that old, so
 * no snippet outlives its message. Plain setInterval in server.js, like the other
 * daily jobs; idempotent, so running it twice is harmless.
 */
import env from '../../config/env.js';
import logger from '../../config/logger.js';
import Conversation from './conversation.model.js';
import ChatMessage from './chatMessage.model.js';
import ChatReport from './chatReport.model.js';
import { removeStoredFiles } from './chat.service.js';

const BATCH_SIZE = 200;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function runChatRetentionCheck({ retentionDays = env.chatRetentionDays, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - retentionDays * ONE_DAY_MS);
  let purged = 0;

  for (;;) {
    const batch = await ChatMessage.find({ createdAt: { $lt: cutoff } })
      .select('attachment')
      .limit(BATCH_SIZE)
      .lean();
    if (batch.length === 0) break;

    await removeStoredFiles(batch.filter((m) => m.attachment).map((m) => m.attachment));
    const ids = batch.map((m) => m._id);
    await Promise.all([ChatMessage.deleteMany({ _id: { $in: ids } }), ChatReport.deleteMany({ message: { $in: ids } })]);
    purged += ids.length;
  }

  await Conversation.updateMany({ lastMessageAt: { $lt: cutoff }, lastMessage: { $ne: null } }, { $set: { lastMessage: null } });

  if (purged > 0) logger.info(`[chatRetentionJob] purged ${purged} message(s) older than ${retentionDays} days`);
  return { purged };
}
