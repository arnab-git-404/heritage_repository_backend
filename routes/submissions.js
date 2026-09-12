import { saveWithHistory, reviewSubmission } from '../services/contentHistory.js';
import { contentSnapshot } from '../models/shared/content.js';
import revisionRoutes from './revisions.js';
import { registerUpload } from '../services/mediaAssets.js';
import express from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import Submission from '../models/Submission.js';
import ApprovedContent from '../models/ApprovedContent.js';
import streamifier from 'streamifier';
import dotenv from 'dotenv';
import { dbConnect } from '../utils/db.js';
import AmendmentRequest from '../models/AmendmentRequest.js';
import { attachUserDetails } from '../utils/userDetails.js';
import { requirePermission } from '../middleware/rbac.js';
import { PERMISSIONS } from '../constants/permissions.js';

const router = express.Router();
router.use(revisionRoutes);

dotenv.config();

// Configure Cloudinary with explicit config check
const cloudinaryConfig = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
};

// Validate Cloudinary config before setting
if (!cloudinaryConfig.cloud_name || !cloudinaryConfig.api_key || !cloudinaryConfig.api_secret) {
  console.error('❌ Cloudinary configuration missing:', {
    cloud_name: cloudinaryConfig.cloud_name ? '✓' : '✗',
    api_key: cloudinaryConfig.api_key ? '✓' : '✗',
    api_secret: cloudinaryConfig.api_secret ? '✓' : '✗'
  });
  throw new Error('Cloudinary credentials not configured properly');
}

cloudinary.config(cloudinaryConfig);

console.log('✅ Cloudinary configured:', {
  cloud_name: cloudinaryConfig.cloud_name,
  api_key: cloudinaryConfig.api_key ? cloudinaryConfig.api_key.substring(0, 5) + '***' : 'missing'
});

// Multer config for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 200 * 1024 * 1024, // 200MB
    files: 5
  }
});

// Auth middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  
  if (!token) {
    return res.status(401).json({ errors: [{ msg: 'Authentication required' }] });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload?.user?.id) {
      return res.status(401).json({ errors: [{ msg: 'Invalid token' }] });
    }
    req.userId = payload.user.id;
    next();
  } catch (error) {
    return res.status(401).json({ errors: [{ msg: 'Invalid or expired token' }] });
  }
}

// ✅ FIXED: Helper function with correct parameters
async function uploadToCloudinary(buffer, folder = 'submissions', originalFilename = '', ownerId, mimeType) {
  return new Promise((resolve, reject) => {
    // Detect file type
    const isPdf = originalFilename.toLowerCase().endsWith('.pdf');
    
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: folder,
        resource_type: 'auto',
        type: 'upload',
        access_mode: 'public',
        unique_filename: true,
        transformation: [{ fetch_format: "auto" }] 
      },
      (error, result) => {
        if (error) {
          console.error('Cloudinary upload error:', error);
          reject(error);
        } else {
          console.log('✅ Uploaded to Cloudinary:', result.secure_url);
          resolve({
            public_id: result.public_id,
            secure_url: result.secure_url,
            resource_type: result.resource_type, bytes: result.bytes
          });
        }
      }
    );

    streamifier.createReadStream(buffer).pipe(uploadStream);
  }).then(async result => {
    await registerUpload(ownerId, result, { originalname: originalFilename, mimetype: mimeType, buffer, size: buffer.length });
    return result;
  });
}

// ✅ FIXED: Complete POST route with all fields
router.post('/', requireAuth, upload.fields([
  { name: 'contentFile', maxCount: 1 },
  { name: 'consentFile', maxCount: 1 },
  { name: 'translationFile', maxCount: 1 },
  { name: 'verificationDoc', maxCount: 1 }
]), async (req, res) => {
  try {
    console.log('📝 New submission request from user:', req.userId);
    console.log('Files received:', Object.keys(req.files || {}));
    console.log('Body received:', Object.keys(req.body));

    // ✅ FIXED: Complete destructuring with all fields
    const {
      country, stateRegion, tribe, village, culturalDomain, title,
      description, keywords, language, dateOfRecording, culturalSignificance,
      contentFileType,
      consentFileType, consentType, consentNames, consentDate, 
      permissionType, consentDuration, digitalSignature,
      accessTier, contentWarnings, warningOtherText,
      backgroundInfo,
      ethicsAgreed
    } = req.body;

    // Validate required fields
    if (!country || !stateRegion || !tribe || !culturalDomain || !title) {
      return res.status(400).json({ errors: [{ msg: 'Missing required category fields' }] });
    }

    if (!description || !keywords) {
      return res.status(400).json({ errors: [{ msg: 'Missing required description fields' }] });
    }

    if (!accessTier || !ethicsAgreed || ethicsAgreed !== 'true') {
      return res.status(400).json({ errors: [{ msg: 'Ethics agreement is required' }] });
    }

    // Upload content file
    console.log('⬆️  Uploading content file...');
    let contentUrl = '';
    let contentCloudinaryId = '';
    
    if (req.files?.contentFile?.[0]) {
      try {
        const file = req.files.contentFile[0];
        console.log('Content file:', file.originalname, file.mimetype, file.size);
        
        const contentResult = await uploadToCloudinary(
          file.buffer,
          `submissions/${req.userId}/content`,
          file.originalname, req.userId, file.mimetype
        );
        
        contentUrl = contentResult.secure_url;
        contentCloudinaryId = contentResult.public_id;
        console.log('✅ Content uploaded:', contentUrl);
      } catch (error) {
        console.error('❌ Content upload failed:', error);
        return res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
          errors: [{ msg: 'Failed to upload content file: ' + error.message }] 
        });
      }
    } else {
      return res.status(400).json({ errors: [{ msg: 'Content file is required' }] });
    }

    // Upload consent file
    console.log('⬆️  Uploading consent file...');
    let consentFileUrl = '';
    let consentCloudinaryId = '';
    
    if (req.files?.consentFile?.[0]) {
      try {
        const file = req.files.consentFile[0];
        console.log('Consent file:', file.originalname, file.mimetype, file.size);
        
        const consentResult = await uploadToCloudinary(
          file.buffer,
          `submissions/${req.userId}/consent`,
          file.originalname, req.userId, file.mimetype
        );
        
        consentFileUrl = consentResult.secure_url;
        consentCloudinaryId = consentResult.public_id;
        console.log('✅ Consent uploaded:', consentFileUrl);
      } catch (error) {
        console.error('❌ Consent upload failed:', error);
        return res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
          errors: [{ msg: 'Failed to upload consent file: ' + error.message }] 
        });
      }
    } else {
      return res.status(400).json({ errors: [{ msg: 'Consent file is required' }] });
    }

    // Optional files
    let translationFileUrl = '';
    let translationCloudinaryId = '';
    if (req.files?.translationFile?.[0]) {
      console.log('⬆️  Uploading translation file...');
      try {
        const file = req.files.translationFile[0];
        const translationResult = await uploadToCloudinary(
          file.buffer,
          `submissions/${req.userId}/translation`,
          file.originalname, req.userId, file.mimetype
        );
        translationFileUrl = translationResult.secure_url;
        translationCloudinaryId = translationResult.public_id;
        console.log('✅ Translation uploaded:', translationFileUrl);
      } catch (error) {
        console.error('⚠️  Translation upload failed:', error);
        // Non-critical, continue
      }
    }

    let verificationDocUrl = '';
    let verificationCloudinaryId = '';
    if (req.files?.verificationDoc?.[0]) {
      console.log('⬆️  Uploading verification document...');
      try {
        const file = req.files.verificationDoc[0];
        const verificationResult = await uploadToCloudinary(
          file.buffer,
          `submissions/${req.userId}/verification`,
          file.originalname, req.userId, file.mimetype
        );
        verificationDocUrl = verificationResult.secure_url;
        verificationCloudinaryId = verificationResult.public_id;
        console.log('✅ Verification uploaded:', verificationDocUrl);
      } catch (error) {
        console.error('⚠️  Verification upload failed:', error);
        // Non-critical, continue
      }
    }

    // Create submission
    console.log('💾 Saving submission to database...');
    const submission = new Submission({
      userId: req.userId,
      country,
      stateRegion,
      tribe,
      village,
      culturalDomain,
      title,
      description,
      keywords: typeof keywords === 'string' ? keywords.split(',').map(k => k.trim()) : keywords,
      language: language || 'Unknown',
      dateOfRecording: dateOfRecording || null,
      culturalSignificance,
      contentFileType,
      contentUrl,
      contentCloudinaryId,
      consent: {
        fileType: consentFileType,
        fileUrl: consentFileUrl,
        fileCloudinaryId: consentCloudinaryId,
        consentType,
        consentNames,
        consentDate,
        permissionType: typeof permissionType === 'string' ? JSON.parse(permissionType) : permissionType,
        duration: consentDuration,
        digitalSignature
      },
      accessTier,
      contentWarnings: typeof contentWarnings === 'string' ? JSON.parse(contentWarnings) : contentWarnings || [],
      warningOtherText,
      translationFileUrl,
      translationCloudinaryId,
      backgroundInfo,
      verificationDocUrl,
      verificationCloudinaryId,
      ethicsAgreed: true,
      status: 'pending'
    });

    await dbConnect();

    await saveWithHistory(submission);
    console.log('✅ Submission saved:', submission._id);

    res.status(201).json({
      message: 'Submission created successfully',
      submission: {
        id: submission._id,
        title: submission.title,
        status: submission.status
      }
    });

  } catch (error) {
    console.error('❌ Submission error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
      errors: [{ 
        msg: 'Failed to create submission', 
        detail: error.message 
      }] 
    });
  }
});

// GET /api/submissions/my - Get user's own submissions WITH latest data
router.get('/my', requireAuth, async (req, res) => {
  try {
    await dbConnect();

    // Fetch all user's submissions
    const submissions = await Submission.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .select('-__v');

    // For each submission, fetch amendment status and latest data
    const submissionsWithStatus = await Promise.all(
      submissions.map(async (submission) => {
        const submissionObj = submission.toObject();

        // Check for pending amendment
        const pendingAmendment = await AmendmentRequest.findOne({
          submissionId: submission._id,
          status: 'pending'
        }).sort({ requestedAt: -1 });

        // Get latest approved amendment (if any)
        const latestApprovedAmendment = await AmendmentRequest.findOne({
          submissionId: submission._id,
          status: 'approved'
        }).sort({ versionNumber: -1 });

        // Get latest rejected amendment
        const latestRejectedAmendment = await AmendmentRequest.findOne({
          submissionId: submission._id,
          status: 'rejected'
        }).sort({ rejectedAt: -1 });

        // Calculate current version
        let currentVersion = 1;
        if (latestApprovedAmendment) {
          currentVersion = latestApprovedAmendment.versionNumber;
        }

        // ✅ DETERMINE WHAT DATA TO SHOW USER
        let displayData = { ...submissionObj };
        let dataSource = 'submission'; // Default: original submission

        // If there's a pending amendment, show the PROPOSED changes
        if (pendingAmendment) {
          displayData = {
            ...submissionObj,
            ...pendingAmendment.proposedChanges, // Merge proposed changes
            _originalData: submissionObj // Keep original for reference
          };
          dataSource = 'pendingAmendment';
        }
        // If no pending but has approved amendments, data is already in ApprovedContent
        // (submission data might be outdated, so we should fetch from ApprovedContent)
        else if (submission.status === 'approved' && latestApprovedAmendment) {
          const ApprovedContent = (await import('../models/ApprovedContent.js')).default;
          const approvedContent = await ApprovedContent.findOne({
            submissionId: submission._id
          });

          if (approvedContent) {
            displayData = {
              ...submissionObj,
              ...approvedContent.toObject(),
              _id: submissionObj._id, // Keep submission ID
              status: submissionObj.status // Keep submission status
            };
            dataSource = 'approvedContent';
          }
        }

        // ✅ Add amendment status
        displayData.amendmentStatus = {
          canEdit: !pendingAmendment, // Can only edit if no pending amendment
          hasPendingAmendment: !!pendingAmendment,
          currentVersion,
          dataSource, // 'submission' | 'pendingAmendment' | 'approvedContent'
          
          pending: pendingAmendment ? {
            id: pendingAmendment._id,
            proposedVersion: pendingAmendment.versionNumber,
            changesSummary: pendingAmendment.changesSummary,
            changedFieldsCount: pendingAmendment.changedFields.length,
            requestedAt: pendingAmendment.requestedAt
          } : null,

          latestRejected: latestRejectedAmendment ? {
            id: latestRejectedAmendment._id,
            proposedVersion: latestRejectedAmendment.versionNumber,
            changesSummary: latestRejectedAmendment.changesSummary,
            rejectionReason: latestRejectedAmendment.rejectionReason || latestRejectedAmendment.reviewNotes,
            rejectedAt: latestRejectedAmendment.rejectedAt
          } : null
        };

        return displayData;
      })
    );

    res.json(submissionsWithStatus);
  } catch (error) {
    console.error('Fetch submissions error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: 'Failed to fetch submissions' }] });
  }
});

// GET /api/submissions/my/stats - Get aggregate stats for the current user's submissions
router.get('/my/stats', requireAuth, async (req, res) => {
  try {
    await dbConnect();

    const userObjectId = new mongoose.Types.ObjectId(req.userId);

    const [
      totalSubmissions,
      approvedSubmissions,
      pendingSubmissions,
      rejectedSubmissions,
      pendingAmendments,
      approvedAmendments,
      rejectedAmendments,
      engagement
    ] = await Promise.all([
      Submission.countDocuments({ userId: req.userId }),
      Submission.countDocuments({ userId: req.userId, status: 'approved' }),
      Submission.countDocuments({ userId: req.userId, status: 'pending' }),
      Submission.countDocuments({ userId: req.userId, status: 'rejected' }),
      AmendmentRequest.countDocuments({ userId: req.userId, status: 'pending' }),
      AmendmentRequest.countDocuments({ userId: req.userId, status: 'approved' }),
      AmendmentRequest.countDocuments({ userId: req.userId, status: 'rejected' }),
      ApprovedContent.aggregate([
        { $match: { userId: userObjectId } },
        { $group: { _id: null, totalViews: { $sum: '$views' }, totalDownloads: { $sum: '$downloads' } } }
      ])
    ]);

    res.json({
      totalSubmissions,
      approvedSubmissions,
      pendingSubmissions,
      rejectedSubmissions,
      totalViews: engagement[0]?.totalViews || 0,
      totalDownloads: engagement[0]?.totalDownloads || 0,
      pendingAmendments,
      approvedAmendments,
      rejectedAmendments
    });
  } catch (error) {
    console.error('Fetch submission stats error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: 'Failed to fetch submission stats' }] });
  }
});




// GET /api/submissions/:id - Get single submission
router.get('/:id', requireAuth, async (req, res) => {
  try {

    await dbConnect();

    const submission = await Submission.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!submission) {
      return res.status(404).json({ errors: [{ msg: 'Submission not found' }] });
    }

    res.json(submission);
  } catch (error) {
    console.error('Fetch submission error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: 'Failed to fetch submission' }] });
  }
});

// PATCH /api/submissions/:id - Update submission
router.patch('/:id', requireAuth, upload.fields([
  { name: 'contentFile', maxCount: 1 },
  { name: 'consentFile', maxCount: 1 },
  { name: 'translationFile', maxCount: 1 },
  { name: 'verificationDoc', maxCount: 1 }
]), async (req, res) => {
  try {
    console.log('📝 Update submission request from user:', req.userId);
    console.log('Submission ID:', req.params.id);

    await dbConnect();

    const existingSubmission = await Submission.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!existingSubmission) {
      return res.status(404).json({ errors: [{ msg: 'Submission not found' }] });
    }

    if (existingSubmission.status === 'approved') {
      return res.status(409).json({ errors: [{ msg: 'Use an amendment request to edit published content' }] });
    }
    if (await AmendmentRequest.exists({ submissionId: existingSubmission._id, status: 'pending' })) {
      return res.status(409).json({ errors: [{ msg: 'Cancel or review the pending amendment before editing this submission' }] });
    }

    // Track what changed
    const changes = [];
    
    const {
      country, stateRegion, tribe, village, culturalDomain, title,
      description, keywords, language, dateOfRecording, culturalSignificance,
      contentFileType,
      consentFileType, consentType, consentNames, consentDate, 
      permissionType, consentDuration, digitalSignature,
      accessTier, contentWarnings, warningOtherText,
      backgroundInfo,
      changesSummary // User can provide summary of changes
    } = req.body;

    // Store original data for rollback
    const originalData = contentSnapshot(existingSubmission);

    const wasApproved = existingSubmission.status === 'approved';

    if (wasApproved) {
      existingSubmission.previousVersion = originalData;
      existingSubmission.previousVersionDate = new Date();
      existingSubmission.isResubmission = true;
      existingSubmission.resubmissionCount = (existingSubmission.resubmissionCount || 0) + 1;
      existingSubmission.lastResubmissionDate = new Date();
      
      if (!existingSubmission.originalSubmissionDate) {
        existingSubmission.originalSubmissionDate = existingSubmission.createdAt;
      }
    }

    // Track changes for admin review
    if (title && title !== existingSubmission.title) {
      changes.push(`Title changed from "${existingSubmission.title}" to "${title}"`);
    }
    if (description && description !== existingSubmission.description) {
      changes.push('Description updated');
    }
    if (req.files?.contentFile?.[0]) {
      changes.push('Content file replaced');
    }
    if (req.files?.consentFile?.[0]) {
      changes.push('Consent file replaced');
    }

    // Update fields
    if (country) existingSubmission.country = country;
    if (stateRegion) existingSubmission.stateRegion = stateRegion;
    if (tribe) existingSubmission.tribe = tribe;
    if (village) existingSubmission.village = village;
    if (culturalDomain) existingSubmission.culturalDomain = culturalDomain;
    if (title) existingSubmission.title = title;
    if (description) existingSubmission.description = description;
    if (keywords) existingSubmission.keywords = typeof keywords === 'string' ? keywords.split(',').map(k => k.trim()) : keywords;
    if (language) existingSubmission.language = language;
    if (dateOfRecording) existingSubmission.dateOfRecording = dateOfRecording;
    if (culturalSignificance) existingSubmission.culturalSignificance = culturalSignificance;
    if (contentFileType) existingSubmission.contentFileType = contentFileType;
    if (accessTier) existingSubmission.accessTier = accessTier;
    if (contentWarnings) existingSubmission.contentWarnings = typeof contentWarnings === 'string' ? JSON.parse(contentWarnings) : contentWarnings;
    if (warningOtherText) existingSubmission.warningOtherText = warningOtherText;
    if (backgroundInfo) existingSubmission.backgroundInfo = backgroundInfo;

    // Upload new files if provided
    if (req.files?.contentFile?.[0]) {
      const file = req.files.contentFile[0];
      const contentResult = await uploadToCloudinary(
        file.buffer,
        `submissions/${req.userId}/content`,
        file.originalname, req.userId, file.mimetype
      );
      existingSubmission.contentUrl = contentResult.secure_url;
      existingSubmission.contentCloudinaryId = contentResult.public_id;
    }

    if (req.files?.consentFile?.[0]) {
      const file = req.files.consentFile[0];
      const consentResult = await uploadToCloudinary(
        file.buffer,
        `submissions/${req.userId}/consent`,
        file.originalname, req.userId, file.mimetype
      );
      existingSubmission.consent.fileUrl = consentResult.secure_url;
      existingSubmission.consent.fileCloudinaryId = consentResult.public_id;
    }

    if (consentFileType) existingSubmission.consent.fileType = consentFileType;
    if (consentType) existingSubmission.consent.consentType = consentType;
    if (consentNames) existingSubmission.consent.consentNames = consentNames;
    if (consentDate) existingSubmission.consent.consentDate = consentDate;
    if (permissionType) existingSubmission.consent.permissionType = typeof permissionType === 'string' ? JSON.parse(permissionType) : permissionType;
    if (consentDuration) existingSubmission.consent.duration = consentDuration;
    if (digitalSignature) existingSubmission.consent.digitalSignature = digitalSignature;

    if (req.files?.translationFile?.[0]) {
      const file = req.files.translationFile[0];
      const translationResult = await uploadToCloudinary(
        file.buffer,
        `submissions/${req.userId}/translation`,
        file.originalname, req.userId, file.mimetype
      );
      existingSubmission.translationFileUrl = translationResult.secure_url;
      existingSubmission.translationCloudinaryId = translationResult.public_id;
    }

    if (req.files?.verificationDoc?.[0]) {
      const file = req.files.verificationDoc[0];
      const verificationResult = await uploadToCloudinary(
        file.buffer,
        `submissions/${req.userId}/verification`,
        file.originalname, req.userId, file.mimetype
      );
      existingSubmission.verificationDocUrl = verificationResult.secure_url;
      existingSubmission.verificationCloudinaryId = verificationResult.public_id;
    }

    // Set changes summary
    existingSubmission.changesSummary = changesSummary || changes.join('; ');

    if (wasApproved) {
      existingSubmission.status = 'pending';
      existingSubmission.statusChangeReason = 'Content updated - awaiting re-approval';
      console.log('⚠️  Status changed to pending (was approved)');
    }

    existingSubmission.updatedAt = new Date();

    await saveWithHistory(existingSubmission);
    console.log('✅ Submission updated:', existingSubmission._id);

    res.json({
      message: wasApproved 
        ? 'Submission updated and sent for re-approval' 
        : 'Submission updated successfully',
      submission: {
        id: existingSubmission._id,
        title: existingSubmission.title,
        status: existingSubmission.status,
        requiresReapproval: wasApproved,
        isResubmission: existingSubmission.isResubmission,
        changesSummary: existingSubmission.changesSummary
      }
    });

  } catch (error) {
    console.error('❌ Update submission error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
      errors: [{ 
        msg: 'Failed to update submission', 
        detail: error.message 
      }] 
    });
  }
});











// PATCH /api/submissions/:id/approve - Admin approve submission (with rollback on rejection)
router.patch('/:id/approve', requireAuth, requirePermission(PERMISSIONS.SUBMISSION_APPROVE), async (req, res) => {
  try {
    const { approved, reason } = req.body;

    await dbConnect();

    const submission = await Submission.findById(req.params.id);

    if (!submission) {
      return res.status(404).json({ errors: [{ msg: 'Submission not found' }] });
    }

    if (typeof approved !== 'boolean') return res.status(400).json({ errors: [{ msg: 'approved must be a boolean' }] });
    const reviewed = await reviewSubmission(submission._id, req.userId, approved, reason);
    Object.assign(submission, reviewed.toObject());

    res.json({
      message: approved ? 'Submission approved' : 'Changes rejected and rolled back',
      submission: {
        id: submission._id,
        status: submission.status,
        reason: submission.statusChangeReason
      }
    });

  } catch (error) {
    console.error('❌ Approve/reject submission error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
      errors: [{ 
        msg: 'Failed to process submission', 
        detail: error.message 
      }] 
    });
  }
});



// GET /api/submissions/:id/history - Get version history for a submission
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    await dbConnect();

    // Find the submission
    const submission = await Submission.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!submission) {
      return res.status(404).json({ errors: [{ msg: 'Submission not found' }] });
    }

    // Get all amendment requests for this submission (approved, rejected, pending)
    const amendments = await AmendmentRequest.find({
      submissionId: submission._id
    })
    .sort({ versionNumber: -1 }) // Latest first
    .populate('reviewedBy', 'name email')
    .populate('userId', 'name email');

    const amendmentsWithDetails = await attachUserDetails(amendments, 'userId', ['avatar']);

    // Build version history
    const versionHistory = [];

    // Add each amendment as a version entry
    amendmentsWithDetails.forEach(amendment => {
      const versionEntry = {
        version: amendment.versionNumber,
        status: amendment.status,
        changesSummary: amendment.changesSummary,
        changedFieldsCount: amendment.changedFields.length,
        changedFields: amendment.changedFields.map(field => ({
          field: field.fieldName,
          type: field.changeType,
          oldValue: field.oldValue,
          newValue: field.newValue
        })),
        requestedBy: amendment.userId,
        requestedAt: amendment.requestedAt,
        reviewedBy: amendment.reviewedBy || null,
        reviewedAt: amendment.reviewedAt || null,
        reviewNotes: amendment.reviewNotes || null,
        rejectionReason: amendment.rejectionReason || null
      };

      versionHistory.push(versionEntry);
    });

    // Add initial version (v1)
    versionHistory.push({
      version: 1,
      status: submission.status === 'pending' && amendments.length === 0 ? 'pending' : 'approved',
      changesSummary: 'Initial submission',
      changedFieldsCount: 0,
      changedFields: [],
      requestedBy: {
        _id: submission.userId,
        name: 'Original Submitter'
      },
      requestedAt: submission.originalSubmissionDate || submission.createdAt,
      reviewedBy: submission.reviewedBy || null,
      reviewedAt: submission.approvedAt || null,
      reviewNotes: submission.statusChangeReason || null
    });

    // Sort by version (descending)
    versionHistory.sort((a, b) => b.version - a.version);

    // Calculate current version
    const approvedAmendments = amendments.filter(a => a.status === 'approved');
    const currentVersion = approvedAmendments.length > 0 
      ? Math.max(...approvedAmendments.map(a => a.versionNumber))
      : 1;

    res.json({
      submissionId: submission._id,
      title: submission.title,
      currentVersion,
      totalVersions: versionHistory.length,
      history: versionHistory
    });

  } catch (error) {
    console.error('Fetch version history error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
      errors: [{ msg: 'Failed to fetch version history' }] 
    });
  }
});

// GET /api/submissions/:id/version/:versionNumber - Get specific version data
router.get('/:id/version/:versionNumber', requireAuth, async (req, res) => {
  try {
    await dbConnect();

    const submission = await Submission.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!submission) {
      return res.status(404).json({ errors: [{ msg: 'Submission not found' }] });
    }

    const versionNumber = parseInt(req.params.versionNumber);

    // Version 1 = original submission
    if (versionNumber === 1) {
      return res.json({
        version: 1,
        data: submission.toObject(),
        isOriginal: true
      });
    }

    // Find the amendment for this version
    const amendment = await AmendmentRequest.findOne({
      submissionId: submission._id,
      versionNumber: versionNumber
    });

    if (!amendment) {
      return res.status(404).json({ errors: [{ msg: 'Version not found' }] });
    }

    // If approved, get data from ApprovedContent
    if (amendment.status === 'approved') {
      const ApprovedContent = (await import('../models/ApprovedContent.js')).default;
      const approvedContent = await ApprovedContent.findOne({
        submissionId: submission._id
      });

      if (approvedContent && approvedContent.currentVersion === versionNumber) {
        return res.json({
          version: versionNumber,
          data: approvedContent.toObject(),
          status: 'approved',
          changesSummary: amendment.changesSummary,
          reviewedAt: amendment.reviewedAt
        });
      }
    }

    // Return proposed changes for pending/rejected
    res.json({
      version: versionNumber,
      data: amendment.proposedChanges,
      status: amendment.status,
      changesSummary: amendment.changesSummary,
      changedFields: amendment.changedFields,
      requestedAt: amendment.requestedAt,
      reviewedAt: amendment.reviewedAt,
      reviewNotes: amendment.reviewNotes
    });

  } catch (error) {
    console.error('Fetch version error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
      errors: [{ msg: 'Failed to fetch version' }] 
    });
  }
});

export default router;
