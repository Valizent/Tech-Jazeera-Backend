/**
 * MongoDB connection via Mongoose.
 *
 * Why a dedicated file: connection concerns (timeouts, event listeners,
 * failure behavior) belong in one place, not mixed into server boot logic.
 * The server calls connectDb() BEFORE listening — if the database is
 * unreachable we crash at boot instead of accepting requests we can't serve.
 */
import mongoose from 'mongoose';
import env from './env.js';
import logger from './logger.js';

export async function connectDb() {
  // Fail after 10s instead of Mongoose's default 30s so a bad URI or blocked
  // IP (a very common Atlas setup mistake) surfaces quickly with a clear error.
  mongoose.connection.on('error', (err) => {
    // Fires on errors AFTER the initial connection (e.g. network drop).
    logger.error(`MongoDB connection error: ${err.message}`);
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected Mongoose will retry automatically.');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected.');
  });

  await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10_000 });
  logger.info(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
}
