import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import { config } from '../config.js';
import { sanitizeDocument, sanitizeSvg } from './sanitize.js';

export const PROMPT_VERSION = '1.0.0';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"><rect width="480" height="300" fill="#24272b"/><rect x="28" y="28" width="424" height="244" fill="#d8d0bf"/><path d="M60 86h290M60 112h240M60 138h320" stroke="#666" stroke-width="3"/><text x="60" y="210" fill="#333" font-size="18">CASE FILE / EVIDENCE</text></svg>';
const Portrait = (hue: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" rx="16" fill="#24272b"/><circle cx="80" cy="58" r="30" fill="${hue}"/><path d="M25 154c5-38 23-57 55-57s50 19 55 57" fill="#55565a"/><path d="M50 55q30-34 60 0" fill="none" stroke="#18191b" stroke-width="9"/></svg>`;
const MockSchema = z.object({ title: z.string(), setting: z.string(), incidentSummary: z.string(), incidentTime: z.string(), suspects: z.array(z.object({ id: z.string(), name: z.string(), age: z.number(), role: z.string(), publicBio: z.string(), alibiClaim: z.string() })).min(4).max(6), culprit: z.string(), motive: z.string(), method: z.string(), opportunity: z.string(), timeline: z.array(z.object({ time: z.string(), event: z.string(), isPublic: z.boolean() })), decisive: z.array(z.string()).min(2).max(4), redHerrings: z.string(), explanation: z.string() });
const EvidenceSchema = z.array(z.object({ id: z.string(), type: z.enum(['whatsapp_chat','image','cctv','document','audio_transcript']), title: z.string(), description: z.string(), timestamp: z.string(), linked: z.array(z.string()), decisive: z.boolean(), payload: z.any() }));
const CasePackageSchema = MockSchema.extend({ evidence: EvidenceSchema });
const ModerationSchema = z.object({ decision: z.enum(['allowed','disallowed']), reason: z.string().optional().default('') });
const ValidatorSchema = z.object({ culpritSuspectId: z.string(), reasoning: z.string(), confidence: z.number().min(0).max(1), evidenceIdsUsed: z.array(z.string()) });
function buildMock(seed: string, difficulty: string) {
  const names = [
    { id: 's1_mara', name: 'Mara Voss', age: 42, role: 'Operations manager', publicBio: 'Mara ran the daily operation and knew every service corridor. She had argued with the victim over a missing ledger.', alibiClaim: 'She says she was closing the front office from 9:10 to 9:45.' },
    { id: 's2_ilan', name: 'Ilan Reed', age: 36, role: 'Business partner', publicBio: 'Ilan handled the accounts and was due to inherit the company shares. He says the victim had become impossible to work with.', alibiClaim: 'He claims he left the premises shortly before 9:00.' },
    { id: 's3_nico', name: 'Nico Bell', age: 29, role: 'Night technician', publicBio: 'Nico maintained the building systems and had keys to staff-only areas. A recent warning put his job at risk.', alibiClaim: 'He says he was in the basement workshop during the incident.' },
    { id: 's4_sera', name: 'Sera Quinn', age: 51, role: 'Longtime supplier', publicBio: 'Sera had supplied the business for years, but a disputed invoice threatened the relationship.', alibiClaim: 'She says she was on a call outside the building.' },
    { id: 's5_otto', name: 'Otto Vale', age: 33, role: 'Assistant', publicBio: 'Otto managed the victim’s calendar and had access to their private correspondence.', alibiClaim: 'He claims he was arranging a late delivery at the side entrance.' },
    { id: 's6_lyra', name: 'Lyra Moss', age: 39, role: 'Security supervisor', publicBio: 'Lyra supervised the cameras and had reported repeated blind spots in the old system.', alibiClaim: 'She says she was checking the east perimeter.' }
  ];
  const count = difficulty === 'easy' ? 4 : difficulty === 'hard' ? 6 : 5;
  const suspects = names.slice(0, count);
  const culprit = 's3_nico';
  const solution = { culpritSuspectId: culprit, motive: 'The victim discovered that Nico had altered service logs to conceal a costly side arrangement.', method: 'He used his authorized maintenance access to stage the incident during a brief camera outage.', opportunity: 'A misleading maintenance window and a false timestamp placed him elsewhere.', timeline: [{ time: '20:42', event: 'Nico entered the service corridor.', isPublic: false }, { time: '21:05', event: 'The camera feed briefly dropped.', isPublic: true }, { time: '21:17', event: 'The victim was discovered.', isPublic: true }], decisiveEvidenceIds: ['ev-chat','ev-cctv','ev-log'], redHerrings: [{ suspectId: 's2_ilan', evidenceIds: ['ev-receipt'], whyMisleading: 'The disputed invoice was unrelated to the incident.' }], explanation: 'The case turns on three details: a message shows Nico knew about the delayed inspection, the camera log places him in the corridor during that gap, and the maintenance record was edited after the fact. Together these details contradict his workshop alibi.' };
  const evidence = [
    { id:'ev-chat',type:'whatsapp_chat',title:'Night crew group chat',description:'A group conversation from the evening shift.',timestamp:'2025-10-14T20:38:00Z',relatedSuspectIds:[culprit,'s5_otto'],reliability:'verified',isDecisive:true,payload:{chatName:'Night crew',isGroup:true,participants:[{id:'nico',displayName:'Nico',suspectId:culprit},{id:'otto',displayName:'Otto',suspectId:'s5_otto'}],messages:[{id:'m1',senderId:'nico',text:'Inspection pushed back again? I left the panel open just in case.',sentAt:'2025-10-14T20:38:00Z',status:'read'},{id:'m2',senderId:'otto',text:'No, they’re still coming at nine.',sentAt:'2025-10-14T20:39:00Z',status:'delivered'},{id:'m3',senderId:'nico',text:'Right. I’ll be downstairs.',sentAt:'2025-10-14T20:41:00Z'}]}},
    { id:'ev-cctv',type:'cctv',title:'Service corridor camera',description:'A short sequence from the north corridor camera.',timestamp:'2025-10-14T21:00:00Z',relatedSuspectIds:[culprit],reliability:'verified',isDecisive:true,payload:{cameraLabel:'CAM 04',location:'North service corridor',frames:[{t:'2025-10-14T21:02:00Z',caption:'Empty corridor.'},{t:'2025-10-14T21:05:00Z',caption:'Signal interruption begins.'},{t:'2025-10-14T21:08:00Z',caption:'Feed returns; a service cart has moved.'},{t:'2025-10-14T21:11:00Z',caption:'A figure exits toward the basement.'}],operatorLog:['21:05:12 — signal lost','21:08:47 — signal restored'],gaps:[{from:'21:05:12',to:'21:08:47',reason:'Manual reset recorded at the panel'}]}},
    { id:'ev-log',type:'document',title:'Maintenance access log',description:'A printed copy of overnight panel entries.',timestamp:'2025-10-14T22:04:00Z',relatedSuspectIds:[culprit,'s6_lyra'],reliability:'verified',isDecisive:true,payload:{kind:'log',html:'<h2>Panel access</h2><p>21:04 — N. Bell — reset requested</p><p>21:11 — entry modified by operator</p>',plainText:'Panel access: 21:04 N. Bell reset requested. 21:11 entry modified by operator.'}},
    { id:'ev-photo',type:'image',title:'Service cart photograph',description:'An image of the service area taken during the evening.',timestamp:'2025-10-14T19:52:00Z',relatedSuspectIds:['s1_mara'],reliability:'verified',payload:{svg:SVG,altDescription:'A utility cart parked beside the north service corridor.',caption:'Taken before the evening shift.',metadata:{location:'North corridor',takenAt:'20:52'}}},
    { id:'ev-receipt',type:'document',title:'Supplier invoice',description:'A copy of a disputed supplier bill.',timestamp:'2025-10-14T18:00:00Z',relatedSuspectIds:['s2_ilan','s4_sera'],reliability:'unverified',payload:{kind:'receipt',html:'<h2>Invoice 0184</h2><p>Balance under review: 4,800 credits</p>',plainText:'Invoice 0184. Balance under review: 4,800 credits.'}},
    { id:'ev-audio',type:'audio_transcript',title:'Lobby intercom transcript',description:'A transcript of a brief call captured by the lobby system.',timestamp:'2025-10-14T20:55:00Z',relatedSuspectIds:['s5_otto'],reliability:'unverified',payload:{speakers:['Unknown caller','Otto'],lines:[{speaker:'Unknown caller',text:'The delivery is delayed.',t:'00:03'},{speaker:'Otto',text:'Leave it by the side door.',t:'00:11'}],noiseNotes:['Rain and traffic audible in the background.']}},
    { id:'ev-note',type:'image',title:'Folded note',description:'A handwritten note recovered near the office.',timestamp:'2025-10-14T21:20:00Z',relatedSuspectIds:['s1_mara'],reliability:'unverified',payload:{svg:SVG,altDescription:'A folded note with a short handwritten reminder.',caption:'Recovered after the scene was secured.'}}
  ];
  const targetEvidence = difficulty === 'easy' ? 8 : difficulty === 'hard' ? 14 : 11;
  const extraTypes = ['whatsapp_chat','image','cctv','audio_transcript','document','document','image'];
  const includedSuspects = new Set(suspects.map(s => s.id));
  for (const evidenceItem of evidence) evidenceItem.relatedSuspectIds = evidenceItem.relatedSuspectIds.filter(id => includedSuspects.has(id));
  const extras: any[] = Array.from({ length: targetEvidence - evidence.length }, (_, i) => {
    const type = extraTypes[i % extraTypes.length];
    const at = new Date(Date.parse('2025-10-14T19:00:00Z') + (i + 1) * 5 * 60_000).toISOString();
    const payload = type === 'whatsapp_chat' ? { chatName:'Evening shift',isGroup:false,participants:[{id:'mara',displayName:'Mara',suspectId:'s1_mara'},{id:'otto',displayName:'Otto',suspectId:'s5_otto'}],messages:[{id:`extra${i}a`,senderId:'mara',text:'Can you leave the folder by reception?',sentAt:at},{id:`extra${i}b`,senderId:'otto',text:'Already done.',sentAt:new Date(Date.parse(at)+60_000).toISOString()}] }
      : type === 'image' ? { svg:SVG,altDescription:'A general view of the workplace before closing.',caption:'Routine scene documentation.' }
      : type === 'cctv' ? { cameraLabel:'CAM 02',location:'West entrance',frames:[{t:at,caption:'The entrance is quiet.'},{t:new Date(Date.parse(at)+60_000).toISOString(),caption:'No one enters the frame.'},{t:new Date(Date.parse(at)+120_000).toISOString(),caption:'The hallway remains empty.'},{t:new Date(Date.parse(at)+180_000).toISOString(),caption:'No change in the corridor.'}],operatorLog:['No irregular activity reported.'] }
      : type === 'document' ? { kind:'report',html:'<h2>Routine report</h2><p>No irregular activity was noted during this period.</p>',plainText:'Routine report. No irregular activity noted.' }
      : { speakers:['Receptionist'],lines:[{speaker:'Receptionist',text:'The west entrance is clear.',t:'00:04'}],noiseNotes:['Low background room noise.'] };
    return { id:`ev-extra-${i+1}`,type,title:type==='whatsapp_chat'?'Staff check-in':type==='image'?'Closing time photograph':type==='cctv'?'West entrance camera':type==='document'?'Routine shift report':'Reception desk transcript',description:'A routine item collected during the evening investigation.',timestamp:at,linked:['s1_mara','s5_otto'].filter(id => includedSuspects.has(id)),decisive:false,payload };
  });
  evidence.push(...extras);
  return { title: 'The Last Shift', setting: 'A rain-washed private workplace after closing', incidentSummary: `A staff member was found dead after a late shift. The original case seed was: “${seed}”`, incidentTime: '2025-10-14T21:17:00Z', suspects, solution, hints: ['Compare the maintenance records with the order of events.', 'One suspect knew the inspection schedule had changed.', 'Cross-check Nico’s alibi against the corridor camera gap.'], evidence };
}

function extractJsonCandidate(raw: string) {
  const text = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  if (start < 0) throw new SyntaxError('Gemini response did not contain a JSON object or array.');
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      const open = stack.pop();
      if ((char === '}' && open !== '{') || (char === ']' && open !== '[')) throw new SyntaxError('Gemini returned mismatched JSON brackets.');
      if (!stack.length) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function repairCommonJsonFormatting(text: string) {
  let quotedKeys = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      quotedKeys += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; quotedKeys += char; continue; }
    quotedKeys += char;
    if (char === '{' || char === ',') {
      let keyStart = i + 1;
      while (/\s/.test(text[keyStart] || '')) { quotedKeys += text[keyStart]; keyStart += 1; }
      const key = text.slice(keyStart).match(/^([A-Za-z_$][\w$-]*)(\s*):/);
      if (key) {
        quotedKeys += `"${key[1]}"${key[2]}`;
        i = keyStart + key[1].length + key[2].length - 1;
      }
    }
  }
  let repaired = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < quotedKeys.length; i += 1) {
    const char = quotedKeys[i];
    if (inString) {
      repaired += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; repaired += char; continue; }
    if (char === ',') {
      let next = i + 1;
      while (/\s/.test(quotedKeys[next] || '')) next += 1;
      if (quotedKeys[next] === '}' || quotedKeys[next] === ']') continue;
    }
    repaired += char;
  }
  return repaired;
}

function inferEvidenceType(item: Record<string, any>) {
  const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload) ? item.payload : {};
  if (Array.isArray(payload.messages) || payload.chatName || payload.participants) return 'whatsapp_chat';
  if (payload.videoUrl || payload.cameraLabel || Array.isArray(payload.frames)) return 'cctv';
  if (Array.isArray(payload.lines) || payload.transcript || payload.speakers) return 'audio_transcript';
  if (payload.sceneType || payload.altDescription || payload.imageUrl || payload.svg) return 'image';
  if (payload.html || payload.plainText || payload.kind) return 'document';
  const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  if (/whatsapp|chat|message|conversation/.test(text)) return 'whatsapp_chat';
  if (/cctv|camera|video|footage|surveillance/.test(text)) return 'cctv';
  if (/audio|call|voice|transcript|recording/.test(text)) return 'audio_transcript';
  if (/photo|image|picture|photograph|scene/.test(text)) return 'image';
  return 'document';
}

function normalizeEvidenceType(value: unknown, item: Record<string, any>) {
  const candidate = typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? String((value as any).type || (value as any).name || (value as any).kind || Object.keys(value)[0] || '')
      : '';
  const key = candidate.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, string> = {
    chat: 'whatsapp_chat', whatsapp: 'whatsapp_chat', messages: 'whatsapp_chat', conversation: 'whatsapp_chat',
    photo: 'image', picture: 'image', photograph: 'image', crime_scene_photo: 'image',
    video: 'cctv', security_camera: 'cctv', surveillance: 'cctv', footage: 'cctv',
    audio: 'audio_transcript', transcript: 'audio_transcript', call_transcript: 'audio_transcript', voice_recording: 'audio_transcript',
    report: 'document', note: 'document', log: 'document', record: 'document', text: 'document'
  };
  const normalized = aliases[key] || key;
  if (['whatsapp_chat', 'image', 'cctv', 'document', 'audio_transcript'].includes(normalized)) return normalized;
  return inferEvidenceType(item);
}

function normalizeGeminiEvidenceTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => item && typeof item === 'object' && !Array.isArray(item)
    ? { ...(item as Record<string, any>), type: normalizeEvidenceType((item as Record<string, any>).type, item as Record<string, any>) }
    : item);
  if (value && typeof value === 'object' && Array.isArray((value as any).evidence)) {
    return { ...(value as Record<string, any>), evidence: normalizeGeminiEvidenceTypes((value as any).evidence) };
  }
  return value;
}
function parseGeminiJson(raw: string) {
  const candidate = extractJsonCandidate(raw);
  try { return JSON.parse(candidate); }
  catch { return JSON.parse(repairCommonJsonFormatting(candidate)); }
}
async function askGemini(prompt: string, schema: z.ZodTypeAny, mockValue?: unknown, maxOutputTokens = 6000, policy: { timeoutMs?: number; modelLimit?: number; attemptsPerModel?: number } = {}) {
  if (config.aiMock) return schema.parse(mockValue);
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required when AI_MOCK is false.');
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: policy.timeoutMs ?? 60_000 } });
  let correctedPrompt = `${prompt}\n\nReturn ONLY strict JSON with double-quoted property names, no comments, and no trailing commas.`;
  let lastError: unknown;
  const models = [...new Set([config.geminiModel, config.geminiFallbackModel, config.geminiEmergencyModel])].slice(0, policy.modelLimit ?? 3);
  for (const [modelIndex, model] of models.entries()) {
    let switchModels = false;
    const attempts = modelIndex === models.length - 1 ? 1 : (policy.attemptsPerModel ?? 2);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response;
      try {
        response = await client.models.generateContent({ model, contents: correctedPrompt, config: { responseMimeType: 'application/json', maxOutputTokens, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } });
      } catch (error) {
        lastError = error;
        const directStatus = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : undefined;
        const message = error instanceof Error ? error.message : String(error);
        const embeddedStatus = Number(message.match(/"code"\s*:\s*(\d{3})/)?.[1]);
        const status = directStatus || embeddedStatus;
        const retryable = [408, 429, 500, 502, 503, 504].includes(status) || /UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|Deadline expired|high demand/i.test(message);
        if (!retryable) throw error;
        if (attempt === attempts - 1) { switchModels = true; break; }
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      const raw = response.text || '{}';
      try { return schema.parse(normalizeGeminiEvidenceTypes(parseGeminiJson(raw))); }
      catch (error) {
        lastError = error;
        correctedPrompt = `${prompt}\n\nYour previous output failed validation: ${String(error)}. Include every required field with the correct type. Use double-quoted property names, no comments, and no trailing commas. Return corrected JSON only.`;
        if (attempt === attempts - 1) { switchModels = true; break; }
      }
    }
    if (!switchModels) break;
    if (modelIndex < models.length - 1) console.warn(`Gemini model ${model} is busy; switching to the next configured fallback.`);
  }
  throw lastError;
}
function moderateSeedLocally(seed: string) {
  const text = seed.toLowerCase();
  const minorTarget = /\b(child|children|minor|underage|schoolkid|schoolgirl|schoolboy)\b.{0,80}\b(victim|target|harmed|hurt|killed|murdered|abducted|kidnapped|raped|assaulted)\b|\b(victim|target|harmed|hurt|killed|murdered|abducted|kidnapped|raped|assaulted)\b.{0,80}\b(child|children|minor|underage|schoolkid|schoolgirl|schoolboy)\b/.test(text);
  const sexual = /\b(sexual|sexually|rape|molest|sexualized)\b/.test(text);
  const violence = /\b(kill|killed|murder|murdered|harm|hurt|abduct|kidnap|assault|attack|poison)\b/.test(text);
  const harmInstructions = /\b(how to|step[- ]by[- ]step|instructions? for|recipe for)\b.{0,80}\b(make|build|create|use|weapon|bomb|explosive|poison|toxin)\b/.test(text);
  const hate = /\b(genocide|ethnic cleansing|racially motivated|hate crime|neo[- ]nazi)\b/.test(text);
  const namedRealPerson = /\b(real person|real public figure|actual celebrity|real politician)\b/.test(text);
  const disallowed = (minorTarget && (sexual || violence)) || harmInstructions || hate || namedRealPerson;
  return { decision: disallowed ? 'disallowed' as const : 'allowed' as const, reason: disallowed ? 'The case seed matched a restricted content pattern.' : 'Gemini moderation was unavailable; no restricted pattern was found in this fictional seed.' };
}

function isTransientGeminiError(error: unknown) {
  const directStatus = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const embeddedStatus = Number(message.match(/"code"\s*:\s*(\d{3})/)?.[1]);
  return [408, 429, 500, 502, 503, 504].includes(directStatus || embeddedStatus) || /UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|Deadline expired|high demand|timed? ?out|deadline .{1,12} too short|minimum allowed deadline is 10s/i.test(message);
}

export async function moderateSeed(seed: string) {
  try {
    return await askGemini(
      `Classify this fictional mystery seed as allowed or disallowed. Return JSON with decision and reason. Disallow sexual content, harm to minors, real named people as victims or culprits, real-world harm instructions, and hate content. Seed: ${seed}`,
      ModerationSchema,
      { decision: 'allowed', reason: 'Fictional mystery seed.' },
      128,
      { timeoutMs: 12_000, modelLimit: 2, attemptsPerModel: 1 }
    );
  } catch (error) {
    if (!isTransientGeminiError(error)) throw error;
    console.warn('Gemini seed moderation timed out or was temporarily unavailable; using the local safety fallback for this seed.');
    return moderateSeedLocally(seed);
  }
}
export async function generateCase(seed: string, difficulty: string, onStage?: (stage: 'bible'|'evidence'|'validation'|'done') => void) {
  onStage?.('bible');
  const fixture = buildMock(seed, difficulty);
  const mockEvidence = fixture.evidence.map((e: any) => ({ id:e.id, type:e.type, title:e.title, description:e.description, timestamp:new Date(e.timestamp).toISOString(), linked:e.relatedSuspectIds ?? e.linked ?? [], decisive:e.isDecisive ?? e.decisive ?? false, payload:e.payload }));
  const requiredSuspects = difficulty === 'easy' ? 4 : difficulty === 'hard' ? 6 : 5;
  const expectedEvidence = difficulty === 'easy' ? 8 : difficulty === 'hard' ? 14 : 11;
  const mockPackage = { title: fixture.title, setting: fixture.setting, incidentSummary: fixture.incidentSummary, incidentTime: fixture.incidentTime, suspects: fixture.suspects, culprit: fixture.solution.culpritSuspectId, motive: fixture.solution.motive, method: fixture.solution.method, opportunity: fixture.solution.opportunity, timeline: fixture.solution.timeline, decisive: fixture.solution.decisiveEvidenceIds, redHerrings: JSON.stringify(fixture.solution.redHerrings), explanation: fixture.solution.explanation, evidence: mockEvidence };
  const data = await askGemini(`Create a complete, fair fictional detective case from this seed. Difficulty: ${difficulty}. Seed: ${seed}\nReturn one JSON object with title, setting, incidentSummary, incidentTime, suspects, culprit, motive, method, opportunity, timeline, decisive, redHerrings, explanation, evidence. Use this exact shape: suspects=[{id,name,age,role,publicBio,alibiClaim}], timeline=[{time,event,isPublic}], decisive=[evidence id strings], redHerrings=a concise string, evidence=[{id,type,title,description,timestamp,linked,decisive,payload}] where type is exactly one of "whatsapp_chat", "image", "cctv", "document", or "audio_transcript" as a JSON string (never use "audio"). Include exactly ${requiredSuspects} suspects and ${expectedEvidence} evidence items, with at least 2 WhatsApp chats, 2 images and ${difficulty === 'easy' ? 1 : 2} CCTV items. Every evidence item needs a unique id, valid suspect links, a valid ISO timestamp, and a realistic but concise payload for its type. For every whatsapp_chat payload provide chatName, isGroup, participants as objects with id, displayName, and suspectId, plus 4-8 natural messages with unique ids, senderId matching a participant, text, sentAt ISO timestamp, and delivered or read status; never return empty or placeholder conversations. Make the chats feel like believable recovered records with natural punctuation and short varied replies. For every image payload provide a distinct sceneType (such as kitchen, hotel, office, hallway, garden, gallery, warehouse, or laboratory), a scene-specific caption and altDescription, and metadata with location and takenAt; choose the scene details to match this case and this individual exhibit. The application supplies a case-matched fictional scene photograph. For every cctv payload provide 4-8 ordered frames with realistic timestamps and distinct captions from the same camera; include an operatorLog when relevant and do not invent a videoUrl. For every document payload provide a nonempty plainText or content body with the actual fictional record text; include title, author, or kind when suitable. Do not return blank HTML or metadata-only documents. Mark the 2-4 decisive evidence items with decisive=true and list their ids in decisive. Make the culprit inferable from cross-checkable clues. Do not reveal the solution in public evidence. Return JSON only.`, CasePackageSchema, mockPackage, 9000);
  onStage?.('evidence');
  let items = data.evidence;
  const suspectIds = new Set(data.suspects.map((s: any) => s.id));
  const evidenceIds = new Set(items.map((e: any) => e.id));
  const countType = (type: string) => items.filter((e: any) => e.type === type).length;
  const programmaticErrors: string[] = [];
  if (data.suspects.length !== requiredSuspects) programmaticErrors.push('wrong suspect count');
  if (suspectIds.size !== data.suspects.length) programmaticErrors.push('duplicate suspect ids');
  if (!suspectIds.has(data.culprit)) programmaticErrors.push('culprit is not a suspect');
  if (items.length !== expectedEvidence) programmaticErrors.push('wrong evidence count');
  if (evidenceIds.size !== items.length) programmaticErrors.push('duplicate evidence ids');
  if (data.decisive.length < 2 || data.decisive.length > 4 || data.decisive.some((id: string) => !evidenceIds.has(id))) programmaticErrors.push('decisive evidence references are invalid');
  if (data.decisive.some((id: string) => !items.some((e: any) => e.id === id && e.decisive))) programmaticErrors.push('decisive evidence is not marked decisive');
  if (countType('whatsapp_chat') < 2 || countType('image') < 2 || countType('cctv') < (difficulty === 'easy' ? 1 : 2)) programmaticErrors.push('evidence mix is incomplete');
  if (items.filter((e: any) => e.type === 'whatsapp_chat').some((e: any) => !Array.isArray(e.payload?.messages) || e.payload.messages.length < 3 || !Array.isArray(e.payload?.participants) || e.payload.participants.length < 2)) programmaticErrors.push('chat evidence is missing participants or messages');
  if (items.some((e: any) => e.linked.some((id: string) => !suspectIds.has(id)) || Number.isNaN(Date.parse(e.timestamp)))) programmaticErrors.push('evidence links or timestamps are invalid');
  if (programmaticErrors.length) throw new Error(`Generated case failed programmatic checks: ${programmaticErrors.join(', ')}`);
  const publicEvidence = (rows: any[]) => rows.map(item => { const copy = { ...item }; delete copy.decisive; return copy; });
  onStage?.('validation');
  if (config.aiDeepValidation) {
  let validation = await askGemini(`Act as an independent detective. Solve using ONLY the public case and evidence below. Return JSON {culpritSuspectId,reasoning,confidence,evidenceIdsUsed}.\nCase: ${JSON.stringify({ title:data.title, setting:data.setting, incidentSummary:data.incidentSummary, suspects:data.suspects, evidence:publicEvidence(items) })}`, ValidatorSchema, { culpritSuspectId: data.culprit, reasoning: 'The message, camera interruption, and altered maintenance log contradict one suspect’s alibi.', confidence: 0.92, evidenceIdsUsed: data.decisive });
  for (let repair = 0; validation.culpritSuspectId !== data.culprit || validation.confidence < 0.6; repair += 1) {
    if (repair >= 2) throw new Error('The independent detective could not solve this case after two evidence repairs.');
    items = await askGemini(`Repair the decisive clues so the intended solution can be deduced fairly. Previous independent detective result: ${JSON.stringify(validation)}. Intended reasoning must be supported without stating the culprit outright. Return the full evidence JSON array. Case context: ${JSON.stringify({ title:data.title, suspects:data.suspects, solution:{ culprit:data.culprit, motive:data.motive, method:data.method }, evidence:items })}`, EvidenceSchema, mockEvidence);
    validation = await askGemini(`Independently solve using ONLY public case data and evidence. Return JSON {culpritSuspectId,reasoning,confidence,evidenceIdsUsed}.\n${JSON.stringify({ title:data.title, suspects:data.suspects, evidence:publicEvidence(items) })}`, ValidatorSchema, { culpritSuspectId: data.culprit, reasoning: 'The decisive clues agree after repair.', confidence: 0.92, evidenceIdsUsed: data.decisive });
  }
  }
  const suspects = data.suspects.map((s: any, i: number) => ({ ...s, portraitSvg: sanitizeSvg(Portrait(['#c08b5c','#777d8a','#827564','#8b6b74','#668478','#9b875c'][i % 6])) }));
  const evidence = items.map((e: any) => ({ ...e, payload: { ...e.payload, ...(typeof e.payload?.svg === 'string' ? { svg: sanitizeSvg(e.payload.svg) } : {}), ...(typeof e.payload?.html === 'string' ? { html: sanitizeDocument(e.payload.html) } : {}), ...(Array.isArray(e.payload?.frames) ? { frames: e.payload.frames.map((f: any) => ({ ...f, svg: sanitizeSvg(f.svg) })) } : {}) } }));
  const redHerringCount = difficulty === 'easy' ? 1 : difficulty === 'hard' ? 3 : 2;
  const nonCulpritSuspects = data.suspects.filter((s: any) => s.id !== data.culprit);
  const redHerrings = Array.from({ length: redHerringCount }, (_, i) => ({ suspectId: nonCulpritSuspects[i % nonCulpritSuspects.length]?.id, evidenceIds: [i === 0 ? 'ev-receipt' : `ev-extra-${i}`], whyMisleading: data.redHerrings }));
  const solution = { culpritSuspectId: data.culprit, motive: data.motive, method: data.method, opportunity: data.opportunity, timeline: data.timeline, decisiveEvidenceIds: data.decisive, redHerrings, explanation: data.explanation };
  onStage?.('done');
  return { title: data.title, setting: data.setting, incidentSummary: data.incidentSummary, incidentTime: new Date(data.incidentTime), suspects, solution, hints: fixture.hints, evidence: evidence.map((e: any) => ({ _id: e.id, caseId: undefined, type: e.type, title: e.title, description: e.description, timestamp: new Date(e.timestamp), relatedSuspectIds: e.linked, reliability: 'verified', payload: e.payload, isDecisive: e.decisive })) };
}
