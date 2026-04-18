import mongoose from 'mongoose';
import { MONGO_URI } from './constants';
import logger from './logger.config';

export const connectDB = async (callback: (mongoose: mongoose.Mongoose) => void) => {
  try {
    const conn = await mongoose.connect(MONGO_URI);
    logger.info(`MongoDB connected: ${conn.connection.host}`);
    callback(conn);
  } catch (error) {
    logger.error('MongoDB connection error:', error);
    process.exit(1);
  }
};
