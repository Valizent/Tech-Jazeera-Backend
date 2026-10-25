/**
 * Zod schemas for the chat module.
 */
import { z } from 'zod';
import { MAX_CHAT_BODY } from './chatMessage.model.js';

export const MAX_GROUP_MEMBERS = 100;

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const emptyToUndef = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const idList = (max) => z.array(id).max(max).transform((ids) => [...new Set(ids)]);
const groupName = z.string().trim().min(1, 'Give the group a name.').max(80, 'The group name is too long.');

export const idParamSchema = z.object({ id });

export const createConversationSchema = z
  .object({
    type: z.enum(['direct', 'group'], { error: 'Choose direct or group.' }),
    memberIds: idList(MAX_GROUP_MEMBERS - 1),
    name: z.preprocess(emptyToUndef, groupName.optional()),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'direct' && value.memberIds.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['memberIds'], message: 'Choose exactly one person to chat with.' });
    }
    if (value.type === 'group' && value.memberIds.length < 1) {
      ctx.addIssue({ code: 'custom', path: ['memberIds'], message: 'Add at least one other member.' });
    }
    if (value.type === 'group' && !value.name) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'Give the group a name.' });
    }
  });

export const updateConversationSchema = z
  .object({
    name: z.preprocess(emptyToUndef, groupName.optional()),
    addMemberIds: idList(MAX_GROUP_MEMBERS).optional(),
    removeMemberIds: idList(MAX_GROUP_MEMBERS).optional(),
  })
  .refine((value) => value.name || value.addMemberIds?.length || value.removeMemberIds?.length, {
    message: 'Nothing to change.',
  });

export const listMessagesSchema = z.object({
  before: z.preprocess(emptyToUndef, id.optional()),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// Multipart: the text arrives as a form field next to the optional file.
export const sendMessageSchema = z.object({
  body: z.preprocess(emptyToUndef, z.string().trim().max(MAX_CHAT_BODY, `A message can be at most ${MAX_CHAT_BODY} characters.`).optional()),
});

export const reportMessageSchema = z.object({
  reason: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
});

export const listConversationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const directoryQuerySchema = z.object({
  q: z.preprocess(emptyToUndef, z.string().trim().max(80).optional()),
});

export const listReportsSchema = z.object({
  status: z.enum(['open', 'dismissed', 'removed']).default('open'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const decideReportSchema = z.object({
  action: z.enum(['dismiss', 'remove'], { error: 'Choose dismiss or remove.' }),
});
