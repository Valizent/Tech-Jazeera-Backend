/**
 * Auth service — ALL authentication business logic.
 *
 * Token model (the heart of the system):
 *   - Access token: JWT, 15 min, lives only in the client's memory. Proves
 *     identity on every API call. Short life = a stolen one dies fast.
 *   - Refresh token: JWT, 7 days, lives in an httpOnly cookie the client's
 *     JavaScript cannot read (XSS protection). Its ONLY job is minting new
 *     access tokens at /api/auth/refresh.
 *   - Rotation: every refresh consumes the old token (its DB row is deleted)
 *     and issues a new one. A refresh token is single-use.
 *   - Reuse detection: a validly-signed refresh token that is NOT in the DB
 *     was already spent — someone is replaying a stolen token. Response:
 *     revoke every session for that user and force a fresh login.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import env from '../../config/env.js';
import logger from '../../config/logger.js';
import ApiError from '../../utils/ApiError.js';
import User from './user.model.js';
import RefreshToken from './refreshToken.model.js';
import Employee from '../employees/employee.model.js';
import { logAudit } from '../audit/audit.service.js';
import { deleteAvatarMedia } from './avatar.upload.js';
import { getMySectionAccess } from '../sectionAccess/sectionAccess.service.js';

const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_DAYS = 7;

/**
 * How long a just-rotated refresh token may still be exchanged. All browser
 * tabs share ONE refresh cookie; when the access token expires they race to
 * refresh, and every loser presents an already-rotated token. Without this
 * window that race trips theft detection and randomly logs users out.
 * 30s comfortably covers tab races while keeping the theft-detection story:
 * a genuinely stolen cookie is almost never replayed within 30s of a
 * legitimate rotation.
 */
const REFRESH_REUSE_GRACE_MS = 30 * 1000;

/** bcrypt cost factor: ~100ms per hash — slow for attackers, fine for users. */
const BCRYPT_ROUNDS = 12;

export function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Generate a random temporary password for a provisioned account (P2-M1).
 * 14 characters from an alphabet that excludes look-alikes (0/O, 1/l/I) so an
 * admin can read it aloud or type it without ambiguity — ~80 bits of entropy.
 * It is returned to the admin ONCE to hand over and is never stored in
 * plaintext (only its bcrypt hash) nor written to logs/audit.
 */
export function generateTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/** SHA-256 of the refresh token — what we store/look up instead of the token. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** The safe subset of a user we ever send to the client. */
function publicUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    avatarUrl: user.avatarUrl ?? null,
  };
}

/**
 * Whether this login may use the ESS portal (Milestone 4: Own-type-only).
 * Meaningless for every role except Worker/Staff — those never route through
 * `/api/me` at all, so this always reports `true` for them without touching
 * the DB. For Worker/Staff, lets the client redirect an ineligible login
 * (an old Outsourced/Subcontracted account, or one with no employee link at
 * all) straight to a "no portal access" page instead of letting it land on
 * `/me` and hit a wall of 403s — the server-side gate in me.routes.js is the
 * real enforcement; this is purely the client-side UX shortcut.
 */
async function getEssEligibility(user) {
  if (!['Worker', 'Staff'].includes(user.role)) return true;
  if (!user.employee) return false;
  const employee = await Employee.findById(user.employee).select('type').lean();
  return employee?.type === 'Own';
}

/** Mint both tokens and persist the refresh token's hash as a session row. */
async function issueTokens(user) {
  // `tokenVersion` (fixed 2026-09-15, F8 — see user.model.js's own doc
  // comment for the full reasoning) is the actual revocation mechanism now;
  // `?? 0` covers a `user` fetched before this field existed on the schema.
  const accessToken = jwt.sign(
    { sub: user._id.toString(), role: user.role, tokenVersion: user.tokenVersion ?? 0 },
    env.jwtAccessSecret,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
  // jti (random UUID) makes every refresh token unique BY CONSTRUCTION.
  // Without it, two tokens for the same user signed in the same second have
  // identical claims → identical JWT string → tokenHash unique-index clash.
  const refreshToken = jwt.sign(
    { sub: user._id.toString(), jti: crypto.randomUUID() },
    env.jwtRefreshSecret,
    { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` }
  );
  await RefreshToken.create({
    tokenHash: hashToken(refreshToken),
    user: user._id,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
  });
  return { accessToken, refreshToken };
}

/**
 * Log a user in with email + password.
 * Errors: 401 for wrong email OR wrong password OR deactivated account —
 * deliberately the same message for all three, so an attacker cannot probe
 * which emails exist.
 */
export async function login({ email, password, ip }) {
  // passwordHash is select:false — this query must opt in explicitly.
  const user = await User.findOne({ email }).select('+passwordHash');

  // Even when the user doesn't exist we run a bcrypt comparison against a
  // dummy hash, so "unknown email" and "wrong password" take the same time
  // (timing attacks can otherwise enumerate accounts).
  const hashToCheck =
    user?.passwordHash ?? '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZBB0NN8sTUZjXvBcyLC1eJ8qzQW9x6';
  const passwordOk = await bcrypt.compare(password, hashToCheck);

  if (!user || !passwordOk || !user.isActive) {
    await logAudit({ action: 'auth.login.failed', meta: { email }, ip });
    throw new ApiError(401, 'Invalid email or password.');
  }

  const tokens = await issueTokens(user);
  const sectionAccess = await getMySectionAccess({ userId: user._id, role: user.role });
  const essEligible = await getEssEligibility(user);
  await logAudit({ user: user._id, action: 'auth.login.success', ip });
  logger.info(`Login: ${user.email} (${user.role})`);
  return { user: { ...publicUser(user), sectionAccess, essEligible }, ...tokens };
}

/**
 * Exchange a valid refresh token for a new access + refresh pair (rotation).
 * Errors: 401 if the token is missing/expired/tampered/already-used.
 */
export async function refresh({ refreshToken, ip }) {
  if (!refreshToken) throw new ApiError(401, 'Not logged in.');

  try {
    jwt.verify(refreshToken, env.jwtRefreshSecret);
  } catch {
    throw new ApiError(401, 'Session expired. Please log in again.');
  }

  const stored = await RefreshToken.findOne({ tokenHash: hashToken(refreshToken) });

  // Unknown token: its row already expired (TTL) or was revoked. A validly
  // signed token can't be fabricated, so this is just a stale session.
  if (!stored) {
    throw new ApiError(401, 'Session expired. Please log in again.');
  }

  // Rotated AND past the grace window → someone is replaying an old token
  // long after its legitimate owner already exchanged it. Treat as theft:
  // kill every session this user has and make them log in again.
  if (stored.rotatedAt && Date.now() - stored.rotatedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
    await RefreshToken.deleteMany({ user: stored.user });
    await logAudit({ user: stored.user, action: 'auth.refresh.reuse_detected', ip });
    logger.warn(`Refresh token reuse detected for user ${stored.user} — all sessions revoked.`);
    throw new ApiError(401, 'Session invalidated. Please log in again.');
  }

  // First use: mark it rotated and let it die shortly after the grace window
  // (the TTL index cleans it up). Reuse WITHIN the window (tab races) falls
  // through and mints its own new pair.
  if (!stored.rotatedAt) {
    stored.rotatedAt = new Date();
    stored.expiresAt = new Date(Date.now() + 2 * REFRESH_REUSE_GRACE_MS);
    await stored.save();
  }

  const user = await User.findById(stored.user);
  if (!user || !user.isActive) {
    throw new ApiError(401, 'This account no longer exists or is deactivated.');
  }

  const tokens = await issueTokens(user);
  const sectionAccess = await getMySectionAccess({ userId: user._id, role: user.role });
  const essEligible = await getEssEligibility(user);
  return { user: { ...publicUser(user), sectionAccess, essEligible }, ...tokens };
}

/**
 * Log out: delete this device's session row. Other devices stay logged in.
 * Idempotent — logging out twice is not an error.
 */
export async function logout({ refreshToken, ip }) {
  if (!refreshToken) return;
  const stored = await RefreshToken.findOneAndDelete({ tokenHash: hashToken(refreshToken) });
  if (stored) await logAudit({ user: stored.user, action: 'auth.logout', ip });
}

/**
 * Self-service password change. Requires proving the CURRENT password (not
 * just being logged in) — a short-lived access token alone isn't enough
 * grounds to change the credential that outlives it.
 *
 * Every refresh-token session is revoked afterward, on every device — the
 * same "assume compromise, start clean" posture as reuse detection. The
 * caller's own session dies too; the client must send them back to /login.
 */
export async function changePassword({ userId, currentPassword, newPassword }, ip) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new ApiError(404, 'Account not found.');

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new ApiError(401, 'Current password is incorrect.');

  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  // The real revocation signal for an already-issued access token — see
  // user.model.js's tokenVersion doc comment (F8, 2026-09-15).
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  await RefreshToken.deleteMany({ user: user._id });

  await logAudit({ user: user._id, action: 'auth.password.changed', ip });
  logger.info(`Password changed: ${user.email}`);
}

/**
 * Self-service avatar upload/replace — any role. The old image (if any) is
 * deleted from Cloudinary after the swap succeeds, so a failed upload never
 * orphans the previous one.
 */
export async function updateAvatar({ userId, url }, ip) {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'Account not found.');

  const old = user.avatarUrl;
  user.avatarUrl = url;
  await user.save();
  if (old) await deleteAvatarMedia(old);

  await logAudit({ user: user._id, action: 'user.avatar.update', ip });
  return { avatarUrl: url };
}

/** Self-service avatar removal — reverts to the initial-letter placeholder. */
export async function removeAvatar({ userId }, ip) {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'Account not found.');

  const old = user.avatarUrl;
  user.avatarUrl = null;
  await user.save();
  if (old) await deleteAvatarMedia(old);

  await logAudit({ user: user._id, action: 'user.avatar.remove', ip });
  return { avatarUrl: null };
}
