/**
 * requireAuth — proves WHO is making the request.
 *
 * Verifies the `Authorization: Bearer <access token>` header, then loads the
 * user from the DB and attaches a minimal `req.user` for downstream code.
 *
 * Why hit the DB on every request instead of trusting the token payload:
 * deactivating a user or changing their role must take effect IMMEDIATELY,
 * not whenever their 15-minute token happens to expire. For an internal ERP
 * that correctness is worth one indexed primary-key read per request.
 */
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import User from '../modules/auth/user.model.js';

export const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new ApiError(401, 'Authentication required.');
  }

  let payload;
  try {
    payload = jwt.verify(header.slice('Bearer '.length), env.jwtAccessSecret);
  } catch {
    // Expired and tampered tokens get the same message — an attacker learns
    // nothing, and the client's response is the same either way (re-auth).
    throw new ApiError(401, 'Session expired or invalid. Please log in again.');
  }

  const user = await User.findById(payload.sub).lean();
  if (!user || !user.isActive) {
    throw new ApiError(401, 'This account no longer exists or is deactivated.');
  }
  // A token issued before the last password change/reset is dead on arrival
  // (2026-09-14, a real QA-audit-found gap) — a reset previously only
  // revoked refresh SESSIONS; an already-issued access token kept working
  // until its own short expiry regardless, undermining "this credential is
  // compromised, cut it off now." `payload.iat` is seconds since epoch (a
  // jsonwebtoken default claim); `passwordChangedAt` is `null` for an
  // account whose password has never been reset since this field existed,
  // in which case nothing is rejected.
  if (user.passwordChangedAt && payload.iat * 1000 < user.passwordChangedAt.getTime()) {
    throw new ApiError(401, 'Session expired or invalid. Please log in again.');
  }

  // `employee` (P2-M1) is the linked workforce record, or null for staff. It
  // is the anchor for ownership checks — an ESS route (P2-M2) will compare a
  // resource's owner against req.user.employee. Stringified for easy ===.
  req.user = {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    employee: user.employee ? user.employee.toString() : null,
  };
  next();
});
