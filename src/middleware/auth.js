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
import { userLimiter } from './rateLimiter.js';

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
  // — a reset must cut off an already-issued access token immediately, not
  // whenever its own short expiry happens to land, or "reset because this
  // credential is compromised" doesn't actually guarantee it stopped
  // working. Originally (2026-09-14) implemented by comparing `payload.iat`
  // against `passwordChangedAt`'s timestamp — replaced 2026-09-15 (a real
  // QA-audit-found gap — F8) after that comparison turned out to have no
  // safe rounding: `iat` is always floored to whole SECONDS (a JWT/JOSE
  // spec requirement), while `passwordChangedAt` carries millisecond
  // precision, so a token issued a fraction of a second after a reset — in
  // the SAME calendar second — read as "issued before" it and was wrongly
  // rejected, including on the very login the reset had just enabled. A
  // monotonic `tokenVersion` (see user.model.js's own doc comment)
  // sidesteps clock precision entirely: `?? 0` on both sides covers a
  // pre-this-fix token (no claim at all) against a pre-this-fix user
  // (field just added, defaults to 0) — no already-logged-in session is
  // force-invalidated by this fix shipping.
  if ((payload.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
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
  // A real per-user budget on top of the IP-wide one now that we know WHO
  // this is (2026-09-22, a real QA-audit finding — P1) — see
  // rateLimiter.js's own doc comment on why one IP-keyed limit alone isn't
  // enough for a shared-office-IP ERP. userLimiter is a plain Express
  // middleware; calling it directly here (rather than re-declaring it on
  // every protected router) is the one place every authenticated request
  // already passes through exactly once.
  userLimiter(req, res, next);
});
