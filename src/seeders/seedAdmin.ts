import bcrypt from 'bcryptjs';
import AdminModel from '../models/admin.model';
import { ADMIN_EMAIL, ADMIN_PASS } from '../configs/constants';
import logger from '../configs/logger.config';

export const seedAdmin = async () => {
  try {
    const exists = await AdminModel.findOne({ email: ADMIN_EMAIL });
    if (exists) { logger.info('Admin already exists'); return; }
    const hash = await bcrypt.hash(ADMIN_PASS, 12);
    await AdminModel.create({ name: 'Super Admin', email: ADMIN_EMAIL, password: hash, role: 'superadmin' });
    logger.info(`Admin seeded: ${ADMIN_EMAIL}`);
  } catch (err: any) {
    logger.error('Error seeding admin:', err.message);
  }
};
