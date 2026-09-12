import mongoose from "mongoose";

const amendmentRequestSchema = new mongoose.Schema(
  {
    baseRevisionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubmissionRevision",
    },
    proposedRevisionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubmissionRevision",
    },
    // Reference to original submission
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Submission",
      required: true,
      index: true,
    },

    // Reference to current approved content
    approvedContentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ApprovedContent",
      default: null,
      index: true,
    },

    // User who requested amendment
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Version tracking
    versionNumber: {
      type: Number,
      required: true,
      default: 1,
    },

    // Previous approved version number (what we're amending from)
    previousVersionNumber: {
      type: Number,
      required: true,
    },

    // Amendment summary
    changesSummary: {
      type: String,
      required: true,
      maxlength: 500,
    },

    // Detailed change tracking
    changedFields: [
      {
        fieldName: String,
        oldValue: mongoose.Schema.Types.Mixed,
        newValue: mongoose.Schema.Types.Mixed,
        changeType: {
          type: String,
          enum: ["text", "file", "array", "object"],
        },
      },
    ],

    // PROPOSED CHANGES (New data user wants to apply)
    proposedChanges: {
      ethicsAgreed: Boolean,
      country: String,
      stateRegion: String,
      tribe: String,
      village: String,
      culturalDomain: String,
      title: String,
      description: String,
      keywords: [String],
      language: String,
      dateOfRecording: Date,
      culturalSignificance: String,

      contentFileType: String,
      contentUrl: String,
      contentCloudinaryId: String,

      consent: {
        fileType: String,
        fileUrl: String,
        fileCloudinaryId: String,
        consentType: String,
        consentNames: String,
        consentDate: Date,
        permissionType: [String],
        duration: String,
        digitalSignature: String,
      },

      accessTier: String,
      contentWarnings: [String],
      warningOtherText: String,

      translationFileUrl: String,
      translationCloudinaryId: String,
      backgroundInfo: String,
      verificationDocUrl: String,
      verificationCloudinaryId: String,
    },

    // SNAPSHOT of current approved version (for rollback)
    currentApprovedSnapshot: {
      ethicsAgreed: Boolean,
      country: String,
      stateRegion: String,
      tribe: String,
      village: String,
      culturalDomain: String,
      title: String,
      description: String,
      keywords: [String],
      language: String,
      dateOfRecording: Date,
      culturalSignificance: String,

      contentFileType: String,
      contentUrl: String,
      contentCloudinaryId: String,

      consent: {
        fileType: String,
        fileUrl: String,
        fileCloudinaryId: String,
        consentType: String,
        consentNames: String,
        consentDate: Date,
        permissionType: [String],
        duration: String,
        digitalSignature: String,
      },

      accessTier: String,
      contentWarnings: [String],
      warningOtherText: String,

      translationFileUrl: String,
      translationCloudinaryId: String,
      backgroundInfo: String,
      verificationDocUrl: String,
      verificationCloudinaryId: String,
    },

    // Status tracking
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },

    // Review details
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    reviewedAt: Date,
    reviewNotes: String,
    rejectionReason: String,

    // Timestamps
    requestedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    approvedAt: Date,
    rejectedAt: Date,
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  },
);

// Compound indexes for efficient queries
// amendmentRequestSchema.index({ submissionId: 1, status: 1 });
// amendmentRequestSchema.index({ userId: 1, status: 1 });
// amendmentRequestSchema.index({ status: 1, requestedAt: -1 });
// amendmentRequestSchema.index({ submissionId: 1, versionNumber: -1 });

export default mongoose.model("AmendmentRequest", amendmentRequestSchema);
