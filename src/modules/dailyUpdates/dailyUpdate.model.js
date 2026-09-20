/**
 * DailyUpdate — a coordinator's day-to-day work record. One collection, two
 * `kind`s, because both belong to exactly one coordinator, are listed per
 * coordinator, and are read together by whoever oversees them:
 *
 *   'Log'  — "what I did today". Append-only-ish free text pinned to a
 *            calendar day (`date`); several per day is normal.
 *   'Task' — a to-do with an optional `dueDate` and an Open/Done `status`.
 *            Either self-written by the coordinator or assigned by someone
 *            with team-write access (`createdBy` !== `coordinator`).
 *
 * `coordinator` is always the person the entry BELONGS to (the log's author,
 * the task's assignee) — always a real, active `Coordinator`-role login,
 * enforced by dailyUpdate.service.js, not by the schema. `createdBy` is who
 * actually typed it in, which is what tells a manager-assigned task apart from
 * a self-written one.
 *
 * Deliberately no `requirement`/`client`/`mobilisation` link yet: the
 * Requirements board (milestone 2) will add its own optional reference here
 * when that data exists — not before.
 */
import mongoose from 'mongoose';

export const DAILY_UPDATE_KINDS = ['Log', 'Task'];
export const TASK_STATUSES = ['Open', 'Done'];

const dailyUpdateSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: DAILY_UPDATE_KINDS, required: true },
    coordinator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },

    // Log only — the calendar day the entry is about, stored at UTC midnight
    // (a date-only value; the time of day is `createdAt`).
    date: {
      type: Date,
      default: null,
      required: function () {
        return this.kind === 'Log';
      },
    },

    // Task only.
    dueDate: { type: Date, default: null },
    status: { type: String, enum: TASK_STATUSES }, // set to 'Open' on creation of a Task, absent on a Log
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// A coordinator's own log (newest day first) and their task list.
dailyUpdateSchema.index({ coordinator: 1, kind: 1, date: -1 });
dailyUpdateSchema.index({ coordinator: 1, kind: 1, status: 1 });
// The all-coordinators views an overseer opens.
dailyUpdateSchema.index({ kind: 1, date: -1 });
dailyUpdateSchema.index({ kind: 1, status: 1 });

export default mongoose.model('DailyUpdate', dailyUpdateSchema);
