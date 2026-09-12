import { createHash } from "node:crypto";
import MediaAsset from "../models/MediaAsset.js";
import { contentFiles } from "../models/shared/content.js";

export async function registerUpload(ownerId, result, file) {
  if (
    !ownerId ||
    !result?.public_id ||
    !result?.secure_url ||
    !result?.resource_type
  ) {
    throw new Error("Upload metadata is incomplete");
  }
  return MediaAsset.findOneAndUpdate(
    {
      provider: "cloudinary",
      resourceType: result.resource_type,
      publicId: result.public_id,
      ownerId,
    },
    {
      $setOnInsert: {
        url: result.secure_url,
        originalName: file.originalname,
        mimeType: file.mimetype,
        bytes: result.bytes ?? file.size,
        checksum: file.buffer
          ? createHash("sha256").update(file.buffer).digest("hex")
          : undefined,
      },
    },
    { upsert: true, new: true, runValidators: true },
  );
}

export async function retainContentAssets(content, ownerId) {
  const ids = [];
  for (const file of contentFiles(content)) {
    let asset = await MediaAsset.findOne({ url: file.url });
    if (asset && String(asset.ownerId) !== String(ownerId)) {
      throw new Error("Content references an asset owned by another user");
    }
    if (!asset) {
      // Older consent uploads did not store a public ID. Preserve their URL without guessing one.
      const match = file.url.match(
        /^https?:\/\/res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\//,
      );
      asset = new MediaAsset({
        ownerId,
        url: file.url,
        publicId: file.publicId || undefined,
        provider: match ? "cloudinary" : "legacy",
        resourceType: match?.[1] || "unknown",
        retained: true,
      });
      await asset.save();
    } else {
      // Atomic claim on one document: either retention or deletion wins, never both.
      const retained = await MediaAsset.findOneAndUpdate(
        { _id: asset._id, status: "active" },
        { $set: { retained: true } },
        { new: true },
      );
      if (!retained)
        throw new Error("Content references a deleted or deleting asset");
    }
    ids.push(asset._id);
  }
  return [...new Map(ids.map((id) => [String(id), id])).values()];
}
