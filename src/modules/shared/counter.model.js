/**
 * Counter — an atomic sequence generator, used to mint sequential
 * human-facing numbers (MOB-0001, REQ-0001, …) across otherwise unrelated
 * modules. Lives in its own neutral `shared/` module rather than inside any
 * one feature folder — it started out physically inside `quotations/` (a
 * historical accident of which module needed it first) and was relocated
 * 2026-09-27 when Quotation itself was removed, since Mobilisation and
 * Requirement both depend on this file and have nothing to do with
 * Quotation.
 *
 * Why a dedicated collection: computing "max existing number + 1" is racy and
 * breaks when a record is deleted. `findByIdAndUpdate($inc)` is a single
 * atomic operation, so two simultaneous creates can never get the same number.
 */
import mongoose from 'mongoose';

const counterSchema = new mongoose.Schema({
  _id: { type: String }, // the sequence name, e.g. 'mobilisation'
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model('Counter', counterSchema);

/** Atomically increment and return the next value for a named sequence. */
export async function nextSequence(name) {
  const counter = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

export default Counter;
