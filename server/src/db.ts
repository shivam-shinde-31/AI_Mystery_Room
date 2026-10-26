import mongoose from 'mongoose';
import { config } from './config.js';
export async function connectDb() {
  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is missing. Set it in the project-root .env file or in the deployment environment.');
  }
  if (!/^mongodb(?:\+srv)?:\/\//i.test(config.mongoUri)) {
    throw new Error('MONGODB_URI must start with mongodb:// or mongodb+srv://.');
  }
  await mongoose.connect(config.mongoUri);
  console.log('MongoDB connected');
}
