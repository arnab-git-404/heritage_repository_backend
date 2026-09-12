import express from 'express';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import UserDetails from '../models/UserDetails.js';
import Role from '../models/Role.js';
import Submission from '../models/Submission.js';
import { mergeUserWithDetails } from '../utils/userDetails.js';
import { DEFAULT_ROLE } from '../constants/roles.js';
import crypto from 'crypto';
import { sendMail } from '../utils/mailer.js';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import { dbConnect } from '../utils/db.js';


// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

export const router = express.Router();

// Auth middleware for user routes
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ errors: [{ msg: 'Missing token' }] });
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ errors: [{ msg: 'Server misconfiguration: JWT secret not set' }] });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload || !payload.user || !payload.user.id) {
      return res.status(401).json({ errors: [{ msg: 'Invalid token' }] });
    }
    req.userId = payload.user.id;
    next();
  } catch (e) {
    return res.status(401).json({ errors: [{ msg: 'Invalid token' }] });
  }
}

// @route   POST api/auth/register
// @desc    Register a user
// @access  Public
router.post(
  '/register',
  [
    body('name', 'Name is required').not().isEmpty(),
    body('email', 'Please include a valid email').isEmail(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password } = req.body;

    try {

      await dbConnect();

      // Check if user exists
      let user = await User.findOne({ email });
      
      if (user) {
        return res.status(400).json({ errors: [{ msg: 'User already exists' }] });
      }

      const defaultRole = await Role.findOne({ name: DEFAULT_ROLE });
      if (!defaultRole) {
        console.error(`Default role "${DEFAULT_ROLE}" not found - run "npm run seed:rbac" first`);
        return res.status(500).json({ errors: [{ msg: 'Server misconfiguration: roles not seeded' }] });
      }

      // Create new user
      user = new User({
        name,
        email,
        password,
        role: defaultRole._id
      });

      // Save user to database
      await user.save();

      // Create the accompanying profile-details record
      try {
        await UserDetails.create({ user: user._id });
      } catch (detailsErr) {
        await User.findByIdAndDelete(user._id);
        throw detailsErr;
      }

      // Create JWT
      const payload = {
        user: {
          id: user.id
        }
      };

      jwt.sign(
        payload,
        process.env.JWT_SECRET,
        { expiresIn: '30d' },
        (err, token) => {
          if (!process.env.JWT_SECRET) {
            return res.status(500).json({ errors: [{ msg: 'Server misconfiguration: JWT secret not set' }] });
          }
          if (err) throw err;
          res.json({ token });
        }
      );
    } catch (err) {
      console.error(err);
      if (err && err.code === 11000) {
        return res.status(400).json({ errors: [{ msg: 'Email already registered' }] });
      }
      if (err && err.name === 'ValidationError') {
        const msgs = Object.values(err.errors).map(e => ({ msg: e.message }));
        return res.status(400).json({ errors: msgs });
      }
      res.status(500).json({ errors: [{ msg: 'Server error' }] });
    }
  }
);

// @route   POST api/auth/login
// @desc    Login user and return JWT
// @access  Public
router.post(
  '/login',
  [
    body('email', 'Please include a valid email').isEmail(),
    body('password', 'Password is required').exists()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {

      await dbConnect();

      const user = await User.findOne({ email }).select('+password');
      if (!user) {
        return res.status(400).json({ errors: [{ msg: 'Invalid credentials' }] });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(400).json({ errors: [{ msg: 'Invalid credentials' }] });
      }

      if (!process.env.JWT_SECRET) {
        return res.status(500).json({ errors: [{ msg: 'Server misconfiguration: JWT secret not set' }] });
      }

      const payload = {
        user: {
          id: user.id
        }
      };

      jwt.sign(
        payload,
        process.env.JWT_SECRET,
        { expiresIn: '30d' },
        (err, token) => {
          if (err) throw err;
          res.json({ token });
        }
      );
    } catch (err) {
      console.error(err);
      res.status(500).json({ errors: [{ msg: 'Server error' }] });
    }
  }
);

// @route   POST api/auth/forgot-password
// @desc    Generate password reset token
// @access  Public
router.post(
  '/forgot-password',
  [body('email', 'Please include a valid email').isEmail()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email } = req.body;

    try {

      await dbConnect();

      const user = await User.findOne({ email });
      if (user) {
        const resetToken = crypto.randomBytes(32).toString('hex');
        const hashed = crypto.createHash('sha256').update(resetToken).digest('hex');
        user.resetPasswordToken = hashed;
        user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await user.save();

        const response = { message: 'If that email exists, a reset link has been sent' };
        // Build reset URL
        const base = (process.env.FRONTEND_URL || req.headers.origin || 'http://localhost:8080').replace(/\/$/, '');
        const resetUrl = `${base}/reset-password?token=${resetToken}`;
        // Try to send email if SMTP is configured
        try {
          const sent = await sendMail({
            to: email,
            subject: 'Reset your password',
            text: `Click the link to reset your password: ${resetUrl}`,
            html: `<p>Click the link to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
          });
          if (sent) {
            response.email = 'sent';
          } else {
            response.email = 'not_configured';
          }
        } catch (e) {
          response.email = 'error_sending';
        }
        if (process.env.NODE_ENV !== 'production') {
          response.token = resetToken;
        }
        return res.json(response);
      }

      return res.json({ message: 'If that email exists, a reset link has been sent' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ errors: [{ msg: 'Server error' }] });
    }
  }
);

// @route   POST api/auth/reset-password
// @desc    Reset password using token
// @access  Public
router.post(
  '/reset-password',
  [
    body('token', 'Token is required').isString().notEmpty(),
    body('password')
      .isString()
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{8,}$/)
      .withMessage('Password must be at least 8 characters and include uppercase, lowercase, and a special character')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { token, password } = req.body;
    const hashed = crypto.createHash('sha256').update(token).digest('hex');

    try {

      await dbConnect();

      const user = await User.findOne({
        resetPasswordToken: hashed,
        resetPasswordExpires: { $gt: new Date() }
      }).select('+password');

      if (!user) {
        return res.status(400).json({ errors: [{ msg: 'Invalid or expired token' }] });
      }

      user.password = password;
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save();

      return res.json({ message: 'Password has been reset' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ errors: [{ msg: 'Server error' }] });
    }
  }
);

// Refresh JWT token
router.post('/refresh-token', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ errors: [{ msg: 'No token provided' }] });
  }

  try {
    // Verify the existing token
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    
    await dbConnect();

    // Get the user
    const user = await User.findById(decoded.user.id);
    if (!user) {
      return res.status(401).json({ errors: [{ msg: 'User not found' }] });
    }

    // Create a new token
    const payload = { user: { id: user.id } };
    const newToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });

    return res.json({ token: newToken });
  } catch (error) {
    console.error('Error refreshing token:', error);
    return res.status(401).json({ errors: [{ msg: 'Invalid token' }] });
  }
});


// Get current user's profile
router.get('/me', requireAuth, async (req, res) => {
  try {

    await dbConnect();
    const user = await User.findById(req.userId)
      .select('-password -resetPasswordToken -resetPasswordExpires')
      .populate('role', 'name');
    if (!user) return res.status(404).json({ errors: [{ msg: 'User not found' }] });
    const details = await UserDetails.findOne({ user: user._id });
    res.json({ user: mergeUserWithDetails(user, details) });

  } catch (err) {
    res.status(500).json({ errors: [{ msg: 'Server error' }] });
  }
});

// Delete current user's profile and their submissions
router.delete('/me', requireAuth, async (req, res) => {
  try {

    await dbConnect();

    const user = await User.findByIdAndDelete(req.userId);
    if (!user) return res.status(404).json({ errors: [{ msg: 'User not found' }] });
    await UserDetails.findOneAndDelete({ user: req.userId });
    await Submission.deleteMany({ userId: req.userId });
    res.json({ message: 'Account deleted' });
  } catch (err) {
    res.status(500).json({ errors: [{ msg: 'Server error' }] });
  }
});


// PATCH /api/auth/profile - Update user profile
// Note: role is deliberately NOT editable here. Role now drives permissions
// (see middleware/rbac.js), so changing it is admin-only - PATCH
// /api/admin/users/:id/role, gated by the user:update_role permission.
router.patch('/profile', requireAuth, [
  body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
  body('country').optional().trim(),
  body('state').optional().trim(),
  body('tribe').optional().trim(),
  body('village').optional().trim(),
  body('bio').optional().trim(),
], async (req, res) => {
  try {


    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, country, state, tribe, village, bio } = req.body;

    const userFields = {};
    if (name !== undefined) userFields.name = name;

    const detailsFields = {};
    if (country !== undefined) detailsFields.country = country;
    if (state !== undefined) detailsFields.state = state;
    if (tribe !== undefined) detailsFields.tribe = tribe;
    if (village !== undefined) detailsFields.village = village;
    if (bio !== undefined) detailsFields.bio = bio;

    await dbConnect();

    let updatedUser = req.userId;
    if (Object.keys(userFields).length > 0) {
      updatedUser = await User.findByIdAndUpdate(
        req.userId,
        { $set: userFields },
        { new: true, runValidators: true, select: '-password -resetPasswordToken -resetPasswordExpires' }
      ).populate('role', 'name');
      if (!updatedUser) {
        return res.status(404).json({ errors: [{ msg: 'User not found' }] });
      }
    } else {
      updatedUser = await User.findById(req.userId)
        .select('-password -resetPasswordToken -resetPasswordExpires')
        .populate('role', 'name');
      if (!updatedUser) {
        return res.status(404).json({ errors: [{ msg: 'User not found' }] });
      }
    }

    let details;
    if (Object.keys(detailsFields).length > 0) {
      details = await UserDetails.findOneAndUpdate(
        { user: req.userId },
        { $set: detailsFields },
        { new: true, upsert: true, runValidators: true }
      );
    } else {
      details = await UserDetails.findOne({ user: req.userId });
    }

    res.json({ user: mergeUserWithDetails(updatedUser, details) });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ errors: [{ msg: 'Server error' }] });
  }
});


async function uploadAvatarToCloudinary(buffer, folder = 'avatars') {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: folder,
        resource_type: 'image',
        type: 'upload',
        access_mode: 'public',
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face' },
          { quality: 'auto' }
        ]
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

// POST /api/auth/avatar - Upload avatar
router.post('/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ errors: [{ msg: 'No file uploaded' }] });
    }

     // Validate file type
    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ errors: [{ msg: 'File must be an image' }] });
    }

    // Upload to Cloudinary
    const result = await uploadAvatarToCloudinary(
      req.file.buffer,
      `avatars/${req.userId}`
    );
    
    await dbConnect();

    const user = await User.findById(req.userId)
      .select('-password -resetPasswordToken -resetPasswordExpires')
      .populate('role', 'name');
    if (!user) {
      return res.status(404).json({ errors: [{ msg: 'User not found' }] });
    }

    const details = await UserDetails.findOneAndUpdate(
      { user: req.userId },
      { avatar: result.secure_url },
      { new: true, upsert: true }
    );

    res.json({
      avatarUrl: result.secure_url,
      user: mergeUserWithDetails(user, details)
    });
  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({ errors: [{ msg: 'Failed to upload avatar' }] });
  }
});


export default router;