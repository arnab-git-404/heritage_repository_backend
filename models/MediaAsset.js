import mongoose from 'mongoose';

const mediaAssetSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: ['cloudinary', 'legacy'], required: true },
  publicId: String,
  resourceType: { type: String, enum: ['image', 'video', 'raw', 'unknown'], required: true },
  url: { type: String, required: true, unique: true },
  originalName: String,
  mimeType: String,
  bytes: { type: Number, min: 0 },
  checksum: String,
  // Once a revision references an asset, ordinary upload deletion must never remove it.
  retained: { type: Boolean, default: false, required: true },
  status: { type: String, enum: ['active', 'deleting', 'deleted'], default: 'active', required: true },
}, { timestamps: true });

mediaAssetSchema.index({ provider: 1, resourceType: 1, publicId: 1 }, {
  unique: true,
  partialFilterExpression: { publicId: { $type: 'string' } },
});

export default mongoose.model('MediaAsset', mediaAssetSchema);
