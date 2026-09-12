import { reviewAmendment, reviewSubmission } from '../services/contentHistory.js';
import express from "express";
import Submission from "../models/Submission.js";
import ApprovedContent from "../models/ApprovedContent.js";
import User from "../models/User.js";
import UserDetails from "../models/UserDetails.js";
import jwt from "jsonwebtoken";
import { v2 as cloudinary } from "cloudinary";
import { sendMail } from "../utils/mailer.js";
import AmendmentRequest from '../models/AmendmentRequest.js';
import Role from "../models/Role.js";
import Permission from "../models/Permission.js";
import RolePermission from "../models/RolePermission.js";
import { mergeUserWithDetails, mergeUsersWithDetails, attachUserDetails } from "../utils/userDetails.js";
import { requirePermission } from "../middleware/rbac.js";
import { PERMISSIONS } from "../constants/permissions.js";

const router = express.Router();

// ===== Authentication =====
// There is no separate admin login. Admins are regular users (see routes/auth.js
// POST /register + /login) whose role has been granted admin permissions - see
// PATCH /users/:id/role below, and scripts/seed-rbac.js for bootstrapping the
// first admin.
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    return res
      .status(401)
      .json({ errors: [{ msg: "Authentication required" }] });
  }
  if (!process.env.JWT_SECRET) {
    return res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({
      errors: [{ msg: "Server misconfiguration: JWT secret not set" }],
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload || !payload.user || !payload.user.id) {
      return res.status(401).json({ errors: [{ msg: "Invalid token" }] });
    }
    req.userId = payload.user.id;
    next();
  } catch (error) {
    return res
      .status(401)
      .json({ errors: [{ msg: "Invalid or expired token" }] });
  }
}

// ===== Dashboard Stats =====
router.get("/stats", requireAuth, requirePermission(PERMISSIONS.DASHBOARD_VIEW), async (req, res) => {
  try {
    const [
      totalUsers,
      pendingSubmissions,
      approvedSubmissions,
      rejectedSubmissions,
      amendmentRequests,
      totalViews,
      totalDownloads,
      recentUsers,
      recentSubmissions,
    ] = await Promise.all([
      User.countDocuments(),
      AmendmentRequest.countDocuments(),
      Submission.countDocuments({ status: "pending" }),
      Submission.countDocuments({ status: "approved" }),
      Submission.countDocuments({ status: "rejected" }),
      ApprovedContent.aggregate([
        { $group: { _id: null, total: { $sum: "$views" } } },
      ]),
      ApprovedContent.aggregate([
        { $group: { _id: null, total: { $sum: "$downloads" } } },
      ]),
      User.find().sort({ createdAt: -1 }).limit(5).select("-password"),
      Submission.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("userId", "name email"),
    ]);

    res.json({
      stats: {
        totalUsers,
        pendingSubmissions,
        approvedSubmissions,
        amendmentRequests,
        rejectedSubmissions,
        totalViews: totalViews[0]?.total || 0,
        totalDownloads: totalDownloads[0]?.total || 0,
      },
      recentUsers,
      recentSubmissions,
    });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to fetch stats" }] });
  }
});

// ===== Submissions Management =====
router.get("/submissions", requireAuth, requirePermission(PERMISSIONS.SUBMISSION_VIEW_ANY), async (req, res) => {
  try {
    const { status = "pending", page = 1, limit = 20, search = "" } = req.query;

    const query = { status };
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { tribe: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [submissions, total] = await Promise.all([
      Submission.find(query)
        .populate({
          path: "userId",
          select: "name email role",
          populate: { path: "role", select: "name" },
        })
        .populate("reviewedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .select("-__v"),
      Submission.countDocuments(query),
    ]);

    const submissionsWithDetails = await attachUserDetails(
      submissions,
      "userId",
      ["avatar", "country", "tribe"]
    );

    res.json({
      submissions: submissionsWithDetails,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        limit: parseInt(limit),
      },
    });
  } catch (error) {
    console.error("Fetch submissions error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to fetch submissions" }] });
  }
});

// ===== Get Single Submission Details =====
router.get("/submissions/:id", requireAuth, requirePermission(PERMISSIONS.SUBMISSION_VIEW_ANY), async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id)
      .populate({
        path: "userId",
        select: "name email role",
        populate: { path: "role", select: "name" },
      })
      .populate("reviewedBy", "name email");

    if (!submission) {
      return res.status(404).json({ errors: [{ msg: "Submission not found" }] });
    }

    // Get approved content if exists
    let approvedContent = null;
    if (submission.status === "approved") {
      approvedContent = await ApprovedContent.findOne({
        submissionId: submission._id,
      }).populate("approvedBy", "name email");
    }

    const submissionWithDetails = await attachUserDetails(
      submission,
      "userId",
      ["avatar", "country", "state", "tribe", "village", "bio"]
    );

    res.json({ submission: submissionWithDetails, approvedContent });
  } catch (error) {
    console.error("Fetch submission error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to fetch submission" }] });
  }
});

// ===== Approve/Reject Submission =====
router.patch("/submissions/:id/status", requireAuth, requirePermission(PERMISSIONS.SUBMISSION_APPROVE), async (req, res) => {
  try {
    const { status, reason } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ errors: [{ msg: "Invalid status" }] });
    }

    const submission = await Submission.findById(req.params.id).populate(
      "userId",
      "name email"
    );

    if (!submission) {
      return res.status(404).json({ errors: [{ msg: "Submission not found" }] });
    }

    if (submission.status !== "pending") {
      return res
        .status(400)
        .json({ errors: [{ msg: "Submission already processed" }] });
    }

    const reviewed = await reviewSubmission(submission._id, req.userId, status === 'approved', reason);
    const contributor = submission.userId;
    Object.assign(submission, reviewed.toObject());
    submission.userId = contributor;

    if (status === 'rejected') {
      const userEmail = submission.userId?.email;
      const userName = submission.userId?.name || "User";

      if (userEmail) {
        await sendMail({
          to: userEmail,
          subject: "Heritage Repository - Submission Rejected",
          html: `
            <h2>Submission Rejected</h2>
            <p>Dear ${userName},</p>
            <p>Unfortunately, your submission "<strong>${submission.title}</strong>" has been rejected.</p>
            ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
            <p>If you have any questions, please contact our support team.</p>
            <br>
            <p>Best regards,<br>Heritage Repository Team</p>
          `,
          text: `Dear ${userName},\n\nYour submission "${submission.title}" has been rejected.\n${reason ? `\nReason: ${reason}` : ""}\n\nBest regards,\nHeritage Repository Team`,
        });
      }

      return res.json({ message: "Submission rejected successfully", submission });
    }

    if (status === "approved") {
      const userEmail = submission.userId?.email;
      const userName = submission.userId?.name || "User";

      if (userEmail) {
        await sendMail({
          to: userEmail,
          subject: "Heritage Repository - Submission Approved",
          html: `
            <h2>Submission Approved! 🎉</h2>
            <p>Dear ${userName},</p>
            <p>Congratulations! Your submission "<strong>${submission.title}</strong>" has been approved and is now live on the Heritage Repository.</p>
            <p>Thank you for contributing to preserving cultural heritage.</p>
            <br>
            <p>Best regards,<br>Heritage Repository Team</p>
          `,
          text: `Dear ${userName},\n\nCongratulations! Your submission "${submission.title}" has been approved and is now live.\n\nThank you for your contribution!\n\nBest regards,\nHeritage Repository Team`,
        });
      }

      return res.json({ message: "Submission approved successfully", submission });
    }
  } catch (error) {
    console.error("Update status error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to update status" }] });
  }
});

// ===== Delete Submission =====
router.delete("/submissions/:id", requireAuth, requirePermission(PERMISSIONS.SUBMISSION_DELETE_ANY), async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id).populate(
      "userId",
      "name email"
    );

    if (!submission) {
      return res.status(404).json({ errors: [{ msg: "Submission not found" }] });
    }

    // Delete files from Cloudinary
    const deletePromises = [];
    if (submission.contentCloudinaryId) {
      deletePromises.push(
        cloudinary.uploader.destroy(submission.contentCloudinaryId)
      );
    }
    if (submission.translationCloudinaryId) {
      deletePromises.push(
        cloudinary.uploader.destroy(submission.translationCloudinaryId)
      );
    }
    if (submission.verificationCloudinaryId) {
      deletePromises.push(
        cloudinary.uploader.destroy(submission.verificationCloudinaryId)
      );
    }

    await Promise.allSettled(deletePromises);

    // Send deletion email
    const userEmail = submission.userId?.email;
    const userName = submission.userId?.name || "User";

    if (userEmail) {
      await sendMail({
        to: userEmail,
        subject: "Heritage Repository - Submission Deleted",
        html: `
          <h2>Submission Deleted</h2>
          <p>Dear ${userName},</p>
          <p>Your submission "<strong>${submission.title}</strong>" has been deleted from the Heritage Repository.</p>
          ${
            submission.rejectionReason
              ? `<p><strong>Previous rejection reason:</strong> ${submission.rejectionReason}</p>`
              : ""
          }
          <p>If you have any questions, please contact our support team.</p>
          <br>
          <p>Best regards,<br>Heritage Repository Team</p>
        `,
        text: `Dear ${userName},\n\nYour submission "${submission.title}" has been deleted.\n${submission.rejectionReason ? `\nPrevious rejection reason: ${submission.rejectionReason}` : ""}\n\nBest regards,\nHeritage Repository Team`,
      });
    }

    // Delete from approved content if exists
    if (submission.status === "approved") {
      await ApprovedContent.findOneAndDelete({ submissionId: submission._id });

      // This two have not Tested yet
      // Also delete any associated amendment requests
      await AmendmentRequest.deleteMany({ submissionId: submission._id });
      
      await Submission.findByIdAndDelete(submission._id)
    }

    res.json({ message: "Submission deleted successfully" });
  } catch (error) {
    console.error("Delete submission error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to delete submission" }] });
  }
});

// ===== Users Management =====
router.get("/users", requireAuth, requirePermission(PERMISSIONS.USER_VIEW_ANY), async (req, res) => {
  try {
    const { page = 1, limit = 20, search = "", role = "" } = req.query;

    const query = {};
    if (search) {
      const orConditions = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
      const tribeMatches = await UserDetails.find({
        tribe: { $regex: search, $options: "i" },
      }).select("user");
      if (tribeMatches.length) {
        orConditions.push({ _id: { $in: tribeMatches.map((d) => d.user) } });
      }
      query.$or = orConditions;
    }
    if (role) {
      const roleDoc = await Role.findOne({ name: role }).select("_id");
      query.role = roleDoc ? roleDoc._id : null;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [users, total] = await Promise.all([
      User.find(query)
        .select("-password")
        .populate("role", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      User.countDocuments(query),
    ]);

    const usersWithDetails = await mergeUsersWithDetails(users);

    res.json({
      users: usersWithDetails,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        limit: parseInt(limit),
      },
    });
  } catch (error) {
    console.error("Fetch users error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to fetch users" }] });
  }
});

// ===== Get Single User Details =====
router.get("/users/:id", requireAuth, requirePermission(PERMISSIONS.USER_VIEW_ANY), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password").populate("role", "name");

    if (!user) {
      return res.status(404).json({ errors: [{ msg: "User not found" }] });
    }

    // Get user's submissions
    const [submissions, approvedCount, pendingCount, rejectedCount, details] =
      await Promise.all([
        Submission.find({ userId: user._id })
          .sort({ createdAt: -1 })
          .limit(10)
          .select("title status culturalDomain createdAt"),
        Submission.countDocuments({ userId: user._id, status: "approved" }),
        Submission.countDocuments({ userId: user._id, status: "pending" }),
        Submission.countDocuments({ userId: user._id, status: "rejected" }),
        UserDetails.findOne({ user: user._id }),
      ]);

    res.json({
      user: mergeUserWithDetails(user, details),
      stats: {
        totalSubmissions: submissions.length,
        approved: approvedCount,
        pending: pendingCount,
        rejected: rejectedCount,
      },
      recentSubmissions: submissions,
    });
  } catch (error) {
    console.error("Fetch user error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to fetch user" }] });
  }
});

// ===== Update User Role =====
router.patch("/users/:id/role", requireAuth, requirePermission(PERMISSIONS.USER_UPDATE_ROLE), async (req, res) => {
  try {
    const { role } = req.body;

    const roleDoc = await Role.findOne({ name: role });
    if (!roleDoc) {
      return res.status(400).json({ errors: [{ msg: "Invalid role" }] });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role: roleDoc._id },
      { new: true, runValidators: true, select: "-password" }
    ).populate("role", "name");

    if (!user) {
      return res.status(404).json({ errors: [{ msg: "User not found" }] });
    }

    const details = await UserDetails.findOne({ user: user._id });

    res.json({
      message: "User role updated successfully",
      user: mergeUserWithDetails(user, details),
    });
  } catch (error) {
    console.error("Update user role error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to update user role" }] });
  }
});

// ===== Delete User =====
router.delete("/users/:id", requireAuth, requirePermission(PERMISSIONS.USER_DELETE_ANY), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ errors: [{ msg: "User not found" }] });
    }

    // Delete all user's submissions
    const submissions = await Submission.find({ userId: user._id });

    for (const submission of submissions) {
      if (submission.contentCloudinaryId) {
        await cloudinary.uploader
          .destroy(submission.contentCloudinaryId)
          .catch(() => {});
      }
      if (submission.status === "approved") {
        await ApprovedContent.findOneAndDelete({
          submissionId: submission._id,
        });
      }
    }

    await Submission.deleteMany({ userId: user._id });
    await UserDetails.findOneAndDelete({ user: user._id });
    await User.findByIdAndDelete(user._id);

    res.json({ message: "User and associated data deleted successfully" });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to delete user" }] });
  }
});

// ===== Roles & Permissions Management =====

// Permissions are code-defined (constants/permissions.js) and seeded via
// scripts/seed-rbac.js - this only lists what already exists, it doesn't
// create new ones.
router.get("/permissions", requireAuth, requirePermission(PERMISSIONS.ROLE_MANAGE), async (req, res) => {
  try {
    const permissions = await Permission.find().sort({ name: 1 });
    res.json({ permissions });
  } catch (error) {
    console.error("Fetch permissions error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to fetch permissions" }] });
  }
});

router.get("/roles", requireAuth, requirePermission(PERMISSIONS.ROLE_MANAGE), async (req, res) => {
  try {
    const [roles, mappings, userCounts] = await Promise.all([
      Role.find().sort({ name: 1 }),
      RolePermission.find().populate("permission", "name description"),
      User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
    ]);

    const permissionsByRole = new Map();
    for (const mapping of mappings) {
      if (!mapping.permission) continue;
      const key = mapping.role.toString();
      if (!permissionsByRole.has(key)) permissionsByRole.set(key, []);
      permissionsByRole.get(key).push({
        _id: mapping.permission._id,
        name: mapping.permission.name,
        description: mapping.permission.description,
      });
    }

    const userCountByRole = new Map(
      userCounts.filter((c) => c._id).map((c) => [c._id.toString(), c.count])
    );

    const rolesWithPermissions = roles.map((role) => ({
      _id: role._id,
      name: role.name,
      description: role.description,
      permissions: permissionsByRole.get(role._id.toString()) || [],
      userCount: userCountByRole.get(role._id.toString()) || 0,
    }));

    res.json({ roles: rolesWithPermissions });
  } catch (error) {
    console.error("Fetch roles error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to fetch roles" }] });
  }
});

router.post("/roles", requireAuth, requirePermission(PERMISSIONS.ROLE_MANAGE), async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ errors: [{ msg: "Role name is required" }] });
    }

    const role = await Role.create({ name: name.trim(), description });
    res.status(201).json({ role: { ...role.toObject(), permissions: [], userCount: 0 } });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ errors: [{ msg: "A role with that name already exists" }] });
    }
    console.error("Create role error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to create role" }] });
  }
});

// Replace the full set of permissions granted to a role.
router.patch("/roles/:id/permissions", requireAuth, requirePermission(PERMISSIONS.ROLE_MANAGE), async (req, res) => {
  try {
    const { permissionIds } = req.body;
    if (!Array.isArray(permissionIds)) {
      return res.status(400).json({ errors: [{ msg: "permissionIds must be an array" }] });
    }

    const role = await Role.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ errors: [{ msg: "Role not found" }] });
    }

    const validPermissions = await Permission.find({ _id: { $in: permissionIds } }).select("_id");
    const validIds = validPermissions.map((p) => p._id);

    await RolePermission.deleteMany({ role: role._id });
    if (validIds.length) {
      await RolePermission.insertMany(
        validIds.map((permissionId) => ({ role: role._id, permission: permissionId })),
        { ordered: false }
      );
    }

    const mappings = await RolePermission.find({ role: role._id }).populate("permission", "name description");

    res.json({
      role: {
        _id: role._id,
        name: role.name,
        description: role.description,
        permissions: mappings
          .filter((m) => m.permission)
          .map((m) => ({ _id: m.permission._id, name: m.permission.name, description: m.permission.description })),
      },
    });
  } catch (error) {
    console.error("Update role permissions error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to update role permissions" }] });
  }
});

router.delete("/roles/:id", requireAuth, requirePermission(PERMISSIONS.ROLE_MANAGE), async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ errors: [{ msg: "Role not found" }] });
    }

    const usersWithRole = await User.countDocuments({ role: role._id });
    if (usersWithRole > 0) {
      return res.status(400).json({
        errors: [{ msg: `Cannot delete role - ${usersWithRole} user(s) still have it` }],
      });
    }

    await RolePermission.deleteMany({ role: role._id });
    await Role.findByIdAndDelete(role._id);

    res.json({ message: "Role deleted successfully" });
  } catch (error) {
    console.error("Delete role error:", error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: "Failed to delete role" }] });
  }
});




// ===== GET /api/admin/amendments - Get all amendment requests =====
router.get("/amendments", requireAuth, requirePermission(PERMISSIONS.AMENDMENT_VIEW_ANY), async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;

    const query = { status };
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [amendments, total] = await Promise.all([
      AmendmentRequest.find(query)
        .populate('userId', 'name email')
        .populate('submissionId', 'title status')
        .populate('approvedContentId', 'title currentVersion')
        .populate('reviewedBy', 'name email')
        .sort({ requestedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      AmendmentRequest.countDocuments(query)
    ]);

    const amendmentsWithDetails = await attachUserDetails(
      amendments,
      'userId',
      ['avatar', 'country', 'tribe']
    );

    res.json({
      amendments: amendmentsWithDetails,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Fetch amendments error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: 'Failed to fetch amendments' }] });
  }
});

// ===== GET /api/admin/amendments/:id - Get amendment details with comparison =====
router.get("/amendments/:id", requireAuth, requirePermission(PERMISSIONS.AMENDMENT_VIEW_ANY), async (req, res) => {
  try {
    const amendment = await AmendmentRequest.findById(req.params.id)
      .populate({
        path: 'userId',
        select: 'name email role',
        populate: { path: 'role', select: 'name' }
      })
      .populate('submissionId')
      .populate('approvedContentId')
      .populate('reviewedBy', 'name email');

    if (!amendment) {
      return res.status(404).json({ errors: [{ msg: 'Amendment not found' }] });
    }

    const amendmentWithDetails = await attachUserDetails(
      amendment,
      'userId',
      ['avatar', 'country', 'tribe', 'village']
    );

    // Prepare side-by-side comparison
    const comparison = {
      current: {
        version: `v${amendment.previousVersionNumber}`,
        label: 'Current Approved Version',
        data: amendment.currentApprovedSnapshot
      },
      proposed: {
        version: `v${amendment.versionNumber}`,
        label: 'Proposed Changes',
        data: amendment.proposedChanges
      },
      changes: amendment.changedFields.map(change => ({
        field: change.fieldName,
        type: change.changeType,
        before: change.oldValue,
        after: change.newValue
      })),
      summary: amendment.changesSummary
    };

    res.json({
      amendment: amendmentWithDetails,
      comparison
    });
  } catch (error) {
    console.error('Fetch amendment error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ errors: [{ msg: 'Failed to fetch amendment' }] });
  }
});

// ===== PATCH /api/admin/amendments/:id/review - Approve or reject amendment =====
router.patch("/amendments/:id/review", requireAuth, requirePermission(PERMISSIONS.AMENDMENT_REVIEW), async (req, res) => {
  try {
    const { approved, reviewNotes } = req.body;

    const amendment = await AmendmentRequest.findById(req.params.id)
      .populate('userId', 'name email')
      .populate('submissionId')
      .populate('approvedContentId');

    if (!amendment) {
      return res.status(404).json({ errors: [{ msg: 'Amendment not found' }] });
    }

    if (amendment.status !== 'pending') {
      return res.status(400).json({ 
        errors: [{ msg: 'Amendment already processed' }] 
      });
    }

    const userEmail = amendment.userId?.email;
    const userName = amendment.userId?.name || 'User';
    const submission = amendment.submissionId;

    if (typeof approved !== 'boolean') return res.status(400).json({ errors: [{ msg: 'approved must be a boolean' }] });
    const reviewed = await reviewAmendment(amendment._id, req.userId, approved, reviewNotes);
    Object.assign(amendment, reviewed.toObject());

    if (approved) {
      // Send approval email
      if (userEmail) {
        await sendMail({
          to: userEmail,
          subject: `Amendment Approved - v${amendment.versionNumber}`,
          html: `
            <h2>Amendment Approved! 🎉</h2>
            <p>Dear ${userName},</p>
            <p>Your amendment request has been approved and is now live as <strong>Version ${amendment.versionNumber}</strong>.</p>
            <p><strong>Changes:</strong> ${amendment.changesSummary}</p>
            ${reviewNotes ? `<p><strong>Admin notes:</strong> ${reviewNotes}</p>` : ''}
            <p>Your content is now updated with the new changes.</p>
            <br>
            <p>Best regards,<br>Heritage Repository Team</p>
          `,
          text: `Amendment approved - v${amendment.versionNumber}\n\nChanges: ${amendment.changesSummary}`
        });
      }

      return res.json({ 
        message: `Amendment approved - Now v${amendment.versionNumber}`,
        amendment,
        newVersion: amendment.versionNumber
      });

    } else {
      // ❌ REJECT AMENDMENT
      console.log(`❌ Rejecting amendment - Staying at v${amendment.previousVersionNumber}`);

      // Rejected proposal media remains available in revision history.

      // Send rejection email
      if (userEmail) {
        await sendMail({
          to: userEmail,
          subject: 'Amendment Rejected',
          html: `
            <h2>Amendment Rejected</h2>
            <p>Dear ${userName},</p>
            <p>Unfortunately, your amendment request for <strong>Version ${amendment.versionNumber}</strong> was not approved.</p>
            <p><strong>Your proposed changes:</strong> ${amendment.changesSummary}</p>
            ${reviewNotes ? `<p><strong>Reason:</strong> ${reviewNotes}</p>` : ''}
            <p>Your content remains at <strong>Version ${amendment.previousVersionNumber}</strong>.</p>
            <p>You can submit a new amendment request with the necessary corrections.</p>
            <br>
            <p>Best regards,<br>Heritage Repository Team</p>
          `,
          text: `Amendment rejected - Staying at v${amendment.previousVersionNumber}\n\nReason: ${reviewNotes}`
        });
      }

      return res.json({ 
        message: 'Amendment rejected - Original version preserved',
        amendment,
        currentVersion: amendment.previousVersionNumber
      });
    }

  } catch (error) {
    console.error('❌ Review amendment error:', error);
    res.status(error.status || (error.name === 'VersionError' ? 409 : 500)).json({ 
      errors: [{ 
        msg: 'Failed to review amendment', 
        detail: error.message 
      }] 
    });
  }
});


export default router;