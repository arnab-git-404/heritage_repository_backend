// Canonical permission names. Stored as Permission documents (via scripts/seed-rbac.js)
// and referenced here so route code never hardcodes a raw string.
export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard:view',

  SUBMISSION_VIEW_ANY: 'submission:view_any',
  SUBMISSION_APPROVE: 'submission:approve',
  SUBMISSION_DELETE_ANY: 'submission:delete_any',

  AMENDMENT_VIEW_ANY: 'amendment:view_any',
  AMENDMENT_REVIEW: 'amendment:review',

  USER_VIEW_ANY: 'user:view_any',
  USER_UPDATE_ROLE: 'user:update_role',
  USER_DELETE_ANY: 'user:delete_any',

  ROLE_MANAGE: 'role:manage',
};

export const PERMISSION_DESCRIPTIONS = {
  [PERMISSIONS.DASHBOARD_VIEW]: 'View admin dashboard statistics',
  [PERMISSIONS.SUBMISSION_VIEW_ANY]: "View any user's submissions",
  [PERMISSIONS.SUBMISSION_APPROVE]: 'Approve, reject, or roll back submissions',
  [PERMISSIONS.SUBMISSION_DELETE_ANY]: 'Delete any submission',
  [PERMISSIONS.AMENDMENT_VIEW_ANY]: 'View any amendment request',
  [PERMISSIONS.AMENDMENT_REVIEW]: 'Approve or reject amendment requests',
  [PERMISSIONS.USER_VIEW_ANY]: 'View any user account',
  [PERMISSIONS.USER_UPDATE_ROLE]: "Change a user's role",
  [PERMISSIONS.USER_DELETE_ANY]: 'Delete any user account',
  [PERMISSIONS.ROLE_MANAGE]: 'Create roles and change which permissions a role grants',
};
