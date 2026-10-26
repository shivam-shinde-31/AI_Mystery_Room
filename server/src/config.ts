import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the workspace-level .env consistently whether the server is started from
// the repository root, the server workspace, or its compiled dist directory.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

export const config = {
  port: Number(process.env.PORT || 4000),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  mongoUri: process.env.MONGODB_URI || '',
  jwtSecret: process.env.JWT_SECRET || 'development-secret-change-this-before-deploying',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash',
  geminiEmergencyModel: process.env.GEMINI_EMERGENCY_MODEL || 'gemini-3.5-flash-lite',
  aiDeepValidation: process.env.AI_DEEP_VALIDATION === 'true',
  aiMock: process.env.AI_MOCK === 'true',
  maxTokensPerCase: Number(process.env.MAX_TOKENS_PER_CASE || 120000),
  guestCaseLimit: Number(process.env.GUEST_CASE_LIMIT || 5),
  userDailyCaseLimit: Number(process.env.USER_DAILY_CASE_LIMIT || 10),
  cookieSecure: process.env.NODE_ENV === 'production'
};
