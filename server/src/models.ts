import mongoose, { Schema } from 'mongoose';

const SuspectSchema = new Schema({ id: String, name: String, age: Number, role: String, publicBio: String, alibiClaim: String, portraitSvg: String }, { _id: false });
const CaseSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, default: null, index: true }, guestToken: { type: String, default: null, index: true }, seed: { type: String, required: true }, caseName: { type: String, trim: true, maxlength: 60, default: "" }, difficulty: { type: String, required: true },
  status: { type: String, default: 'generating', index: true }, generationStage: { type: String, default: 'bible' }, generationError: { type: String, default: null },
  title: { type: String, default: '' }, setting: { type: String, default: '' }, incidentSummary: { type: String, default: '' }, incidentTime: Date, suspects: { type: [SuspectSchema], default: [] },
  solution: { type: Schema.Types.Mixed, default: null }, hints: { type: [String], default: [] }, hintsUsed: { type: Number, default: 0 }, accusation: { type: Schema.Types.Mixed, default: null },
  modelMeta: { type: Schema.Types.Mixed, default: {} }
}, { timestamps: true });
CaseSchema.index({ ownerId: 1, createdAt: -1 });
CaseSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800, partialFilterExpression: { ownerId: null } });
const EvidenceSchema = new Schema({ _id: { type: String }, caseId: { type: Schema.Types.ObjectId, index: true, required: true }, type: String, title: String, description: String, timestamp: Date, relatedSuspectIds: [String], reliability: String, payload: Schema.Types.Mixed, isDecisive: Boolean }, { timestamps: true });
EvidenceSchema.index({ caseId: 1, timestamp: 1 });
const NoteSchema = new Schema({ caseId: { type: Schema.Types.ObjectId, required: true }, ownerKey: { type: String, required: true }, content: { type: String, maxlength: 10000, default: '' }, pinnedEvidenceIds: { type: [String], default: [] } }, { timestamps: true });
NoteSchema.index({ caseId: 1, ownerKey: 1 }, { unique: true });
const UserSchema = new Schema({ email: { type: String, unique: true, lowercase: true }, passwordHash: String, displayName: String, role: { type: String, default: 'user' }, stats: { casesPlayed: { type: Number, default: 0 }, casesSolved: { type: Number, default: 0 }, totalScore: { type: Number, default: 0 } } }, { timestamps: true });
const ReportSchema = new Schema({ caseId: { type: Schema.Types.ObjectId, index: true, required: true }, userId: { type: Schema.Types.ObjectId, default: null }, message: { type: String, required: true, maxlength: 1000 } }, { timestamps: true });
export const CaseModel = mongoose.models.Case || mongoose.model('Case', CaseSchema);
export const EvidenceModel = mongoose.models.Evidence || mongoose.model('Evidence', EvidenceSchema);
export const NoteModel = mongoose.models.Note || mongoose.model('Note', NoteSchema);
export const UserModel = mongoose.models.User || mongoose.model('User', UserSchema);
export const ReportModel = mongoose.models.Report || mongoose.model('Report', ReportSchema);
