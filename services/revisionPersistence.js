import Submission from '../models/Submission.js';
import ApprovedContent from '../models/ApprovedContent.js';
import AmendmentRequest from '../models/AmendmentRequest.js';
import SubmissionRevision from '../models/SubmissionRevision.js';
import { contentSnapshot, contentHash } from '../models/shared/content.js';
import { retainContentAssets } from './mediaAssets.js';

import { withHistoryLock, conflict } from './historyLock.js';

const idOf = value => value?._id || value;

async function createRevision(document, content, baseRevisionId, legacy = false) {
  const sourceType = document.constructor.modelName;
  const submissionId = sourceType === 'Submission' ? document._id : idOf(document.submissionId);
  // The parent lock serializes allocation; the counter update itself is atomic on standalone MongoDB.
  const hash = contentHash(content);
  const snapshotKey = `${sourceType}:${document._id}:${baseRevisionId || 'baseline'}:${hash}`;
  const existing = await SubmissionRevision.findOne({ snapshotKey });
  if (existing) return existing;
  const latest = await SubmissionRevision.findOne({ submissionId }).sort({ revisionNumber: -1 });
  await Submission.updateOne({ _id: submissionId }, { $max: { revisionSequence: latest?.revisionNumber || 0 } });
  const parent = await Submission.findOneAndUpdate({ _id: submissionId }, { $inc: { revisionSequence: 1 } }, { new: true });
  if (!parent) throw conflict('Submission no longer exists');
  const ownerId = idOf(document.userId);
  const revision = new SubmissionRevision({
    submissionId, revisionNumber: parent.revisionSequence, snapshotKey,
    baseRevisionId, createdBy: ownerId, sourceType, sourceId: document._id,
    content: contentSnapshot(content), contentHash: contentHash(content),
    changesSummary: document.changesSummary || (legacy ? 'Recovered legacy snapshot' : 'Initial submission'),
    assets: await retainContentAssets(content, ownerId), legacy,
  });
  await revision.save({});
  return revision;
}

async function matchingRevision(id, document, content) {
  if (!id) return null;
  const submissionId = document.constructor.modelName === 'Submission' ? document._id : idOf(document.submissionId);
  return SubmissionRevision.findOne({ _id: id, submissionId, contentHash: contentHash(content) });
}

async function saveDocument(document, initial = false) {
  const modelName = document.constructor.modelName;
  const Model = document.constructor;
  const previous = document.isNew || initial ? null : await Model.findById(document._id);

  if (modelName === 'AmendmentRequest') {
    if (previous?.proposedRevisionId) {
      if (contentHash(previous.proposedChanges) !== contentHash(document.proposedChanges)) {
        throw new Error('An amendment proposal cannot be changed after submission');
      }
      document.proposedRevisionId = previous.proposedRevisionId;
      document.baseRevisionId = previous.baseRevisionId;
    } else {
      let base;
      if (document.approvedContentId) {
        const publication = await ApprovedContent.findById(idOf(document.approvedContentId));
        if (publication && contentHash(publication) === contentHash(document.currentApprovedSnapshot)) {
          base = await matchingRevision(publication.revisionId, document, document.currentApprovedSnapshot);
          if (!base) base = await createRevision(document, document.currentApprovedSnapshot, undefined, true);
          document.baseRevisionId = base._id;
          if (!publication.revisionId) {
            publication.revisionId = base._id;
            await publication.save({});
          }
        }
      } else {
        const submission = await Submission.findById(idOf(document.submissionId));
        if (submission && contentHash(submission) === contentHash(document.currentApprovedSnapshot)) {
          base = await matchingRevision(submission.revisionId, document, document.currentApprovedSnapshot);
          if (!base) base = await createRevision(document, document.currentApprovedSnapshot, undefined, true);
          document.baseRevisionId = base._id;
        }
      }
      if (!base) {
        base = await createRevision(document, document.currentApprovedSnapshot, undefined, true);
        document.baseRevisionId = base._id;
      }
      const proposal = await createRevision(document, document.proposedChanges, document.baseRevisionId, Boolean(previous));
      document.proposedRevisionId = proposal._id;
    }
  } else {
    let revision = await matchingRevision(document.revisionId, document, document);
    let baseRevisionId = previous?.revisionId;
    if (!baseRevisionId && previous) {
      const baseline = await createRevision(previous, previous, undefined, true);
      baseRevisionId = baseline._id;
      if (contentHash(previous) === contentHash(document)) revision = baseline;
    }
    if (!revision && modelName === 'ApprovedContent') {
      const submission = await Submission.findById(idOf(document.submissionId));
      revision = await matchingRevision(submission?.revisionId, document, document);
    }
    if (!revision) revision = await createRevision(document, document, baseRevisionId);
    document.revisionId = revision._id;
  }
  await document.save({});
  return document;
}


export { saveDocument, idOf };
