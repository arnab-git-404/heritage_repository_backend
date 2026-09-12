import { saveAmendmentWithHistory, cancelAmendment } from '../services/contentHistory.js';
import { contentSnapshot } from '../models/shared/content.js';
import { registerUpload } from '../services/mediaAssets.js';
import express from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import AmendmentRequest from '../models/AmendmentRequest.js';
import Submission from '../models/Submission.js';
import ApprovedContent from '../models/ApprovedContent.js';
import { dbConnect } from '../utils/db.js';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import streamifier from 'streamifier';

const router = express.Router();

dotenv.config();

// Configure Cloudinary from env with secure connection
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true // Force HTTPS
});

// Multer config
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 200 * 1024 * 1024,
    files: 5
  }
});

async function uploadToCloudinary(buffer, folder = 'amendments', originalFilename = '', ownerId, mimeType) {
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

// Auth middleware
function requireAuth(req, res, next) {

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ errors: [{ msg: 'Authentication required' }] });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.user?.id;
    next();
  } catch (error) {
    return res.status(401).json({ errors: [{ msg: 'Invalid token' }] });
  }
}


// Helper to determine change type
function getChangeType(value) {
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object' && value !== null) return 'object';
  if (typeof value === 'string' && (value.includes('cloudinary') || value.includes('http'))) return 'file';
  return 'text';
}

// Helper to track changes
function getChangedFields(oldData, newData, requestBody) {
  const changes = [];
  const fieldsToCheck = [
    'country', 'stateRegion', 'tribe', 'village', 'culturalDomain',
    'title', 'description', 'keywords', 'language', 'dateOfRecording',
    'culturalSignificance', 'contentFileType', 'accessTier',
    'contentWarnings', 'warningOtherText', 'backgroundInfo'
  ];

  fieldsToCheck.forEach(field => {
    if (requestBody[field] !== undefined) {
      const newValue = newData[field];
      const oldValue = oldData[field];
      
      const oldStr = JSON.stringify(oldValue);
      const newStr = JSON.stringify(newValue);
      
      if (oldStr !== newStr) {
        changes.push({
          fieldName: field,
          oldValue: oldValue,
          newValue: newValue,
          changeType: getChangeType(newValue)
        });
      }
    }
  });

  // Check file changes
  if (newData.contentCloudinaryId !== oldData.contentCloudinaryId) {
    changes.push({
      fieldName: 'contentFile',
      oldValue: oldData.contentUrl,
      newValue: newData.contentUrl,
      changeType: 'file'
    });
  }

  if (newData.translationCloudinaryId !== oldData.translationCloudinaryId) {
    changes.push({
      fieldName: 'translationFile',
      oldValue: oldData.translationFileUrl,
      newValue: newData.translationFileUrl,
      changeType: 'file'
    });
  }

  if (newData.verificationCloudinaryId !== oldData.verificationCloudinaryId) {
    changes.push({
      fieldName: 'verificationDoc',
      oldValue: oldData.verificationDocUrl,
      newValue: newData.verificationDocUrl,
      changeType: 'file'
    });
  }

  // Check consent changes
  const oldConsent = JSON.stringify(oldData.consent);
  const newConsent = JSON.stringify(newData.consent);
  if (oldConsent !== newConsent) {
    changes.push({
      fieldName: 'consent',
      oldValue: oldData.consent,
      newValue: newData.consent,
      changeType: 'object'
    });
  }

  return changes;
}

// ===== POST /api/amendments - Submit amendment request =====
router.post('/', requireAuth, upload.fields([
  { name: 'contentFile', maxCount: 1 },
  { name: 'consentFile', maxCount: 1 },
  { name: 'translationFile', maxCount: 1 },
  { name: 'verificationDoc', maxCount: 1 }
]), async (req, res) => {
  try {
    console.log('📝 Amendment request from user:', req.userId);

    const { submissionId, changesSummary } = req.body;

    if (!submissionId || !changesSummary) {
      return res.status(400).json({ 
        errors: [{ msg: 'Submission ID and changes summary are required' }] 
      });
    }

    await dbConnect();

    // Find submission (can be in pending or approved state)
    const submission = await Submission.findOne({
      _id: submissionId,
      userId: req.userId
    });

    if (!submission) {
      return res.status(404).json({ 
        errors: [{ msg: 'Submission not found or you do not have permission' }] 
      });
    }

    let approvedContent = null;
    let currentVersionNumber = 0;
    let sourceData = null;

    // Case 1: Submission is APPROVED - editing approved content
    if (submission.status === 'approved') {
      approvedContent = await ApprovedContent.findOne({
        submissionId: submission._id
      });

      if (!approvedContent) {
        return res.status(404).json({ 
          errors: [{ msg: 'Approved content not found' }] 
        });
      }

      currentVersionNumber = approvedContent.currentVersion || 1;
      sourceData = approvedContent;
      
      console.log(`✅ Amending approved content - Current version: v${currentVersionNumber}`);
    } 
    // Case 2: Submission is PENDING - editing pending submission
    else if (submission.status === 'pending') {
      currentVersionNumber = submission.resubmissionCount || 0;
      sourceData = submission;
      
      console.log(`✅ Editing pending submission - Current edit count: ${currentVersionNumber}`);
    } 
    else {
      return res.status(400).json({ 
        errors: [{ msg: 'Cannot amend rejected submissions' }] 
      });
    }

    // Check for existing pending amendment
    const existingAmendment = await AmendmentRequest.findOne({
      submissionId: submission._id,
      status: 'pending'
    });

    if (existingAmendment) {
      return res.status(400).json({ 
        errors: [{ msg: 'You already have a pending amendment request. Please wait for review or cancel it first.' }] 
      });
    }

    // Create snapshot of current data
    const currentSnapshot = contentSnapshot(sourceData);

    console.log('💾 Current version snapshot created');

    // Merge with new changes
    const proposedChanges = structuredClone(currentSnapshot);

    const {
      country, stateRegion, tribe, village, culturalDomain, title,
      description, keywords, language, dateOfRecording, culturalSignificance,
      contentFileType,
      consentFileType, consentType, consentNames, consentDate,
      permissionType, consentDuration, digitalSignature,
      accessTier, contentWarnings, warningOtherText,
      backgroundInfo
    } = req.body;

    // Apply changes
    if (country !== undefined) proposedChanges.country = country;
    if (stateRegion !== undefined) proposedChanges.stateRegion = stateRegion;
    if (tribe !== undefined) proposedChanges.tribe = tribe;
    if (village !== undefined) proposedChanges.village = village;
    if (culturalDomain !== undefined) proposedChanges.culturalDomain = culturalDomain;
    if (title !== undefined) proposedChanges.title = title;
    if (description !== undefined) proposedChanges.description = description;
    
    if (keywords !== undefined) {
      proposedChanges.keywords = typeof keywords === 'string' 
        ? keywords.split(',').map(k => k.trim()) 
        : keywords;
    }
    
    if (language !== undefined) proposedChanges.language = language;
    if (dateOfRecording !== undefined) proposedChanges.dateOfRecording = dateOfRecording;
    if (culturalSignificance !== undefined) proposedChanges.culturalSignificance = culturalSignificance;
    if (contentFileType !== undefined) proposedChanges.contentFileType = contentFileType;
    if (accessTier !== undefined) proposedChanges.accessTier = accessTier;
    
    if (contentWarnings !== undefined) {
      proposedChanges.contentWarnings = typeof contentWarnings === 'string' 
        ? JSON.parse(contentWarnings) 
        : contentWarnings;
    }
    
    if (warningOtherText !== undefined) proposedChanges.warningOtherText = warningOtherText;
    if (backgroundInfo !== undefined) proposedChanges.backgroundInfo = backgroundInfo;

    // Handle file uploads
    if (req.files?.contentFile?.[0]) {
      console.log('⬆️  Uploading new content file...');
      const file = req.files.contentFile[0];
      const contentResult = await uploadToCloudinary(
        file.buffer,
        `amendments/${req.userId}/content`,
        file.originalname, req.userId, file.mimetype
      );
      proposedChanges.contentUrl = contentResult.secure_url;
      proposedChanges.contentCloudinaryId = contentResult.public_id;
      console.log('✅ Content uploaded:', contentResult.secure_url);
    }

    if (req.files?.consentFile?.[0]) {
      console.log('⬆️  Uploading new consent file...');
      const file = req.files.consentFile[0];
      const consentResult = await uploadToCloudinary(
        file.buffer,
        `amendments/${req.userId}/consent`,
        file.originalname, req.userId, file.mimetype
      );
      proposedChanges.consent.fileUrl = consentResult.secure_url;
      proposedChanges.consent.fileCloudinaryId = consentResult.public_id;
      console.log('✅ Consent uploaded');
    }

    if (req.files?.translationFile?.[0]) {
      console.log('⬆️  Uploading new translation file...');
      const file = req.files.translationFile[0];
      const translationResult = await uploadToCloudinary(
        file.buffer,
        `amendments/${req.userId}/translation`,
        file.originalname, req.userId, file.mimetype
      );
      proposedChanges.translationFileUrl = translationResult.secure_url;
      proposedChanges.translationCloudinaryId = translationResult.public_id;
      console.log('✅ Translation uploaded');
    }

    if (req.files?.verificationDoc?.[0]) {
      console.log('⬆️  Uploading new verification document...');
      const file = req.files.verificationDoc[0];
      const verificationResult = await uploadToCloudinary(
        file.buffer,
        `amendments/${req.userId}/verification`,
        file.originalname, req.userId, file.mimetype
      );
      proposedChanges.verificationDocUrl = verificationResult.secure_url;
      proposedChanges.verificationCloudinaryId = verificationResult.public_id;
      console.log('✅ Verification uploaded');
    }

    // Update consent fields
    if (consentFileType !== undefined) proposedChanges.consent.fileType = consentFileType;
    if (consentType !== undefined) proposedChanges.consent.consentType = consentType;
    if (consentNames !== undefined) proposedChanges.consent.consentNames = consentNames;
    if (consentDate !== undefined) proposedChanges.consent.consentDate = consentDate;
    
    if (permissionType !== undefined) {
      proposedChanges.consent.permissionType = typeof permissionType === 'string' 
        ? JSON.parse(permissionType) 
        : permissionType;
    }
    
    if (consentDuration !== undefined) proposedChanges.consent.duration = consentDuration;
    if (digitalSignature !== undefined) proposedChanges.consent.digitalSignature = digitalSignature;

    // Track changes
    const changedFields = getChangedFields(currentSnapshot, proposedChanges, req.body);
    
    console.log(`🔍 Changes detected: ${changedFields.length}`);

    if (changedFields.length === 0) {
      return res.status(400).json({ 
        errors: [{ msg: 'No changes detected. Please modify at least one field.' }] 
      });
    }

    // Calculate new version number
    const latestAttempt = await AmendmentRequest.findOne({ submissionId: submission._id }).sort({ versionNumber: -1 });
    const newVersionNumber = Math.max(1, currentVersionNumber, latestAttempt?.versionNumber || 0) + 1;

    // Create amendment request
    const amendment = new AmendmentRequest({
      submissionId: submission._id,
      approvedContentId: approvedContent?._id || null,
      userId: req.userId,
      versionNumber: newVersionNumber,
      previousVersionNumber: currentVersionNumber,
      changesSummary,
      changedFields,
      proposedChanges,
      currentApprovedSnapshot: currentSnapshot,
      status: 'pending'
    });


    // Update submission resubmission count
    submission.resubmissionCount = (submission.resubmissionCount || 0) + 1;
    submission.lastResubmissionDate = new Date();
    if (!submission.originalSubmissionDate) {
      submission.originalSubmissionDate = submission.createdAt;
    }
    await saveAmendmentWithHistory(amendment, submission);

    console.log(`✅ Amendment request created - Will be v${newVersionNumber} if approved`);

    res.json({
      message: 'Amendment request submitted successfully',
      amendment: {
        id: amendment._id,
        currentVersion: currentVersionNumber,
        proposedVersion: newVersionNumber,
        status: amendment.status,
        changesSummary: amendment.changesSummary,
        changedFieldsCount: changedFields.length,
        changedFields: changedFields.map(c => ({
          field: c.fieldName,
          type: c.changeType
        }))
      }
    });

  } catch (error) {
    console.error('❌ Amendment request error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
      errors: [{ 
        msg: 'Failed to submit amendment request', 
        detail: error.message 
      }] 
    });
  }
});

// ===== GET /api/amendments/my - Get user's amendment requests =====
router.get('/my', requireAuth, async (req, res) => {
  try {
    await dbConnect();

    const { status } = req.query;
    const query = { userId: req.userId };
    
    if (status) {
      query.status = status;
    }

    const amendments = await AmendmentRequest.find(query)
      .populate('submissionId', 'title status')
      .populate('approvedContentId', 'title currentVersion')
      .sort({ requestedAt: -1 });

    res.json(amendments);
  } catch (error) {
    console.error('❌ Fetch amendments error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
      errors: [{ msg: 'Failed to fetch amendment requests' }] 
    });
  }
});

// ===== GET /api/amendments/:id - Get single amendment request =====
router.get('/:id', requireAuth, async (req, res) => {
  try {
    await dbConnect();

    const amendment = await AmendmentRequest.findOne({
      _id: req.params.id,
      userId: req.userId
    })
      .populate('submissionId')
      .populate('approvedContentId')
      .populate('reviewedBy', 'name email');

    if (!amendment) {
      return res.status(404).json({ 
        errors: [{ msg: 'Amendment request not found' }] 
      });
    }

    // Prepare comparison
    const comparison = {
      current: {
        version: amendment.previousVersionNumber,
        data: amendment.currentApprovedSnapshot
      },
      proposed: {
        version: amendment.versionNumber,
        data: amendment.proposedChanges
      },
      changes: amendment.changedFields
    };

    res.json({ 
      amendment, 
      comparison 
    });
  } catch (error) {
    console.error('❌ Fetch amendment error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
      errors: [{ msg: 'Failed to fetch amendment request' }] 
    });
  }
});

// ===== DELETE /api/amendments/:id - Cancel pending amendment =====
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await dbConnect();

    const amendment = await AmendmentRequest.findOne({
      _id: req.params.id,
      userId: req.userId,
      status: 'pending'
    });

    if (!amendment) {
      return res.status(404).json({ 
        errors: [{ msg: 'Pending amendment not found' }] 
      });
    }

    // Retain the proposal and its media as part of the immutable history.
    await cancelAmendment(amendment._id, req.userId);

    console.log('✅ Amendment request cancelled');

    res.json({ message: 'Amendment request cancelled successfully' });
  } catch (error) {
    console.error('❌ Cancel amendment error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
      errors: [{ msg: 'Failed to cancel amendment request' }] 
    });
  }
});

// ===== GET /api/amendments/submission/:submissionId/versions - Get version history =====
router.get('/submission/:submissionId/versions', requireAuth, async (req, res) => {
  try {
    await dbConnect();

    const submission = await Submission.findOne({
      _id: req.params.submissionId,
      userId: req.userId
    });

    if (!submission) {
      return res.status(404).json({ 
        errors: [{ msg: 'Submission not found' }] 
      });
    }

    const amendments = await AmendmentRequest.find({
      submissionId: submission._id
    })
      .sort({ versionNumber: -1 })
      .populate('reviewedBy', 'name email');

    const approvedContent = await ApprovedContent.findOne({
      submissionId: submission._id
    });

    res.json({
      currentVersion: approvedContent?.currentVersion || 0,
      totalAmendments: approvedContent?.totalAmendments || 0,
      versionHistory: amendments.map(a => ({
        version: a.versionNumber,
        status: a.status,
        changesSummary: a.changesSummary,
        requestedAt: a.requestedAt,
        reviewedAt: a.reviewedAt,
        reviewedBy: a.reviewedBy
      }))
    });
  } catch (error) {
    console.error('❌ Fetch version history error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
      errors: [{ msg: 'Failed to fetch version history' }] 
    });
  }
});

export default router;
