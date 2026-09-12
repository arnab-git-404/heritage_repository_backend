import mongoose from "mongoose";
import { contentSchema } from "./shared/content.js";

const submissionRevisionSchema = new mongoose.Schema(
  {
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Submission",
      required: true,
    },
    revisionNumber: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    baseRevisionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubmissionRevision",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sourceType: {
      type: String,
      enum: ["Submission", "ApprovedContent", "AmendmentRequest"],
      required: true,
    },
    sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    snapshotKey: { type: String, required: true, unique: true },
    changesSummary: { type: String, maxlength: 500 },
    content: { type: contentSchema, required: true },
    contentHash: { type: String, required: true },
    assets: [{ type: mongoose.Schema.Types.ObjectId, ref: "MediaAsset" }],
    // A legacy snapshot is the earliest recoverable state, not necessarily the original upload.
    legacy: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

submissionRevisionSchema.index(
  { submissionId: 1, revisionNumber: 1 },
  { unique: true },
);
submissionRevisionSchema.index({ sourceType: 1, sourceId: 1 });
submissionRevisionSchema.index({ assets: 1 });

submissionRevisionSchema.pre("save", function () {
  if (!this.isNew)
    throw new Error("Revisions are immutable; create a new revision instead");
});
for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteMany",
  "findOneAndDelete",
]) {
  submissionRevisionSchema.pre(operation, function () {
    throw new Error("Revisions are immutable");
  });
}
submissionRevisionSchema.pre(
  "deleteOne",
  { document: true, query: true },
  function () {
    throw new Error("Revisions are immutable");
  },
);

export default mongoose.model("SubmissionRevision", submissionRevisionSchema);
