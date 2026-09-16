/**
 * Global Vitest setup — a REAL MongoDB (mongodb-memory-server spins up an
 * actual mongod binary, not a mock) so every test exercises the exact same
 * atomic-update/pipeline/index behavior production relies on. This
 * connection is entirely separate from server/.env's MONGODB_URI — nothing
 * in the test suite ever imports server.js/config/db.js, so the real
 * Atlas dev database is never touched.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
