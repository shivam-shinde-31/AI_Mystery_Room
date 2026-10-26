import { z } from 'zod';

export const DifficultySchema = z.enum(['easy', 'medium', 'hard']);
export const CaseStatusSchema = z.enum(['generating', 'ready', 'failed_generation', 'solved', 'failed']);
export const EvidenceTypeSchema = z.enum(['whatsapp_chat', 'image', 'cctv', 'document', 'audio_transcript']);
export const SeedSchema = z.object({ seed: z.string().trim().min(20).max(1000), caseName: z.string().trim().min(2).max(60).optional(), difficulty: DifficultySchema });
export const RegisterSchema = z.object({ email: z.string().email().transform(v => v.toLowerCase()), password: z.string().min(8), displayName: z.string().trim().min(2).max(40) });
export const LoginSchema = z.object({ email: z.string().email().transform(v => v.toLowerCase()), password: z.string().min(1) });
export const NoteSchema = z.object({ content: z.string().max(10000), pinnedEvidenceIds: z.array(z.string()).max(100) });
export const AccusationSchema = z.object({ suspectId: z.string().min(1), reasoning: z.string().trim().min(30).max(1000), supportingEvidenceIds: z.array(z.string()).min(1).max(5) });

export type Difficulty = z.infer<typeof DifficultySchema>;
export type CaseStatus = z.infer<typeof CaseStatusSchema>;
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
export type ApiError = { error: { code: string; message: string; details?: unknown } };
