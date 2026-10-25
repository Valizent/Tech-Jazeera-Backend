/**
 * Chat controller - HTTP translation only (see chat.routes.js for the rules).
 */
import ApiResponse from '../../utils/ApiResponse.js';
import { streamStoredFile } from '../annualVacation/annualVacation.controller.js';
import * as service from './chat.service.js';

const actor = (req) => ({ userId: req.user.id, userName: req.user.name, role: req.user.role, ip: req.ip });

export async function listConversations(req, res) {
  res.json(new ApiResponse('Conversations.', await service.listConversations(req.user.id, req.query)));
}

export async function createConversation(req, res) {
  const conversation = await service.createConversation(actor(req), req.body);
  res.status(201).json(new ApiResponse('Conversation ready.', conversation));
}

export async function updateConversation(req, res) {
  res.json(new ApiResponse('Group updated.', await service.updateConversation(actor(req), req.params.id, req.body)));
}

export async function leaveConversation(req, res) {
  res.json(new ApiResponse('You left the group.', await service.leaveConversation(actor(req), req.params.id)));
}

export async function listMessages(req, res) {
  res.json(new ApiResponse('Messages.', await service.listMessages(req.user.id, req.params.id, req.query)));
}

export async function sendMessage(req, res) {
  const message = await service.sendMessage(actor(req), req.params.id, req.body, req.file);
  res.status(201).json(new ApiResponse('Message sent.', message));
}

export async function markRead(req, res) {
  res.json(new ApiResponse('Marked as read.', await service.markRead(req.user.id, req.params.id)));
}

export async function unreadCount(req, res) {
  res.json(new ApiResponse('Unread messages.', await service.getUnreadCount(req.user.id)));
}

export async function directory(req, res) {
  res.json(new ApiResponse('People you can chat with.', await service.listDirectory(req.user.id, req.query)));
}

export async function deleteMessage(req, res) {
  await service.deleteMessage(actor(req), req.params.id);
  res.json(new ApiResponse('Message deleted.', null));
}

export async function messageFile(req, res) {
  await streamStoredFile(res, await service.getMessageFile(actor(req), req.params.id));
}

export async function reportMessage(req, res) {
  await service.reportMessage(actor(req), req.params.id, req.body);
  res.status(201).json(new ApiResponse('Thank you. A moderator will review this message.', null));
}

export async function listReports(req, res) {
  res.json(new ApiResponse('Reported messages.', await service.listReports(req.query)));
}

export async function decideReport(req, res) {
  await service.decideReport(actor(req), req.params.id, req.body);
  res.json(new ApiResponse('Report decided.', null));
}

export async function reportFile(req, res) {
  await streamStoredFile(res, await service.getReportedMessageFile(req.params.id));
}
