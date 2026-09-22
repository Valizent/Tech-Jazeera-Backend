/**
 * Periodic process-health sampling — the other half of the "monitoring
 * baseline" recommendation (2026-09-22, a real QA-audit finding;
 * requestMetrics.js covers the per-request half: p50/p95, payload sizes,
 * 429 frequency).
 *
 * Event-loop delay: Node's own built-in `perf_hooks.monitorEventLoopDelay`
 * — no new dependency. A rising p99 here is the earliest real signal of the
 * process getting overloaded (a slow synchronous handler, GC pressure, too
 * much work per tick), well before it shows up as request latency.
 *
 * Mongo operation count: a deliberately simple, AGGREGATE (not per-request)
 * count via `mongoose.set('debug', ...)` — every DB operation across the
 * whole process increments one counter, logged and reset every interval.
 * This is NOT the same as a per-request query count (that would need
 * request-scoped correlation — AsyncLocalStorage — a bigger architectural
 * change than "establish a baseline" calls for); it still answers the real
 * question this audit asked for a baseline on: is total DB load trending up
 * over time. The debug callback never logs the query itself (collection/
 * method/args can include real data) — it only counts.
 *
 * Both logged via the existing Winston logger (already writing JSON to
 * logs/combined.log in production — see logger.js) so this needs no new
 * log destination, dependency, or credential.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import mongoose from 'mongoose';
import logger from './logger.js';

const SAMPLE_INTERVAL_MS = 60_000; // 1 minute — frequent enough for a trend, not so frequent it floods the logs

const nsToMs = (ns) => Math.round((ns / 1e6) * 100) / 100;

/** Starts sampling; returns the interval handle so server.js can clear it
 *  on graceful shutdown, the same pattern its other periodic jobs use. */
export function startPeriodicMonitoring() {
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  eventLoopDelay.enable();

  let mongoOps = 0;
  mongoose.set('debug', () => {
    mongoOps += 1;
  });

  const interval = setInterval(() => {
    logger.info('event-loop-delay', {
      p50Ms: nsToMs(eventLoopDelay.percentile(50)),
      p99Ms: nsToMs(eventLoopDelay.percentile(99)),
      maxMs: nsToMs(eventLoopDelay.max),
    });
    eventLoopDelay.reset();

    logger.info('mongo-ops', { opsPerMinute: mongoOps });
    mongoOps = 0;
  }, SAMPLE_INTERVAL_MS);

  return interval;
}
