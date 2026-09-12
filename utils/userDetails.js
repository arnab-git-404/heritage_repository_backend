import UserDetails from "../models/UserDetails.js";

// Non-authorization profile fields that live on UserDetails. `role` is not
// among them - it lives directly on User as a Role reference, since it drives
// permissions. See models/User.js and middleware/rbac.js.
export const DETAIL_FIELDS = [
  "country",
  "state",
  "tribe",
  "village",
  "bio",
  "avatar",
];

function pickDetailFields(detailsDoc, fields = DETAIL_FIELDS) {
  const out = {};
  if (!detailsDoc) return out;
  const source = detailsDoc.toObject ? detailsDoc.toObject() : detailsDoc;
  for (const key of fields) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

// If `role` was populated (a Role sub-document), flatten it to its name string
// so the API keeps returning `role` as a plain string like before.
function flattenRole(obj) {
  if (obj && obj.role && typeof obj.role === "object" && obj.role.name) {
    obj.role = obj.role.name;
  }
  return obj;
}

// Fetch UserDetails for a list of user ids, keyed by user id string.
export async function getUserDetailsMap(userIds) {
  const uniqueIds = [
    ...new Set(userIds.filter(Boolean).map((id) => (id._id || id).toString())),
  ];
  const map = new Map();
  if (uniqueIds.length === 0) return map;
  const details = await UserDetails.find({ user: { $in: uniqueIds } });
  for (const d of details) {
    map.set(d.user.toString(), d);
  }
  return map;
}

// Flatten a UserDetails doc's fields onto a plain copy of a User doc.
export function mergeUserWithDetails(
  userDoc,
  detailsDoc,
  fields = DETAIL_FIELDS,
) {
  if (!userDoc) return userDoc;
  const user = userDoc.toObject ? userDoc.toObject() : { ...userDoc };
  return flattenRole({ ...user, ...pickDetailFields(detailsDoc, fields) });
}

// Merge profile fields onto one User doc or an array of them.
export async function mergeUsersWithDetails(users, fields = DETAIL_FIELDS) {
  const isArray = Array.isArray(users);
  const list = isArray ? users : [users];
  const map = await getUserDetailsMap(list.filter(Boolean).map((u) => u._id));
  const merged = list.map((u) =>
    u ? mergeUserWithDetails(u, map.get(u._id.toString()), fields) : u,
  );
  return isArray ? merged : merged[0];
}

// Flatten UserDetails fields onto a populated sub-document path (e.g. a populated
// `userId` field) for one document or an array of documents. Returns plain objects.
export async function attachUserDetails(docs, path, fields = DETAIL_FIELDS) {
  const isArray = Array.isArray(docs);
  const list = isArray ? docs : [docs];

  const userIds = list
    .map((d) => d && d[path])
    .filter(Boolean)
    .map((u) => u._id || u);

  const map = await getUserDetailsMap(userIds);

  const result = list.map((d) => {
    if (!d) return d;
    const obj = d.toObject ? d.toObject() : { ...d };
    const userVal = obj[path];
    if (userVal && typeof userVal === "object") {
      const uid = (userVal._id || userVal).toString();
      obj[path] = flattenRole({
        ...userVal,
        ...pickDetailFields(map.get(uid), fields),
      });
    }
    return obj;
  });

  return isArray ? result : result[0];
}
