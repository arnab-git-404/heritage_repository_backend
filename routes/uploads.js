import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';
import MediaAsset from '../models/MediaAsset.js';
import { registerUpload } from '../services/mediaAssets.js';


const router = express.Router();

// Configure Cloudinary from env with secure connection
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true // Force HTTPS
});

// File filter to accept common media types
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf', 
                      'video/mp4', 'video/quicktime', 'audio/mpeg', 'audio/wav'];
  
  if (!allowedTypes.includes(file.mimetype)) {
    return cb(new Error('File type not allowed'), false);
  }
  cb(null, true);
};

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 200 * 1024 * 1024, // 200MB
    files: 1
  },
  fileFilter
});

// Authentication middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  
  if (!token) {
    return res.status(401).json({ errors: [{ msg: 'Authentication required' }] });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ 
      errors: [{ msg: 'Server configuration error' }] 
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload?.user?.id) {
      throw new Error('Invalid token payload');
    }
    req.userId = payload.user.id;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ 
      errors: [{ msg: 'Invalid or expired token' }] 
    });
  }
}

// Upload to Cloudinary with proper resource type detection
async function uploadToCloudinary(buffer, originalname) {
  return new Promise((resolve, reject) => {
    console.log(`Preparing to upload ${originalname} to Cloudinary`);
    
    // Validate input
    if (!buffer || !originalname) {
      console.error('Invalid input to uploadToCloudinary');
      return reject(new Error('Invalid file data'));
    }
    
    // Determine resource type from file extension
    const ext = originalname.split('.').pop().toLowerCase();
    let resourceType = 'auto';
    
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      resourceType = 'image';
    } else if (['mp4', 'mov', 'avi', 'webm'].includes(ext)) {
      resourceType = 'video';
    } else if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
      resourceType = 'video'; // Cloudinary treats audio as video type
    } else if (ext === 'pdf') {
      resourceType = 'raw';
    }
    
    console.log(`Detected resource type: ${resourceType}, extension: ${ext}`);

    const publicId = `${Date.now()}-${originalname.replace(/\.[^/.]+$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    console.log(`Uploading with public_id: ${publicId}`);
    
    const uploadOptions = {
      resource_type: resourceType,
      folder: 'heritage-repo',
      public_id: publicId,
      overwrite: false,
      unique_filename: true,
      chunk_size: 6000000, // 6MB chunks for large files
      timeout: 120000, // 2 minutes timeout
      ...(resourceType === 'image' && {
        eager: [
          { width: 1000, crop: 'limit', quality: 'auto' }
        ]
      })
    };
    
    console.log('Upload options:', JSON.stringify(uploadOptions, null, 2));
    
    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          console.error('Cloudinary upload error details:', {
            message: error.message,
            http_code: error.http_code,
            name: error.name,
            status: error.status
          });
          return reject(new Error(`Upload failed: ${error.message || 'Unknown error'}`));
        }
        if (!result) {
          console.error('No result object from Cloudinary');
          return reject(new Error('No result from Cloudinary'));
        }
        
        console.log('Cloudinary upload successful, result:', {
          public_id: result.public_id,
          format: result.format,
          resource_type: result.resource_type,
          bytes: result.bytes,
          url: result.secure_url
        });
        resolve({
          ...result,
          // Ensure secure URL
          secure_url: result.secure_url.replace('http://', 'https://'),
          // For audio files, ensure we have a playable URL
          url: resourceType === 'video' && result.resource_type === 'video' 
            ? result.secure_url.replace(/\.([^.]*)$/, '.mp4').replace('http://', 'https://')
            : result.secure_url.replace('http://', 'https://')
        });
      }
    );

    // Create a readable stream from buffer and pipe to Cloudinary
    const bufferStream = new Readable();
    bufferStream.push(buffer);
    bufferStream.push(null); // End of stream
    bufferStream.pipe(uploadStream);
  });
}

// Handle file upload
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  console.log('File upload request received');
  try {
    if (!req.file) {
      console.error('No file in request');
      return res.status(400).json({ 
        errors: [{ msg: 'No file was uploaded' }] 
      });
    }
    
    console.log(`Processing file: ${req.file.originalname} (${req.file.size} bytes)`);

    // Validate Cloudinary config
    const requiredVars = [
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET'
    ];
    
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
      console.error('Missing Cloudinary config:', missingVars);
      return res.status(500).json({ 
        errors: [{ msg: 'Server configuration error' }] 
      });
    }

    console.log('Uploading to Cloudinary...');
    // Process the upload
    let result;
    try {
      result = await uploadToCloudinary(
        req.file.buffer, 
        req.file.originalname
      );
      console.log('Cloudinary upload successful:', result.secure_url);
    } catch (uploadError) {
      console.error('Cloudinary upload failed:', uploadError);
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    if (!result || !result.secure_url) {
      console.error('No secure URL in Cloudinary response:', result);
      throw new Error('Upload failed: No URL returned from Cloudinary');
    }

    const asset = await registerUpload(req.userId, result, req.file);
    // Return response
    return res.json({
      assetId: asset._id,
      url: result.secure_url,
      path: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type,
      format: result.format,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
      duration: result.duration
    });

  } catch (error) {
    console.error('Upload error:', error);
    // Check for specific Cloudinary errors
    if (error.message.includes('File size too large')) {
      return res.status(413).json({
        errors: [{ msg: 'File is too large. Maximum size is 200MB.' }]
      });
    }
    if (error.message.includes('File type not allowed')) {
      return res.status(400).json({
        errors: [{ msg: 'This file type is not allowed.' }]
      });
    }
    
    return res.status(500).json({ 
      errors: [{ 
        msg: error.message || 'Upload failed. Please try again.' 
      }] 
    });
  }
});

// Delete file from Cloudinary
router.delete('/', requireAuth, async (req, res) => {
  try {
    const { publicId, resourceType = 'image' } = req.body;
    
    if (!publicId) {
      return res.status(400).json({ 
        errors: [{ msg: 'Missing public ID' }] 
      });
    }

    // Atomically claim an owned, unattached asset. Retained historical files cannot be deleted here.
    const asset = await MediaAsset.findOneAndUpdate({
      ownerId: req.userId, provider: 'cloudinary', publicId, resourceType,
      retained: false, status: 'active',
    }, { $set: { status: 'deleting' } }, { new: true });
    if (!asset) {
      return res.status(409).json({ errors: [{ msg: 'File is unavailable, not owned by you, or retained in submission history' }] });
    }
    try {
      const result = await cloudinary.uploader.destroy(asset.publicId, {
        resource_type: asset.resourceType, invalidate: true
      });
      if (!['ok', 'not found'].includes(result.result)) throw new Error('Failed to delete file');
      asset.status = 'deleted';
      await asset.save();
    } catch (error) {
      await MediaAsset.updateOne({ _id: asset._id, status: 'deleting' }, { $set: { status: 'active' } });
      throw error;
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    return res.status(500).json({ 
      errors: [{ 
        msg: error.message || 'Failed to delete file' 
      }] 
    });
  }
});

export default router;
