// Seeds the Role, Permission and RolePermission reference tables from
// constants/roles.js and constants/permissions.js. Idempotent - safe to re-run
// any time those constant files change (e.g. a new permission is added).
//
// Optionally bootstraps the first Admin: if ADMIN_EMAIL is set and a User with
// that email exists, that user is promoted to the Admin role.
//
// Run with: node ./scripts/seed-rbac.js

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { dbConnect } from '../utils/db.js';
import Role from '../models/Role.js';
import Permission from '../models/Permission.js';
import RolePermission from '../models/RolePermission.js';
import User from '../models/User.js';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS } from '../constants/permissions.js';
import { ROLE_PERMISSIONS } from '../constants/roles.js';

dotenv.config();

async function seed() {
  await dbConnect();

  const permissionIdByName = new Map();
  for (const name of Object.values(PERMISSIONS)) {
    const permission = await Permission.findOneAndUpdate(
      { name },
      { name, description: PERMISSION_DESCRIPTIONS[name] || '' },
      { new: true, upsert: true }
    );
    permissionIdByName.set(name, permission._id);
  }
  console.log(`Permissions seeded: ${permissionIdByName.size}`);

  const roleIdByName = new Map();
  for (const roleName of Object.keys(ROLE_PERMISSIONS)) {
    const role = await Role.findOneAndUpdate(
      { name: roleName },
      { name: roleName },
      { new: true, upsert: true }
    );
    roleIdByName.set(roleName, role._id);
  }
  console.log(`Roles seeded: ${roleIdByName.size}`);

  let mappingsWritten = 0;
  for (const [roleName, permissionNames] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleIdByName.get(roleName);
    for (const permissionName of permissionNames) {
      const permissionId = permissionIdByName.get(permissionName);
      if (!permissionId) continue;
      await RolePermission.findOneAndUpdate(
        { role: roleId, permission: permissionId },
        { role: roleId, permission: permissionId },
        { upsert: true }
      );
      mappingsWritten++;
    }
  }
  console.log(`Role-permission mappings ensured: ${mappingsWritten}`);

  if (process.env.ADMIN_EMAIL) {
    const adminUser = await User.findOne({ email: process.env.ADMIN_EMAIL.toLowerCase() });
    if (adminUser) {
      adminUser.role = roleIdByName.get('Admin');
      await adminUser.save();
      console.log(`Promoted ${process.env.ADMIN_EMAIL} to Admin`);
    } else {
      console.log(`ADMIN_EMAIL is set but no matching user was found - register that account first, then re-run this script`);
    }
  }

  await mongoose.connection.close();
  process.exit(0);
}

seed().catch((err) => {
  console.error('RBAC seed failed:', err);
  process.exit(1);
});
