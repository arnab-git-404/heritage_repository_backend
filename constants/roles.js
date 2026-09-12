import { PERMISSIONS } from './permissions.js';

// Canonical role names. Stored as Role documents (via scripts/seed-rbac.js) and
// referenced here so route code never hardcodes a raw string.
export const ROLES = {
  VIEWER: 'Viewer',
  CONTRIBUTOR: 'Contributor',
  RESEARCHER: 'Researcher',
  CUSTODIAN: 'Custodian',
  ADMIN: 'Admin',
};

export const DEFAULT_ROLE = ROLES.VIEWER;

// Which permissions each role is granted, mapped into RolePermission rows by
// scripts/seed-rbac.js. Only Admin carries elevated permissions today; the other
// roles are content-classification labels that don't currently gate any action.
export const ROLE_PERMISSIONS = {
  [ROLES.VIEWER]: [],
  [ROLES.CONTRIBUTOR]: [],
  [ROLES.RESEARCHER]: [],
  [ROLES.CUSTODIAN]: [],
  [ROLES.ADMIN]: Object.values(PERMISSIONS),
};
