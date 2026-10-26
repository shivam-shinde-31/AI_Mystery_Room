import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { AccusationSchema, LoginSchema, NoteSchema, RegisterSchema, SeedSchema } from '@mystery-room/shared';
import { config } from './config.js';
import { connectDb } from './db.js';
import { CaseModel, EvidenceModel, NoteModel, ReportModel, UserModel } from './models.js';
import { generateCase, moderateSeed, PROMPT_VERSION } from './ai/pipeline.js';
import { GenerationQueue } from './jobs/generationQueue.js';

// Express augments its Request interface through namespace declaration merging.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare global { namespace Express { interface Request { userId?: string; guestToken?: string; role?: string } } }
const app = express();
const generationQueue = new GenerationQueue(Number(process.env.GENERATION_CONCURRENCY || 2));
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: config.clientOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  const requestId = randomUUID();
  const started = Date.now();
  res.setHeader('X-Request-Id', requestId);
  logger.info({ requestId, method: req.method, url: req.originalUrl }, 'request started');
  res.on('finish', () => logger.info({ requestId, statusCode: res.statusCode, durationMs: Date.now() - started }, 'request finished'));
  next();
});
const globalLimiter = rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false });
const strictLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
app.use(globalLimiter);
const asyncRoute = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res, next).catch(next); };
const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });
const setAuth = (res: Response, id: string) => res.cookie('access_token', jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 7 * 86400000 });
const auth = asyncRoute(async (req, _res, next) => {
  const token = req.cookies.access_token;
  if (token) { try { const decoded = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload; req.userId = decoded.sub; } catch { /* unauthenticated */ } }
  req.guestToken = req.cookies.guest_token;
  if (req.userId) { const user = await UserModel.findById(req.userId).select('role'); req.role = user?.role; }
  next();
});
const ownerKey = (req: Request) => req.userId || (req.guestToken ? `guest:${req.guestToken}` : '');
const requireSignedIn = (req: Request, res: Response, next: NextFunction) => { if (!req.userId) return fail(res, 401, 'SIGN_IN_REQUIRED', 'Sign in to investigate this case.'); next(); };
async function ownCase(req: Request, id: string) {
  if (!mongoose.isValidObjectId(id) || !ownerKey(req)) return null;
  const c = await CaseModel.findById(id);
  if (!c) return null;
  return (req.userId && String(c.ownerId) === req.userId) || (req.guestToken && c.guestToken === req.guestToken) ? c : null;
}
const publicCase = (c: any) => ({ id: String(c._id), caseName: c.caseName, seed: c.seed, difficulty: c.difficulty, status: c.status, generationStage: c.generationStage, generationError: c.generationError, title: c.title, setting: c.setting, incidentSummary: c.incidentSummary, incidentTime: c.incidentTime, suspects: c.suspects, createdAt: c.createdAt, updatedAt: c.updatedAt, accusation: c.accusation ? { suspectId: c.accusation.suspectId, reasoning: c.accusation.reasoning, supportingEvidenceIds: c.accusation.supportingEvidenceIds, submittedAt: c.accusation.submittedAt, correct: c.accusation.correct, score: c.accusation.score } : null });
const publicEvidence = (e: any, payload = false) => ({ id: String(e._id), hasMedia: e.type !== "cctv" || (typeof e.payload?.videoUrl === "string" && e.payload.videoUrl.length > 0) || (Array.isArray(e.payload?.frames) && e.payload.frames.length > 0), type: e.type, title: e.title, description: e.description, timestamp: e.timestamp, relatedSuspectIds: e.relatedSuspectIds, reliability: e.reliability, ...(payload ? { payload: e.payload } : {}) });
function enqueueGeneration(c: any) {
  generationQueue.enqueue(async () => {
    try {
      const result = await generateCase(c.seed, c.difficulty, stage => { void CaseModel.updateOne({ _id: c._id }, { $set: { generationStage: stage } }); });
      // Evidence ids from generated cases (for example, "ev_1") are only unique
      // within one case. MongoDB uses Evidence._id as a collection-wide key, so
      // namespace each id by its case and update every stored solution reference.
      const evidenceIdFor = (id: string) => `${String(c._id)}_${id}`;
      const evidence = result.evidence.map((item: any) => ({
        ...item,
        _id: evidenceIdFor(String(item._id ?? item.id)),
        caseId: c._id
      }));
      const solution = result.solution ? {
        ...result.solution,
        decisiveEvidenceIds: result.solution.decisiveEvidenceIds.map(evidenceIdFor),
        redHerrings: result.solution.redHerrings.map((item: any) => ({
          ...item,
          evidenceIds: item.evidenceIds.map(evidenceIdFor)
        }))
      } : result.solution;
      await EvidenceModel.deleteMany({ caseId: c._id });
      await EvidenceModel.insertMany(evidence);
      await CaseModel.updateOne({ _id: c._id }, { $set: { ...result, solution, status: 'ready', generationStage: 'done', modelMeta: { model: config.aiMock ? 'fixture' : config.geminiModel, promptVersion: PROMPT_VERSION, inputTokens: 0, outputTokens: 0, generationMs: 0 } } });
    } catch (error) {
      logger.error({ err: error, caseId: String(c._id) }, 'case generation failed');
      const detail = error instanceof Error ? error.message : String(error);
      const generationError = process.env.NODE_ENV === 'development'
        ? `Case generation failed: ${detail.slice(0, 500)}`
        : 'We could not complete this case. Please retry.';
      await CaseModel.updateOne({ _id: c._id }, { $set: { status: 'failed_generation', generationStage: 'done', generationError } });
    }
  });
}

const health = (_req: Request, res: Response) => res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'up' : 'down' });
app.get('/health', health);
app.get('/api/v1/health', health);
app.post('/api/v1/auth/register', strictLimiter, asyncRoute(async (req, res) => {
  const input = RegisterSchema.safeParse(req.body); if (!input.success) return fail(res, 400, 'VALIDATION_ERROR', 'Check the registration details.');
  if (await UserModel.exists({ email: input.data.email })) return fail(res, 409, 'EMAIL_IN_USE', 'An account already uses this email.');
  const user = await UserModel.create({ ...input.data, passwordHash: await bcrypt.hash(input.data.password, 12) });
  if (req.cookies.guest_token) { await CaseModel.updateMany({ guestToken: req.cookies.guest_token }, { ownerId: user._id, guestToken: null }); res.clearCookie('guest_token'); }
  setAuth(res, String(user._id)); return res.status(201).json({ user: { id: String(user._id), email: user.email, displayName: user.displayName, stats: user.stats } });
}));
app.post('/api/v1/auth/login', strictLimiter, asyncRoute(async (req, res) => {
  const input = LoginSchema.safeParse(req.body); if (!input.success) return fail(res, 400, 'VALIDATION_ERROR', 'Enter a valid email and password.');
  const user = await UserModel.findOne({ email: input.data.email }); if (!user || !await bcrypt.compare(input.data.password, user.passwordHash)) return fail(res, 401, 'INVALID_CREDENTIALS', 'Email or password was not recognized.');
  if (req.cookies.guest_token) { await CaseModel.updateMany({ guestToken: req.cookies.guest_token }, { ownerId: user._id, guestToken: null }); res.clearCookie('guest_token'); }
  setAuth(res, String(user._id)); return res.json({ user: { id: String(user._id), email: user.email, displayName: user.displayName, stats: user.stats } });
}));
app.post('/api/v1/auth/logout', (_req, res) => { res.clearCookie('access_token'); res.status(204).end(); });
app.get('/api/v1/auth/me', auth, asyncRoute(async (req, res) => { if (!req.userId) return fail(res, 401, 'UNAUTHORIZED', 'Sign in to continue.'); const user = await UserModel.findById(req.userId).select('-passwordHash'); if (!user) return fail(res, 401, 'UNAUTHORIZED', 'Sign in to continue.'); return res.json({ user: { id: String(user._id), email: user.email, displayName: user.displayName, stats: user.stats } }); }));

app.post('/api/v1/cases', strictLimiter, auth, asyncRoute(async (req, res) => {
  const input = SeedSchema.safeParse(req.body); if (!input.success) return fail(res, 400, 'VALIDATION_ERROR', 'Seed must be 20 to 1,000 characters.');
  let moderation;
  try {
    moderation = await moderateSeed(input.data.seed);
  } catch (error) {
    logger.error({ err: error }, 'Gemini seed moderation failed');
    const message = error instanceof Error ? error.message : String(error);
    const detail = process.env.NODE_ENV !== 'production' ? ` (${message.slice(0, 250)})` : '';
    const userMessage = /\b503\b|UNAVAILABLE|high demand/i.test(message)
      ? 'Gemini is temporarily busy. The server retried and tried its fallback models; please try again shortly.'
      : 'Gemini could not check this case. Confirm the API key, model access, server internet connection, and Gemini quota.';
    return fail(res, 503, 'AI_PROVIDER_UNAVAILABLE', `${userMessage}${detail}`);
  }
  if (moderation.decision === 'disallowed') return fail(res, 422, 'SEED_NOT_ALLOWED', 'This seed cannot be used for a fictional case. Try a different scenario.');
  let guestToken = req.guestToken;
  if (!req.userId) {
    if (!guestToken) guestToken = randomUUID();
    res.cookie('guest_token', guestToken, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 7 * 86400000 });
    const count = await CaseModel.countDocuments({ guestToken, status: { $ne: 'failed_generation' } }); if (count >= config.guestCaseLimit) return fail(res, 429, 'GUEST_LIMIT', `Guest case limit reached (${config.guestCaseLimit} cases). Create an account for up to ${config.userDailyCaseLimit} cases per day.`);
  } else {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const count = await CaseModel.countDocuments({ ownerId: req.userId, createdAt: { $gte: start }, status: { $ne: 'failed_generation' } }); if (count >= config.userDailyCaseLimit) return fail(res, 429, 'DAILY_LIMIT', `Daily case limit reached (${config.userDailyCaseLimit} cases). Try again tomorrow.`);
  }
  const c = await CaseModel.create({ ownerId: req.userId || null, guestToken: req.userId ? null : guestToken, seed: input.data.seed, caseName: input.data.caseName || "", difficulty: input.data.difficulty });
  enqueueGeneration(c);
  return res.status(202).json({ caseId: String(c._id), status: 'generating' });
}));
app.post('/api/v1/cases/:id/retry', auth, asyncRoute(async (req, res) => {
  const c: any = await ownCase(req, String(req.params.id));
  if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.');
  if (c.status !== 'failed_generation') return fail(res, 409, 'CASE_NOT_RETRYABLE', 'This case is not ready to retry.');
  c.status = 'generating'; c.generationStage = 'bible'; c.generationError = null; await c.save();
  enqueueGeneration(c);
  return res.status(202).json({ caseId: String(c._id), status: 'generating' });
}));
app.get('/api/v1/cases', auth, asyncRoute(async (req, res) => {
  const filter = req.userId ? { ownerId: req.userId } : req.guestToken ? { guestToken: req.guestToken } : { _id: null };
  const cases = await CaseModel.find(filter).sort({ createdAt: -1 }).select('title difficulty status createdAt accusation');
  return res.json({ cases: cases.map(c => ({ id: String(c._id), title: c.title || 'Case in progress', difficulty: c.difficulty, status: c.status, createdAt: c.createdAt, score: (c.accusation as any)?.score })) });
}));
app.get('/api/v1/cases/:id/status', auth, asyncRoute(async (req, res) => { const c = await ownCase(req, String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.'); return res.json({ status: c.status, generationStage: c.generationStage, caseName: c.caseName, ...(c.generationError ? { error: c.generationError } : {}) }); }));
app.get('/api/v1/cases/:id/events', auth, asyncRoute(async (req, res) => { const c = await ownCase(req, String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.'); res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); const send = async () => { const fresh = await CaseModel.findById(c._id); if (!fresh) return; res.write(`data: ${JSON.stringify({ status: fresh.status, generationStage: fresh.generationStage })}\n\n`); if (fresh.status !== 'generating') res.end(); }; await send(); const timer = setInterval(() => { void send(); }, 2000); res.on('close', () => clearInterval(timer)); }));
app.get('/api/v1/cases/:id', auth, asyncRoute(async (req, res) => { const c = await ownCase(req, String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.'); return res.json({ case: publicCase(c) }); }));
app.delete('/api/v1/cases/:id', auth, asyncRoute(async (req, res) => { const c = await ownCase(req, String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.'); await Promise.all([EvidenceModel.deleteMany({ caseId: c._id }), NoteModel.deleteMany({ caseId: c._id }), c.deleteOne()]); return res.status(204).end(); }));
app.get('/api/v1/cases/:id/evidence', auth, requireSignedIn, asyncRoute(async (req, res) => { const c = await ownCase(req, String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.'); const list = await EvidenceModel.find({ caseId: c._id }).sort({ timestamp: 1 }); return res.json({ evidence: list.map(e => publicEvidence(e)) }); }));
app.get('/api/v1/cases/:id/evidence/:evidenceId', auth, requireSignedIn, asyncRoute(async (req, res) => { const c = await ownCase(req, String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.'); const e = await EvidenceModel.findOne({ _id: String(req.params.evidenceId), caseId: c._id }); if (!e) return fail(res, 404, 'NOT_FOUND', 'Evidence not found.'); return res.json({ evidence: publicEvidence(e, true) }); }));
app.get('/api/v1/cases/:id/notes', auth, requireSignedIn, asyncRoute(async (req, res) => { const c = await ownCase(req, String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.'); const note = await NoteModel.findOne({ caseId: c._id, ownerKey: ownerKey(req) }); return res.json({ content: note?.content || '', pinnedEvidenceIds: note?.pinnedEvidenceIds || [] }); }));
app.put('/api/v1/cases/:id/notes', auth, requireSignedIn, asyncRoute(async (req, res) => { const c = await ownCase(req, String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.'); if (['solved','failed'].includes(c.status)) return fail(res, 409, 'CASE_REVEALED', 'Notes are read-only after reveal.'); const body = NoteSchema.safeParse(req.body); if (!body.success) return fail(res, 400, 'VALIDATION_ERROR', 'Notes are too long or contain invalid pins.'); const note = await NoteModel.findOneAndUpdate({ caseId: c._id, ownerKey: ownerKey(req) }, { $set: body.data }, { upsert: true, new: true }); return res.json({ content: note.content, pinnedEvidenceIds: note.pinnedEvidenceIds }); }));
app.post('/api/v1/cases/:id/hints', auth, requireSignedIn, asyncRoute(async (req, res) => { const c: any = await ownCase(req, String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.'); if (c.status !== 'ready') return fail(res, 409, 'CASE_NOT_ACTIVE', 'Hints are available while investigating.'); if (c.hintsUsed >= 3) return fail(res, 409, 'NO_HINTS_LEFT', 'No hints remain.'); const index = c.hintsUsed; c.hintsUsed += 1; await c.save(); return res.json({ index: index + 1, text: c.hints[index], remaining: 3 - c.hintsUsed }); }));
app.post('/api/v1/cases/:id/accuse', auth, requireSignedIn, asyncRoute(async (req, res) => {
  const c: any = await ownCase(req, String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.');
  if (c.accusation) return fail(res, 409, 'ALREADY_ACCUSED', 'You have already made your accusation.');
  const body = AccusationSchema.safeParse(req.body); if (!body.success) return fail(res, 400, 'VALIDATION_ERROR', 'Add at least 30 characters of reasoning and select 1–5 evidence items.');
  if (!c.suspects.some((s: any) => s.id === body.data.suspectId)) return fail(res, 400, 'INVALID_SUSPECT', 'Choose a suspect from this case.');
  const allowed = await EvidenceModel.countDocuments({ _id: { $in: body.data.supportingEvidenceIds }, caseId: c._id }); if (allowed !== body.data.supportingEvidenceIds.length) return fail(res, 400, 'INVALID_EVIDENCE', 'Choose evidence from this case.');
  const correct = body.data.suspectId === c.solution.culpritSuspectId;
  const matched = body.data.supportingEvidenceIds.filter((id: string) => c.solution.decisiveEvidenceIds.includes(id)).length;
  const base = correct ? 1000 : 0; const bonus = correct ? Math.min(300, 100 * matched) : 0; const penalty = 150 * c.hintsUsed; const multiplier = { easy: 1, medium: 1.25, hard: 1.5 }[c.difficulty as 'easy'|'medium'|'hard'] || 1;
  const score = correct ? Math.round(Math.max(0, base + bonus - penalty) * multiplier) : 0;
  c.accusation = { ...body.data, submittedAt: new Date(), correct, score }; c.status = correct ? 'solved' : 'failed'; await c.save();
  if (req.userId) await UserModel.updateOne({ _id: req.userId }, { $inc: { 'stats.casesPlayed': 1, 'stats.casesSolved': correct ? 1 : 0, 'stats.totalScore': score } });
  return res.json({ correct, score, solution: { culprit: c.suspects.find((s: any) => s.id === c.solution.culpritSuspectId), motive: c.solution.motive, method: c.solution.method, opportunity: c.solution.opportunity, timeline: c.solution.timeline, decisiveEvidenceIds: c.solution.decisiveEvidenceIds, redHerrings: c.solution.redHerrings, explanation: c.solution.explanation } });
}));
app.get('/api/v1/cases/:id/reveal', auth, requireSignedIn, asyncRoute(async (req, res) => {
  const c: any = await ownCase(req, String(req.params.id));
  if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.');
  if (!c.accusation) return fail(res, 403, 'NOT_REVEALED', 'Submit an accusation to reveal the solution.');
  return res.json({ correct: c.accusation.correct, score: c.accusation.score, solution: { culprit: c.suspects.find((s: any) => s.id === c.solution.culpritSuspectId), motive: c.solution.motive, method: c.solution.method, opportunity: c.solution.opportunity, timeline: c.solution.timeline, decisiveEvidenceIds: c.solution.decisiveEvidenceIds, redHerrings: c.solution.redHerrings, explanation: c.solution.explanation } });
}));
app.post('/api/v1/cases/:id/report', auth, requireSignedIn, asyncRoute(async (req, res) => { const c = await ownCase(req, String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.'); const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''; if (message.length < 5 || message.length > 1000) return fail(res, 400, 'VALIDATION_ERROR', 'Describe the problem in 5 to 1,000 characters.'); const report = await ReportModel.create({ caseId: c._id, userId: req.userId || null, message }); return res.status(201).json({ id: String(report._id), received: true }); }));
app.get('/api/v1/admin/cases/:id/debug', auth, asyncRoute(async (req, res) => { if (req.role !== 'admin') return fail(res, 403, 'FORBIDDEN', 'Admin access required.'); const c = await CaseModel.findById(String(req.params.id)); if (!c) return fail(res, 404, 'NOT_FOUND', 'Case not found.'); return res.json({ case: c, evidence: await EvidenceModel.find({ caseId: c._id }) }); }));
app.get('/api/v1/admin/reports', auth, asyncRoute(async (req, res) => { if (req.role !== 'admin') return fail(res, 403, 'FORBIDDEN', 'Admin access required.'); return res.json({ reports: await ReportModel.find().sort({ createdAt: -1 }).limit(100) }); }));
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  void next;
  logger.error({ err }, 'request error');
  const status = typeof err === 'object' && err !== null && 'status' in err ? Number((err as { status: unknown }).status) : 500;
  let message = err instanceof Error ? err.message : 'Something went wrong.';
  if (process.env.NODE_ENV !== 'production' && message.startsWith('{')) {
    try { message = JSON.parse(message)?.error?.message || message; } catch { /* keep the original message */ }
  }
  const safeStatus = status >= 400 && status <= 599 ? status : 500;
  const publicMessage = process.env.NODE_ENV === 'production' ? 'Something went wrong.' : message.slice(0, 500);
  return res.status(safeStatus).json({ error: { code: safeStatus === 503 ? 'AI_PROVIDER_UNAVAILABLE' : 'INTERNAL_ERROR', message: publicMessage } });
});

connectDb().then(async () => {
  await CaseModel.updateMany({ status: 'generating', updatedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } }, { $set: { status: 'failed_generation', generationStage: 'done', generationError: 'Generation timed out. Please retry this case.' } });
  app.listen(config.port, () => logger.info(`AI Mystery Room API listening on ${config.port}`));
}).catch(err => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'MongoDB connection failed. Check MONGODB_URI. For Atlas, confirm the cluster is active, the database credentials are valid, and the server IP is allowed in Network Access.');
  process.exitCode = 1;
});
