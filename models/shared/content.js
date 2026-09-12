import mongoose from "mongoose";
import { createHash } from "node:crypto";

// Shared snapshot shape. Optional fields preserve older records during migration.
// Submission validation remains responsible for completeness at the upload boundary.
export const consentSchema = new mongoose.Schema(
  {
    fileType: String,
    fileUrl: String,
    fileCloudinaryId: String,
    consentType: String,
    consentNames: String,
    consentDate: Date,
    permissionType: { type: [String], default: undefined },
    duration: String,
    digitalSignature: String,
  },
  { _id: false },
);

export const contentSchema = new mongoose.Schema(
  {
    country: String,
    stateRegion: String,
    tribe: String,
    village: String,
    culturalDomain: String,
    title: String,
    description: String,
    keywords: { type: [String], default: undefined },
    language: String,
    dateOfRecording: Date,
    culturalSignificance: String,
    contentFileType: String,
    contentUrl: String,
    contentCloudinaryId: String,
    consent: consentSchema,
    accessTier: String,
    contentWarnings: { type: [String], default: undefined },
    warningOtherText: String,
    translationFileUrl: String,
    translationCloudinaryId: String,
    backgroundInfo: String,
    verificationDocUrl: String,
    verificationCloudinaryId: String,
    ethicsAgreed: Boolean,
  },
  { _id: false, strict: "throw" },
);

const fields = Object.keys(contentSchema.paths);

export function contentSnapshot(value) {
  const source = value?.toObject ? value.toObject() : value;
  const snapshot = {};
  for (const field of fields) {
    if (source?.[field] !== undefined) snapshot[field] = source[field];
  }
  // Cast dates and strip subdocument IDs so hashing is stable across legacy/new documents.
  const cast = new mongoose.Document(snapshot, contentSchema).toObject();
  return JSON.parse(JSON.stringify(cast));
}

export function contentHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(contentSnapshot(value)))
    .digest("hex");
}

export function applyContentSnapshot(document, value) {
  const snapshot = contentSnapshot(value);
  for (const field of fields) {
    if (document.schema.path(field) || document.schema.nested[field]) document.set(field, snapshot[field]);
  }
}

export function contentFiles(value) {
  const content = contentSnapshot(value);
  return [
    { url: content.contentUrl, publicId: content.contentCloudinaryId },
    {
      url: content.consent?.fileUrl,
      publicId: content.consent?.fileCloudinaryId,
    },
    {
      url: content.translationFileUrl,
      publicId: content.translationCloudinaryId,
    },
    {
      url: content.verificationDocUrl,
      publicId: content.verificationCloudinaryId,
    },
  ].filter((file) => file.url);
}
