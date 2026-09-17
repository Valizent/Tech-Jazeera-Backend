# M1 — Backend foundation

## What was built

An Express server skeleton that every later milestone plugs into. No business
features yet — just the rails: configuration, logging, security middleware,
the API response contract, and error handling.

```
server/src/
├── config/
│   ├── env.js          # validates ALL env vars at boot; sole reader of process.env
│   ├── logger.js       # Winston: pretty console in dev, JSON + files in prod
│   └── db.js           # Mongoose connection + connection-lifecycle logging
├── middleware/
│   ├── errorHandler.js # notFoundHandler (404) + errorHandler (the ONLY place
│   │                   #   errors become HTTP responses)
│   └── rateLimiter.js  # general /api limiter (auth gets a stricter one in M2)
├── utils/
│   ├── ApiError.js     # throw new ApiError(404, 'Not found') from services
│   ├── ApiResponse.js  # res.json(new ApiResponse('OK', data)) from controllers
│   └── asyncHandler.js # wraps async controllers so throws reach errorHandler
├── app.js              # middleware + route assembly (order is deliberate)
└── server.js           # boot: validate env → connect DB → listen; graceful shutdown
```

## How it works — the request lifecycle

Every request flows: `helmet` (security headers) → `cors` (origin check) →
`express.json` (body parsing, 1 MB cap) → rate limiter → route → …and on any
failure, into `errorHandler`. Success responses are always
`{ success: true, message, data }`; failures are always
`{ success: false, message, details? }`. The frontend will rely on this shape
being universal.

The error pipeline is the part worth understanding deeply:

1. A service throws `new ApiError(409, 'Employee ID already exists.')`.
2. The controller is wrapped in `asyncHandler`, so the rejected promise is
   passed to `next(err)` automatically.
3. `errorHandler` normalizes it (Mongoose and body-parser errors get
   translated too), logs it, and sends the envelope. Bugs (anything that is
   not an `ApiError`) are masked as a generic 500 — their message and stack
   go only to the log.

## How to modify it

- **New env var?** Add it to `.env.example` (documented), read it in
  `env.js` with `required()`/`requiredEnum()`/`requiredPort()`, and consume it
  via `import env from './config/env.js'`. Never read `process.env` elsewhere.
- **New module?** Create `src/modules/<name>/` with `*.routes.js`,
  `*.controller.js`, `*.service.js`, `*.model.js`, `*.validation.js` and mount
  the router in `app.js` above the 404 handler. (M2 sets the first example.)
- **New error case?** Throw `ApiError` from the service. Only add a case to
  `normalizeError()` when a *third-party* library throws something users cause.

## Common beginner mistakes

- **Putting `res.status(...)` calls in services.** Services return data or
  throw `ApiError`; only controllers touch `req`/`res`.
- **Forgetting `asyncHandler`.** An async route that throws without it never
  responds — the request just hangs. If a request hangs, check this first.
- **Registering routes after the 404 handler.** Order in `app.js` is
  top-to-bottom; anything after `notFoundHandler` is unreachable.
- **Atlas connection refused.** 9 times out of 10 it's Network Access: your
  current IP isn't whitelisted in Atlas. The boot error message says this.
- **Editing `.env.example` but not `.env`** (or vice versa). `.env` is what
  runs; `.env.example` is what teammates copy. Keep both current.

## Debugging tips

- `GET /api/health` shows `database: connected|disconnected` — check it before
  suspecting your code.
- Dev logs are human-readable in the console. `logger.debug(...)` output shows
  in dev but is suppressed in production.
- Boot failures print exactly which env var is wrong; trust the message.

## Security & performance notes

- Helmet sets ~a dozen security headers (no sniffing, no framing, etc.).
- CORS allows only `CLIENT_URL`, with `credentials: true` ready for the M2
  refresh cookie. `origin: '*'` would silently break cookie auth.
- Body size capped at 1 MB — oversized-payload DoS protection.
- Rate limit: 600 requests / 15 min / IP across `/api` (an office shares one
  IP; auth routes get a far stricter limit in M2).
- Stack traces appear in responses only in development.
- Graceful shutdown lets in-flight requests finish on Ctrl+C / deploy restart.
