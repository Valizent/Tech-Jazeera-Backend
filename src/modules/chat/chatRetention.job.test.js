/**
 * chatRetention.job.test.js - old messages go (with their files and reports),
 * recent ones stay, and a conversation preview never outlives its message.
 */
import mongoose from 'mongoose';
import Conversation from './conversation.model.js';
import ChatMessage from './chatMessage.model.js';
import ChatReport from './chatReport.model.js';
import * as upload from '../../middleware/upload.js';
import { runChatRetentionCheck } from './chatRetention.job.js';

vi.mock('../../middleware/upload.js', () => ({
  signedDownloadUrl: vi.fn(),
  destroyDocumentFile: vi.fn().mockResolvedValue('ok'),
  DOCUMENT_RESOURCE_TYPE: 'raw',
}));
vi.mock('../notifications/notification.service.js', () => ({ pushOnly: vi.fn() }));

const oid = () => new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;

describe('chat retention', () => {
  it('purges messages past the window, with their files and reports, and keeps the rest', async () => {
    const [a, b] = [oid(), oid()];
    const old = new Date(Date.now() - 100 * DAY);
    const conversation = await Conversation.create({
      type: 'direct',
      directKey: `${a}:${b}`,
      members: [{ user: a }, { user: b }],
      createdBy: a,
      lastMessageAt: old,
      lastMessage: { message: oid(), sender: a, snippet: 'ancient', at: old },
    });
    const attachment = { fileName: 'crm-documents/x', resourceType: 'raw', mimeType: 'application/pdf', originalName: 'x.pdf', size: 10 };
    const stale = await ChatMessage.create({ conversation: conversation._id, sender: a, body: 'old', attachment, createdAt: old });
    await ChatMessage.create({ conversation: conversation._id, sender: a, body: 'recent' });
    await ChatReport.create({ message: stale._id, conversation: conversation._id, reporter: b, sender: a });

    const { purged } = await runChatRetentionCheck({ retentionDays: 30 });

    expect(purged).toBe(1);
    expect((await ChatMessage.find().lean()).map((m) => m.body)).toEqual(['recent']);
    expect(await ChatReport.countDocuments()).toBe(0);
    expect(upload.destroyDocumentFile).toHaveBeenCalledWith('crm-documents/x', 'raw');
    expect((await Conversation.findById(conversation._id)).lastMessage).toBeNull();
  });

  it('does nothing when nothing is old enough', async () => {
    const [a, b] = [oid(), oid()];
    const conversation = await Conversation.create({ type: 'direct', directKey: `${a}:${b}`, members: [{ user: a }, { user: b }], createdBy: a });
    await ChatMessage.create({ conversation: conversation._id, sender: a, body: 'fresh' });
    expect(await runChatRetentionCheck({ retentionDays: 30 })).toEqual({ purged: 0 });
    expect(await ChatMessage.countDocuments()).toBe(1);
  });
});
