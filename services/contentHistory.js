import mongoose from 'mongoose';
import Submission from '../models/Submission.js';
import ApprovedContent from '../models/ApprovedContent.js';
import AmendmentRequest from '../models/AmendmentRequest.js';
import SubmissionRevision from '../models/SubmissionRevision.js';
import { contentSnapshot, contentHash, applyContentSnapshot } from '../models/shared/content.js';
import { saveDocument, idOf } from './revisionPersistence.js';
import { withHistoryLock, conflict } from './historyLock.js';

async function requireNoReview(submissionId) {
  const parent = await Submission.findById(submissionId).select('+pendingReview');
  if (!parent) throw conflict('Submission no longer exists');
  if (parent.pendingReview) throw conflict('A review needs to finish before this submission can be changed');
  return parent;
}

export async function saveWithHistory(...documents) {
  for (const document of documents) {
    await document.validate();
    const initial = document.isNew;
    const submissionId = document.constructor.modelName === 'Submission' ? document._id : idOf(document.submissionId);
    // A failed initial snapshot can be recovered later; it never publishes the submission.
    if (initial && document.constructor.modelName === 'Submission') await document.save();
    await withHistoryLock(submissionId, async () => {
      await requireNoReview(submissionId);
      if (document.constructor.modelName === 'Submission' && !initial &&
          await AmendmentRequest.exists({ submissionId, status: 'pending' })) {
        throw conflict('Cancel or review the pending amendment before editing this submission');
      }
      await saveDocument(document, initial);
    });
  }
  return documents;
}

export async function saveAmendmentWithHistory(amendment, suppliedSubmission) {
  return withHistoryLock(suppliedSubmission._id, async () => {
    const submission = await requireNoReview(suppliedSubmission._id);
    if (await AmendmentRequest.exists({ submissionId: submission._id, status: 'pending' })) {
      throw conflict('A pending amendment already exists');
    }
    const publication = await ApprovedContent.findOne({ submissionId: submission._id });
    const current = amendment.approvedContentId ? publication : submission;
    if (!current || (!amendment.approvedContentId && publication) ||
        contentHash(current) !== contentHash(amendment.currentApprovedSnapshot)) {
      throw conflict('Content changed while you were editing; reload and submit again');
    }
    await saveDocument(submission);
    const latest = await AmendmentRequest.findOne({ submissionId: submission._id }).sort({ versionNumber: -1 });
    amendment.versionNumber = Math.max(1, amendment.previousVersionNumber, latest?.versionNumber || 0) + 1;
    await saveDocument(amendment);
    // Counters are derived, so retry/recovery does not count the same amendment twice.
    const count = await AmendmentRequest.countDocuments({ submissionId: submission._id });
    await Submission.updateOne({ _id: submission._id }, { $set: {
      resubmissionCount: count, lastResubmissionDate: amendment.requestedAt,
      originalSubmissionDate: submission.originalSubmissionDate || submission.createdAt,
    } });
    return amendment;
  });
}

function sameDecision(intent, kind, amendmentId, reviewerId, approved, reason) {
  return intent.kind === kind && String(intent.amendmentId || '') === String(amendmentId || '') &&
    String(intent.reviewerId) === String(reviewerId) && intent.approved === approved &&
    (intent.reason || '') === (reason || '');
}

// The durable intent is written before publication. Each subsequent write sets exact values,
// making retries safe if the process stops between publication, submission and amendment writes.
async function finishReview(submissionId) {
  const submission = await Submission.findById(submissionId).select('+pendingReview');
  const intent = submission?.pendingReview;
  if (!intent) throw conflict('No unfinished review exists');
  const revision = await SubmissionRevision.findOne({ _id: intent.revisionId, submissionId });
  if (!revision) throw new Error('Review revision is missing');

  if (intent.approved) {
    let publication = await ApprovedContent.findById(intent.publicationId);
    if (publication && String(publication.submissionId) !== String(submissionId)) throw new Error('Publication belongs to another submission');
    publication ||= new ApprovedContent({ _id: intent.publicationId, submissionId, userId: submission.userId });
    applyContentSnapshot(publication, revision.content);
    publication.revisionId = revision._id;
    publication.currentVersion = intent.publicationVersion;
    publication.totalAmendments = intent.totalAmendments;
    publication.approvedBy = intent.reviewerId;
    publication.approvedAt = intent.reviewedAt;
    if (intent.kind === 'amendment') publication.lastAmendmentDate = intent.reviewedAt;
    await publication.save();
  }

  if (intent.approved || intent.restorePublished) applyContentSnapshot(submission, revision.content);
  submission.revisionId = intent.approved || intent.restorePublished ? revision._id : submission.revisionId;
  submission.status = intent.submissionStatus;
  submission.reviewedBy = intent.reviewerId;
  submission.reviewedAt = intent.reviewedAt;
  if (intent.approved) { submission.approvedAt = intent.reviewedAt; submission.rejectionReason = undefined; }
  if (!intent.approved && intent.kind === 'submission') submission.rejectionReason = intent.reason;
  submission.statusChangeReason = intent.reason || (intent.approved ? 'Approved by admin' : 'Changes rejected');
  submission.previousVersion = undefined;
  submission.previousVersionDate = undefined;
  await submission.save();

  let amendment;
  if (intent.amendmentId) {
    amendment = await AmendmentRequest.findOne({ _id: intent.amendmentId, submissionId });
    if (!amendment) throw new Error('Review amendment is missing');
    amendment.status = intent.approved ? 'approved' : 'rejected';
    amendment.reviewedBy = intent.reviewerId;
    amendment.reviewedAt = intent.reviewedAt;
    amendment.reviewNotes = intent.reason;
    if (intent.approved) amendment.approvedAt = intent.reviewedAt;
    else { amendment.rejectedAt = intent.reviewedAt; amendment.rejectionReason = intent.reason; }
    await amendment.save();
  }
  await Submission.updateOne({ _id: submissionId, 'pendingReview.operationId': intent.operationId }, { $unset: { pendingReview: 1 } });
  submission.pendingReview = undefined;
  return amendment || submission;
}

async function prepareReview(submission, amendment, reviewerId, approved, reason) {
  const kind = amendment ? 'amendment' : 'submission';
  if (submission.pendingReview) {
    if (!sameDecision(submission.pendingReview, kind, amendment?._id, reviewerId, approved, reason)) {
      throw conflict('Finish the existing review before making another decision');
    }
    return finishReview(submission._id);
  }
  if (amendment ? amendment.status !== 'pending' : submission.status !== 'pending') {
    throw conflict('This submission or amendment has already been reviewed');
  }
  if (!amendment && await AmendmentRequest.exists({ submissionId: submission._id, status: 'pending' })) {
    throw conflict('Review or cancel the pending amendment first');
  }
  const publication = await ApprovedContent.findOne({ submissionId: submission._id });
  if (amendment && approved) {
    const current = amendment.approvedContentId ? publication : submission;
    if (!current || (!amendment.approvedContentId && publication) ||
        (amendment.approvedContentId && String(publication._id) !== String(amendment.approvedContentId)) ||
        contentHash(current) !== contentHash(amendment.currentApprovedSnapshot)) {
      throw conflict('Content changed after this amendment was submitted; submit a new amendment');
    }
  }
  await saveDocument(submission);
  if (publication) await saveDocument(publication);
  if (amendment) await saveDocument(amendment);
  const restorePublished = !approved && !amendment && Boolean(publication);
  const revisionId = approved && amendment ? amendment.proposedRevisionId : restorePublished ? publication.revisionId : submission.revisionId;
  const revision = await SubmissionRevision.findOne({ _id: revisionId, submissionId: submission._id });
  if (!revision) throw new Error('Review revision is missing');
  const intent = {
    operationId: new mongoose.Types.ObjectId(), kind, amendmentId: amendment?._id,
    reviewerId, approved, reason, revisionId, reviewedAt: new Date(), restorePublished,
    publicationId: publication?._id || new mongoose.Types.ObjectId(),
    publicationVersion: amendment?.versionNumber || publication?.currentVersion || 1,
    totalAmendments: (publication?.totalAmendments || 0) + (amendment && approved ? 1 : 0),
    submissionStatus: approved || restorePublished ? 'approved' : amendment ? submission.status : 'rejected',
  };
  // Fail schema validation before recording an intent that could not be completed.
  if (approved) {
    const candidate = new ApprovedContent({ submissionId: submission._id, userId: submission.userId,
      ...contentSnapshot(revision.content), approvedBy: reviewerId, revisionId });
    await candidate.validate();
  }
  submission.pendingReview = intent;
  await submission.save();
  return finishReview(submission._id);
}

export async function reviewSubmission(submissionId, reviewerId, approved, reason) {
  if (typeof approved !== 'boolean') throw Object.assign(new Error('approved must be a boolean'), { status: 400 });
  return withHistoryLock(submissionId, async () => {
    const submission = await Submission.findById(submissionId).select('+pendingReview');
    return prepareReview(submission, null, reviewerId, approved, reason);
  });
}

export async function reviewAmendment(amendmentId, reviewerId, approved, reason) {
  if (typeof approved !== 'boolean') throw Object.assign(new Error('approved must be a boolean'), { status: 400 });
  const existing = await AmendmentRequest.findById(amendmentId);
  if (!existing) throw Object.assign(new Error('Amendment not found'), { status: 404 });
  return withHistoryLock(existing.submissionId, async () => {
    const amendment = await AmendmentRequest.findById(amendmentId);
    const submission = await Submission.findById(existing.submissionId).select('+pendingReview');
    return prepareReview(submission, amendment, reviewerId, approved, reason);
  });
}

export async function cancelAmendment(amendmentId, userId) {
  const existing = await AmendmentRequest.findOne({ _id: amendmentId, userId });
  if (!existing) throw Object.assign(new Error('Amendment not found'), { status: 404 });
  return withHistoryLock(existing.submissionId, async () => {
    await requireNoReview(existing.submissionId);
    const cancelled = await AmendmentRequest.findOneAndUpdate({ _id: amendmentId, userId, status: 'pending' },
      { $set: { status: 'cancelled' }, $inc: { __v: 1 } }, { new: true, runValidators: true });
    if (!cancelled) throw conflict('Amendment already processed');
    return cancelled;
  });
}

export async function resumeReview(submissionId) {
  return withHistoryLock(submissionId, () => finishReview(submissionId));
}
