import { model, Schema } from 'mongoose';

const AdminSchema = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['superadmin', 'admin', 'operator'], default: 'admin' },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  lastLogin: { type: Date, default: null },
}, { timestamps: true });

export default model('admins', AdminSchema);
