
import mongoose from 'mongoose';

const consentSchema = new mongoose.Schema({
  fileType: {
    type: String,
    enum: ['pdf', 'audio', 'video'],
    required: true
  },
  fileUrl: {
    type: String,
    required: true
  },
  fileCloudinaryId: String,
  consentType: {
    type: String,
    enum: ['Individual Consent', 'Collective / Community Consent', 'Custodian Consent'],
    required: true
  },
  consentNames: {
    type: String,
    required: true
  },
  consentDate: {
    type: Date,
    required: true
  },
  permissionType: [{
    type: String,
    enum: ['Educational', 'Research', 'Cultural Display', 'All the above']
  }],
  duration: {
    type: String,
    enum: ['permanent', 'temporary'],
    required: true
  },
  digitalSignature: String
});

const submissionSchema = new mongoose.Schema({
  revisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubmissionRevision' },
  revisionSequence: { type: Number, default: 0 },
  historyLock: {
    type: new mongoose.Schema({ token: String, startedAt: Date }, { _id: false }),
    select: false,
  },
  pendingReview: {
    type: new mongoose.Schema({
      operationId: { type: mongoose.Schema.Types.ObjectId, required: true },
      kind: { type: String, enum: ['submission', 'amendment'], required: true },
      amendmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'AmendmentRequest' },
      reviewerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      approved: { type: Boolean, required: true },
      reason: String,
      revisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubmissionRevision', required: true },
      publicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovedContent', required: true },
      publicationVersion: { type: Number, required: true },
      totalAmendments: { type: Number, required: true },
      reviewedAt: { type: Date, required: true },
      restorePublished: Boolean,
      submissionStatus: { type: String, enum: ['pending', 'approved', 'rejected'], required: true },
    }, { _id: false }),
    select: false,
  },
  // User reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // Step 2: Category Selection
  country: {
    type: String,
    required: true
  },
  stateRegion: {
    type: String,
    required: true
  },
  tribe: {
    type: String,
    required: true
  },
  village: String,
  culturalDomain: {
    type: String,
    required: true,
    enum: ['Folk Song', 'Folk Dance', 'Folk Tale', 'Ritual', 'Material Culture', 'Sacred Site', 'Oral Narrative', 'Other']
  },
  title: {
    type: String,
    required: true,
    trim: true
  },

  // Step 3: Content Description
  description: {
    type: String,
    required: true,
    maxlength: 1500
  },
  keywords: {
    type: [String],
    required: true
  },
  language: {
    type: String,
  },
  dateOfRecording: Date,
  culturalSignificance: String,

  // Step 4: Content File
  contentFileType: {
    type: String,
    required: true,
    enum: ['audio', 'video', 'image', 'text', '3d']
  },
  contentUrl: {
    type: String,
    required: true
  },
  contentCloudinaryId: String, // For deletion later

  // Step 5: Consent Upload
  consent: {
    type: consentSchema,
    required: true
  },

  // Step 6: Access Classification
  accessTier: {
    type: String,
    required: true,
    enum: ['Public', 'Restricted', 'Confidential/Sacred']
  },
  contentWarnings: [{
    type: String,
    enum: ['Sacred object', 'Deceased person', 'Ritual context', 'Other']
  }],
  warningOtherText: String,

  // Step 7: Additional Verification (Optional)
  translationFileUrl: String,
  translationCloudinaryId: String,
  backgroundInfo: String,
  verificationDocUrl: String,
  verificationCloudinaryId: String,

  // Step 8: Ethics Acknowledgement
  ethicsAgreed: {
    type: Boolean,
    required: true,
    default: false
  },

  // Status tracking
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },

  isResubmission: {
    type: Boolean,
    default: false
  },
  resubmissionCount: {
    type: Number,
    default: 0
  },
  originalSubmissionDate: Date,
  lastResubmissionDate: Date,

    // ✅ NEW: User-provided change summary
  changesSummary: {
    type: String,
    maxlength: 500
  },

  // Review details
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewedAt: Date,
  
  statusChangeReason: String,
  approvedAt: Date,


  previousVersion: {
    type: Object,
    required: false
  },
  previousVersionDate: Date,
  
  
  rejectionReason: String,

  // Metadata
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  optimisticConcurrency: true
});

// Index for faster queries
// submissionSchema.index({ userId: 1, status: 1 });
// submissionSchema.index({ status: 1, createdAt: -1 });
// submissionSchema.index({ country: 1, tribe: 1 });

export default mongoose.model('Submission', submissionSchema);
