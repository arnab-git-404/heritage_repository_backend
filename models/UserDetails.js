import mongoose from 'mongoose';

// Non-authorization profile fields only. Role lives on User (models/User.js) as
// a Role reference, since it drives permissions rather than being display data.
const userDetailsSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  country: {
    type: String,
    trim: true,
    maxlength: [100, 'Country name cannot be more than 100 characters']
  },
  state: {
    type: String,
    trim: true,
    maxlength: [100, 'State/Region name cannot be more than 100 characters']
  },
  tribe: {
    type: String,
    trim: true,
    maxlength: [100, 'Tribe/Community name cannot be more than 100 characters']
  },
  village: {
    type: String,
    trim: true,
    maxlength: [100, 'Village/Town name cannot be more than 100 characters']
  },
  bio: {
    type: String,
    trim: true,
    maxlength: [2000, 'Bio cannot be more than 2000 characters']
  },
  avatar: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

export default mongoose.model('UserDetails', userDetailsSchema);
