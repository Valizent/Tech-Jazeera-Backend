/**
 * Centralized error handling — the ONLY place errors become HTTP responses.
 *
 * Everything funnels here: ApiError thrown by services, Mongoose cast/
 * duplicate-key errors, JSON parse failures, and genuine bugs. The client
 * always receives the standard envelope `{ success: false, message, details? }`.
 *
 * SECURITY: stack traces and internal error messages are logged with Winston
 * but NEVER sent to the client. Non-operational errors (bugs) are masked
 * behind a generic 500 message.
 */
import env from '../config/env.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';
import { captureError } from '../config/sentry.js';

/** 404 for routes that matched nothing. Registered after all real routes. */
export function notFoundHandler(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * Translate well-known third-party errors (Mongoose, body-parser) into
 * ApiError so the response logic below stays a single code path.
 */
function normalizeError(err) {
  if (err instanceof ApiError) return err;

  // Mongoose: invalid ObjectId in a URL param (e.g. GET /employees/abc)
  if (err.name === 'CastError') {
    return new ApiError(400, `Invalid value for "${err.path}".`);
  }
  // Mongoose: unique index violation (e.g. duplicate email)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue ?? {})[0] ?? 'field';
    return new ApiError(409, `A record with this ${field} already exists.`);
  }
  // Mongoose schema validation (last-resort net — Zod should catch these first).
  // A nested CastError's own .message embeds the raw submitted value, its
  // JS type, and the full field path verbatim (fixed 2026-09-14, a real
  // QA-audit-found gap: this went straight into the client-visible response
  // `details`, in production too — only the top-level `stack` field was ever
  // production-gated). Sanitized the same way the top-level CastError case
  // above already is; every other sub-error here is a real Mongoose
  // validator message (required/enum/custom), already written to be shown.
  if (err.name === 'ValidationError') {
    const details = Object.values(err.errors).map((e) =>
      e.name === 'CastError' ? { field: e.path, message: `Invalid value for "${e.path}".` } : { field: e.path, message: e.message }
    );
    return new ApiError(400, 'Validation failed.', details);
  }
  // body-parser: malformed JSON body
  if (err.type === 'entity.parse.failed') {
    return new ApiError(400, 'Request body is not valid JSON.');
  }

  // Unknown error → a bug. Mark non-operational so the message is masked.
  const wrapped = new ApiError(500, 'Something went wrong. Please try again.');
  wrapped.isOperational = false;
  wrapped.cause = err;
  return wrapped;
}

/** Express error middleware — must keep all 4 parameters to be recognized. */
export function errorHandler(err, req, res, next) {
  const error = normalizeError(err);

  // If the response already went out (e.g. a route that answers first and
  // finishes work afterwards), there is no way to send an error body — trying
  // would throw ERR_HTTP_HEADERS_SENT on top of the original failure. Express
  // requires delegating to its default handler, which closes the connection.
  if (res.headersSent) {
    logger.error(`${req.method} ${req.originalUrl} → error after response sent`, {
      stack: (error.cause ?? err).stack,
    });
    return next(err);
  }

  // Log bugs loudly with the ORIGINAL error and stack; expected failures
  // (404s, bad input) at warn level without stacks to keep logs readable.
  // Only a genuine bug is reported to error tracking — an expected ApiError
  // (400/403/404) isn't something anyone needs paged for.
  if (error.isOperational) {
    logger.warn(`${req.method} ${req.originalUrl} → ${error.statusCode}: ${error.message}`);
  } else {
    logger.error(`${req.method} ${req.originalUrl} → 500 unhandled error`, {
      stack: (error.cause ?? err).stack,
    });
    captureError(error.cause ?? err, { method: req.method, url: req.originalUrl, body: req.body });
  }

  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
    // Stack traces only in development responses, never in production.
    ...(env.isProduction ? {} : { stack: (error.cause ?? error).stack }),
  });
}
