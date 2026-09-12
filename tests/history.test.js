import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);
mongoose.set('bufferCommands', false);

const { default: Submission } = await import('../models/Submission.js');
const { default: AmendmentRequest } = await import('../models/AmendmentRequest.js');
const { default: ApprovedContent } = await import('../models/ApprovedContent.js');
const { default: SubmissionRevision } = await import('../models/SubmissionRevision.js');
const { default: MediaAsset } = await import('../models/MediaAsset.js');
const { contentSnapshot, contentHash } = await import('../models/shared/content.js');
const { saveWithHistory, saveAmendmentWithHistory, reviewSubmission, reviewAmendment, cancelAmendment } = await import('../services/contentHistory.js');

// In-memory collection adapter: exercises actual Mongoose casting, validation, save hooks,
// optimistic version checks and service ordering without a MongoDB server or transactions.
// This is a unit adapter, not a substitute for testing MongoDB's concurrency implementation.
const stores = new Map();
const originals = [];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const get = (object, path) => path.split('.').reduce((current, key) => current?.[key], object);
const equal = (a, b) => JSON.stringify(clone(a)) === JSON.stringify(clone(b));
function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(part => matches(doc, part));
    const current = get(doc, key);
    if (value === null) return current == null;
    if (value && typeof value === 'object' && !value._bsontype && !(value instanceof Date)) {
      if ('$in' in value) return value.$in.some(v => equal(current, v));
      if ('$ne' in value) return !equal(current, value.$ne);
      if ('$exists' in value) return (current !== undefined) === value.$exists;
    }
    return equal(current, value);
  });
}
function set(doc, path, value, remove = false) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((obj, key) => obj[key] ||= {}, doc);
  if (remove) delete target[last];
  else target[last] = clone(value);
}
function update(doc, changes, inserting = false) {
  for (const [op, fields] of Object.entries(changes)) {
    for (const [path, value] of Object.entries(fields)) {
      if (op === '$set' || (op === '$setOnInsert' && inserting)) set(doc, path, value);
      if (op === '$inc') set(doc, path, (get(doc, path) || 0) + value);
      if (op === '$max') set(doc, path, Math.max(get(doc, path) || 0, value));
      if (op === '$unset') set(doc, path, undefined, true);
    }
  }
}
function project(doc, projection) {
  const result = clone(doc);
  if (!result) return result;
  for (const [key, included] of Object.entries(projection || {})) if (!included) delete result[key];
  return result;
}
let failWrite;
for (const Model of [Submission, AmendmentRequest, ApprovedContent, SubmissionRevision, MediaAsset]) {
  const records = [];
  stores.set(Model.modelName, records);
  function find(filter, options = {}) {
    const selected = records.filter(doc => matches(doc, filter));
    for (const [field, direction] of Object.entries(options.sort || {})) selected.sort((a, b) => (get(a, field) > get(b, field) ? 1 : -1) * direction);
    return selected[0];
  }
  const methods = {
    async insertOne(doc) {
      if (failWrite?.(Model.modelName, { $set: doc })) throw new Error('Simulated write failure');
      if (records.some(record => equal(record._id, doc._id))) throw Object.assign(new Error('Duplicate key'), { code: 11000 });
      records.push(clone(doc));
      return { acknowledged: true, insertedId: doc._id };
    },
    async findOne(filter, options = {}) { return project(find(filter, options) || null, options.projection); },
    async updateOne(filter, changes) {
      if (failWrite?.(Model.modelName, changes)) throw new Error('Simulated write failure');
      const doc = find(filter);
      if (doc) update(doc, changes);
      return { acknowledged: true, matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    },
    async findOneAndUpdate(filter, changes, options = {}) {
      let doc = find(filter);
      const before = clone(doc);
      if (!doc && options.upsert) {
        doc = { _id: String(new mongoose.Types.ObjectId()), ...clone(filter) };
        update(doc, changes, true); records.push(doc);
      } else if (doc) update(doc, changes);
      return project(options.returnDocument === 'after' ? doc : before, options.projection) || null;
    },
    async countDocuments(filter) { return records.filter(doc => matches(doc, filter)).length; },
  };
  for (const [key, method] of Object.entries(methods)) {
    originals.push([Model.collection, key, Model.collection[key]]);
    Model.collection[key] = method;
  }
}
beforeEach(() => { for (const store of stores.values()) store.length = 0; failWrite = undefined; });
after(() => { for (const [target, key, original] of originals) target[key] = original; });
const owner = new mongoose.Types.ObjectId();
const reviewer = new mongoose.Types.ObjectId();
function submissionData() {
  return { userId: owner, country: 'India', stateRegion: 'Nagaland', tribe: 'Ao', culturalDomain: 'Folk Song',
    title: 'Original song', description: 'A community song', keywords: ['song'], language: 'Ao',
    contentFileType: 'audio', contentUrl: 'https://res.cloudinary.com/test/video/upload/song.mp3', contentCloudinaryId: 'song',
    consent: { fileType: 'pdf', fileUrl: 'https://res.cloudinary.com/test/raw/upload/consent.pdf', fileCloudinaryId: 'consent',
      consentType: 'Individual Consent', consentNames: 'Contributor', consentDate: new Date('2025-01-01'), permissionType: ['Research'], duration: 'permanent' },
    accessTier: 'Public', ethicsAgreed: true };
}
async function createSubmission() { const doc = new Submission(submissionData()); await saveWithHistory(doc); return doc; }
async function createAmendment(submission, title = 'Updated song') {
  const publication = await ApprovedContent.findOne({ submissionId: submission._id });
  const baseline = contentSnapshot(publication || submission);
  const amendment = new AmendmentRequest({ submissionId: submission._id, approvedContentId: publication?._id || null, userId: owner,
    changesSummary: 'Correct title', versionNumber: 2, previousVersionNumber: publication?.currentVersion || 0,
    currentApprovedSnapshot: baseline, proposedChanges: { ...baseline, title } });
  await saveAmendmentWithHistory(amendment, submission);
  return amendment;
}

test('snapshot cloning preserves the original nested consent and produces stable hashes', () => {
  const doc = new Submission(submissionData());
  const original = contentSnapshot(doc);
  const proposal = structuredClone(original);
  proposal.consent.consentNames = 'Changed name';
  assert.equal(original.consent.consentNames, 'Contributor');
  assert.equal(contentHash(original), contentHash(doc));
  assert.notEqual(contentHash(proposal), contentHash(original));
  assert.equal(original.consent._id, undefined);
});

test('a submission saves its first revision and retains both content and consent assets', async () => {
  const submission = await createSubmission();
  const revisions = stores.get('SubmissionRevision');
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].revisionNumber, 1);
  assert.equal(revisions[0].legacy, false);
  assert.equal(String(submission.revisionId), revisions[0]._id);
  assert.equal(stores.get('MediaAsset').filter(a => a.retained).length, 2);
});

test('editing a submission preserves its old snapshot and records a new revision', async () => {
  const submission = await createSubmission();
  submission.title = 'Corrected title';
  await saveWithHistory(submission);
  assert.deepEqual(stores.get('SubmissionRevision').map(r => r.content.title), ['Original song', 'Corrected title']);
});

test('initial approval reuses the saved snapshot and publishes one record', async () => {
  const submission = await createSubmission();
  await reviewSubmission(submission._id, reviewer, true);
  assert.equal(stores.get('ApprovedContent').length, 1);
  assert.equal(stores.get('SubmissionRevision').length, 1);
  assert.equal(stores.get('Submission')[0].status, 'approved');
  assert.equal(stores.get('Submission')[0].pendingReview, undefined);
});

test('a pending submission accepts an amendment without an approved-content reference', async () => {
  const submission = await createSubmission();
  const amendment = await createAmendment(submission);
  assert.equal(amendment.approvedContentId, null);
  assert.ok(amendment.proposedRevisionId);
  assert.equal(stores.get('SubmissionRevision').length, 2);
  await reviewAmendment(amendment._id, reviewer, true);
  assert.equal(stores.get('ApprovedContent')[0].title, 'Updated song');
});

test('rejection preserves published content, proposal snapshots and retained media', async () => {
  const submission = await createSubmission();
  await reviewSubmission(submission._id, reviewer, true);
  const amendment = await createAmendment(await Submission.findById(submission._id));
  await reviewAmendment(amendment._id, reviewer, false, 'Needs correction');
  assert.equal(stores.get('ApprovedContent')[0].title, 'Original song');
  assert.equal(stores.get('AmendmentRequest')[0].status, 'rejected');
  assert.equal(stores.get('SubmissionRevision').length, 2);
  assert.ok(stores.get('MediaAsset').every(a => a.retained));
});

test('a failed write after publication can be resumed without duplicate publication or amendment counts', async () => {
  const submission = await createSubmission();
  await reviewSubmission(submission._id, reviewer, true);
  const amendment = await createAmendment(await Submission.findById(submission._id));
  failWrite = (model, changes) => model === 'Submission' && changes.$set?.title === 'Updated song';
  await assert.rejects(reviewAmendment(amendment._id, reviewer, true), /Simulated write failure/);
  assert.ok(stores.get('Submission')[0].pendingReview);
  assert.equal(stores.get('Submission')[0].historyLock, undefined);
  failWrite = undefined;
  await reviewAmendment(amendment._id, reviewer, true);
  assert.equal(stores.get('ApprovedContent').length, 1);
  assert.equal(stores.get('ApprovedContent')[0].totalAmendments, 1);
  assert.equal(stores.get('Submission')[0].title, 'Updated song');
  assert.equal(stores.get('Submission')[0].pendingReview, undefined);
});

test('an unfinished approval cannot be changed into a rejection on retry', async () => {
  const submission = await createSubmission();
  failWrite = (model) => model === 'ApprovedContent';
  await assert.rejects(reviewSubmission(submission._id, reviewer, true), /Simulated write failure/);
  failWrite = undefined;
  await assert.rejects(reviewSubmission(submission._id, reviewer, false), /Finish the existing review/);
});

test('cancelling an amendment preserves its revision and allows another attempt', async () => {
  const submission = await createSubmission();
  const first = await createAmendment(submission);
  await cancelAmendment(first._id, owner);
  const second = await createAmendment(await Submission.findById(submission._id), 'Another proposal');
  assert.ok(second.versionNumber > first.versionNumber);
  assert.equal(stores.get('AmendmentRequest')[0].status, 'cancelled');
  assert.equal(stores.get('SubmissionRevision').length, 3);
});

test('concurrent approval requests cannot both claim a submission', async () => {
  const submission = await createSubmission();
  const results = await Promise.allSettled([reviewSubmission(submission._id, reviewer, true), reviewSubmission(submission._id, reviewer, false)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});

test('revisions reject mutation through Mongoose update methods', async () => {
  await assert.rejects(SubmissionRevision.updateOne({}, { $set: { 'content.title': 'Changed' } }), /immutable/);
});

test('a retained asset owned by another user cannot be attached to a new submission', async () => {
  await createSubmission();
  const other = new Submission({ ...submissionData(), userId: new mongoose.Types.ObjectId() });
  await assert.rejects(saveWithHistory(other), /another user/);
});
