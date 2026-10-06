/**
 * Auth routes. Note what is NOT here: no /register — this is an internal
 * ERP, accounts are created by an Admin (seed script now, admin UI later),
 * never by self-signup.
 */
import { Router } from 'express';
import asyncHandler from '../../utils/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { loginLimiter } from '../../middleware/rateLimiter.js';
import { requireTrustedOrigin } from '../../middleware/originGuard.js';
import { loginSchema, changePasswordSchema, refreshTokenBodySchema } from './auth.validation.js';
import { uploadAvatarImage } from './avatar.upload.js';
import * as authController from './auth.controller.js';

const router = Router();

// These three are the only routes authenticated by a COOKIE rather than a
// Bearer header, which makes them the only ones a hostile site could trigger
// with the user's credentials attached. requireTrustedOrigin is their CSRF
// guard — see middleware/originGuard.js for why SameSite alone is not enough
// once the frontend and API live on different domains.
router.use(requireTrustedOrigin);

router.post('/login', loginLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));
router.post('/refresh', validate({ body: refreshTokenBodySchema }), asyncHandler(authController.refresh));
router.post('/logout', validate({ body: refreshTokenBodySchema }), asyncHandler(authController.logout));

// Bearer-authenticated, unlike the three above — an attacker's site can't
// forge an Authorization header, so requireTrustedOrigin isn't what protects
// this one (requireAuth is), even though it's mounted on the same router.
router.patch(
  '/password',
  requireAuth,
  validate({ body: changePasswordSchema }),
  asyncHandler(authController.changePassword)
);

// Profile photo — same Bearer-only auth as /password, any role.
router.patch('/avatar', requireAuth, uploadAvatarImage, asyncHandler(authController.uploadAvatar));
router.delete('/avatar', requireAuth, asyncHandler(authController.removeAvatar));

export default router;
