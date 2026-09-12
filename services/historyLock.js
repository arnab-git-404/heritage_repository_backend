import { randomUUID } from 'node:crypto';
import Submission from '../models/Submission.js';

export const conflict = message => Object.assign(new Error(message), { status: 409 });

// No expiring lease: a slow writer must never overlap a replacement writer.
// A process crash leaves a lock for the offline recovery command to release.
export async function withHistoryLock(submissionId, work) {
  const token = randomUUID();
  const parent = await Submission.findOneAndUpdate(
    { _id: submissionId, historyLock: null },
    { $set: { historyLock: { token, startedAt: new Date() } } },
    { new: true },
  );
  if (!parent) throw conflict('Submission is busy or no longer exists; retry later');
  try {
    return await work();
  } finally {
    // A persisted review intent survives errors and can be resumed by the same decision.
    await Submission.updateOne({ _id: submissionId, 'historyLock.token': token }, { $unset: { historyLock: 1 } });
  }
}
