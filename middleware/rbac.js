import User from '../models/User.js';
import Permission from '../models/Permission.js';
import RolePermission from '../models/RolePermission.js';

// Checks whether a role (by id) has a given permission (by name), via the
// RolePermission join table.
export async function roleHasPermission(roleId, permissionName) {
  if (!roleId) return false;
  const permission = await Permission.findOne({ name: permissionName }).select('_id');
  if (!permission) return false;
  const mapping = await RolePermission.exists({ role: roleId, permission: permission._id });
  return !!mapping;
}

// Express middleware factory. Must run after a requireAuth that sets req.userId.
// Looks up the caller's role and checks it against the RolePermission table for
// the given permission name.
export function requirePermission(permissionName) {
  return async (req, res, next) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ errors: [{ msg: 'Authentication required' }] });
      }

      const user = await User.findById(req.userId).select('role');
      if (!user) {
        return res.status(401).json({ errors: [{ msg: 'Authentication required' }] });
      }

      const allowed = await roleHasPermission(user.role, permissionName);
      if (!allowed) {
        return res.status(403).json({ errors: [{ msg: 'Insufficient permissions' }] });
      }

      req.userRoleId = user.role;
      next();
    } catch (error) {
      console.error('Permission check failed:', error);
      res.status(500).json({ errors: [{ msg: 'Authorization check failed' }] });
    }
  };
}
