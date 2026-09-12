import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import Submission from '../models/Submission.js';
import SubmissionRevision from '../models/SubmissionRevision.js';
import ApprovedContent from '../models/ApprovedContent.js';
import AmendmentRequest from '../models/AmendmentRequest.js';

const router = express.Router();

async function requireOwner(req, res, next) {
  try {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    if (!token) return res.status(401).json({ errors: [{ msg: 'Authentication required' }] });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(401).json({ errors: [{ msg: 'Invalid or expired token' }] }); }
    if (!payload?.user?.id) return res.status(401).json({ errors: [{ msg: 'Invalid token' }] });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ errors: [{ msg: 'Invalid submission ID' }] });
    const submission = await Submission.findOne({ _id: req.params.id, userId: payload.user.id });
    if (!submission) return res.status(404).json({ errors: [{ msg: 'Submission not found' }] });
    req.submission = submission;
    next();
  } catch (error) { next(error); }
}

// This response matches the existing VersionHistory page; the snapshot endpoint is additive.
router.get('/:id/versions', requireOwner, async (req, res, next) => {
  try {
    const submission = req.submission;
    const [revisions, publication, amendments] = await Promise.all([
      SubmissionRevision.find({ submissionId: submission._id }).select('-content -contentHash -assets').sort({ revisionNumber: -1 }).populate('createdBy', 'name').lean(),
      ApprovedContent.findOne({ submissionId: submission._id }).select('revisionId').lean(),
      AmendmentRequest.find({ submissionId: submission._id }).select('proposedRevisionId baseRevisionId status reviewedBy reviewedAt rejectionReason changesSummary versionNumber requestedAt userId').populate('reviewedBy', 'name').populate('userId', 'name').lean(),
    ]);
    const byRevision = new Map(amendments.filter(a => a.proposedRevisionId).map(a => [String(a.proposedRevisionId), a]));
    const versions = revisions.map(revision => {
      const amendment = byRevision.get(String(revision._id));
      const published = String(publication?.revisionId) === String(revision._id);
      const isCurrentSubmission = String(submission.revisionId) === String(revision._id);
      return {
        revisionId: revision._id, version: revision.revisionNumber,
        status: published ? 'approved' : amendment?.status || (isCurrentSubmission ? submission.status : 'archived'),
        changesSummary: revision.changesSummary,
        updatedAt: revision.createdAt, updatedBy: revision.createdBy,
        reviewedBy: amendment?.reviewedBy, reviewedAt: amendment?.reviewedAt,
        rejectionReason: amendment?.rejectionReason,
        isOriginal: revision.revisionNumber === 1 && !revision.legacy,
        legacy: revision.legacy,
        sourceType: revision.sourceType,
        amendmentRequestId: amendment?._id,
        approvedContentId: published ? publication._id : undefined,
      };
    });
    // Unmigrated records remain visible without writing to the database on a GET.
    if (!versions.length) {
      versions.push({ version: 1, status: submission.status, changesSummary: 'Legacy submission; snapshot migration pending',
        updatedAt: submission.createdAt, isOriginal: false, legacy: true, sourceType: 'Submission' });
    }
    for (const amendment of amendments.filter(a => !a.proposedRevisionId)) {
      versions.push({ version: amendment.versionNumber, status: amendment.status, changesSummary: amendment.changesSummary,
        updatedAt: amendment.requestedAt, updatedBy: amendment.userId, reviewedBy: amendment.reviewedBy,
        reviewedAt: amendment.reviewedAt, rejectionReason: amendment.rejectionReason,
        amendmentRequestId: amendment._id, isOriginal: false, legacy: true, sourceType: 'AmendmentRequest' });
    }
    res.json({ submissionTitle: submission.title, currentRevisionId: publication?.revisionId, versions });
  } catch (error) { next(error); }
});

router.get('/:id/revisions/:revisionNumber', requireOwner, async (req, res, next) => {
  try {
    const revisionNumber = Number(req.params.revisionNumber);
    if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) {
      return res.status(400).json({ errors: [{ msg: 'Invalid revision number' }] });
    }
    const revision = await SubmissionRevision.findOne({ submissionId: req.submission._id, revisionNumber }).lean();
    if (!revision) return res.status(404).json({ errors: [{ msg: 'Revision not found' }] });
    res.json({ revisionId: revision._id, version: revision.revisionNumber, data: revision.content, legacy: revision.legacy });
  } catch (error) { next(error); }
});

router.use((error, req, res, next) => {
  console.error('Revision history error:', error);
  res.status(500).json({ errors: [{ msg: 'Failed to load revision history' }] });
});

export default router;
