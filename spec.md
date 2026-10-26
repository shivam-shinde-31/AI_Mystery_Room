# AI Mystery Room — Product & Technical Specification

> **Status:** v1.0 — Single Source of Truth
> **Audience:** Codex (AI coding agent). Build exactly what is specified. Where something is marked `DECISION`, follow the stated decision. Where something is marked `OUT OF SCOPE`, do not build it. If anything is ambiguous, choose the simplest option consistent with this document and record the choice in `docs/ASSUMPTIONS.md`.

---

## 1. Product Overview

**AI Mystery Room** is a web app where a user submits a short scenario or story seed (e.g., "A famous chef is found dead in the locked walk-in freezer of her restaurant"). The backend uses Gemini to invent a complete fictional investigation: a cast of suspects, a hidden culprit, a timeline, and a set of **evidence items** (WhatsApp chats, images, CCTV recordings, and others). The user studies the evidence, optionally takes notes, and finally **accuses one suspect**. The app reveals whether they were right and explains the full solution.

### 1.1 Goals
1. Turn any short seed into a solvable, fair, self-consistent mystery in under ~90 seconds.
2. Present evidence in realistic, immersive formats.
3. Guarantee the case is **solvable by deduction** (not guesswork) via a generation + validation pipeline.
4. Keep the culprit and solution secret on the server until the user submits an accusation.

### 1.2 Non-Goals (OUT OF SCOPE for v1)
- Multiplayer / shared rooms
- Payments / subscriptions
- Mobile native apps
- Real image or video model training
- User-uploaded evidence
- Leaderboards (a simple stats page is fine, see §9)
- Real people: cases must be **fully fictional**; no real persons, brands-as-defendants, or real crimes (see §12)

---

## 2. Tech Stack

| Layer | Choice |
|---|---|
| Database | MongoDB (Mongoose ODM) |
| Backend | Node.js 20+, Express 4/5, **TypeScript** |
| Frontend | React 18 + Vite + **TypeScript**, React Router, TanStack Query, Tailwind CSS |
| AI | Google Gemini via `@google/genai` |
| Validation | Zod (shared schemas between client and server) |
| Auth | JWT (access token in httpOnly cookie), bcrypt for passwords |
| Testing | Vitest (unit), Supertest (API), Playwright (one E2E happy path) |
| Tooling | ESLint, Prettier, npm workspaces monorepo |
| Image storage | Local disk (`/storage`) in dev; abstract behind a `StorageProvider` interface so S3 can be swapped in |

**DECISION — Gemini model:** read from env `GEMINI_MODEL`, default `gemini-3.8-flash`. Never hardcode the model name outside config.

**DECISION — v1 uses Gemini for text and structured data only; image and CCTV evidence stays SVG-based.** Therefore image and CCTV evidence is produced as follows:
- **Images:** Gemini generates **SVG scene illustrations / document renders** (receipts, ID badges, floor plans, sticky notes, torn notes, photo-like diagrams) plus a text `altDescription`. The code is sanitized (see §12). An optional `ImageProvider` interface exists so a real image-generation API can be plugged in later; v1 ships only the `SvgImageProvider`.
- **CCTV recordings:** rendered as a **timestamped frame sequence**. Gemini outputs 4–12 SVG frames per recording, each with timestamp, camera label, and caption. The frontend plays them like a low-framerate CCTV feed (CRT styling, scanlines, REC indicator, timestamp overlay), with play/pause/scrub. A text "operator log" accompanies each recording.

---

## 3. User Flow

1. **Landing page** — explains the concept, has a seed input (text area, 20–1000 chars) and difficulty selector (`easy | medium | hard`). Guests may try one case; creating more requires login.
2. **Generate** — user submits seed → server creates a `Case` with `status: "generating"` → client shows a progress screen (polling every 2s, or SSE; see §7) with stage labels.
3. **Briefing** — once `status: "ready"`, user sees the case briefing: title, setting, victim/incident summary, list of suspects (name, role, photo-card, public bio), and a count of evidence items.
4. **Investigation Room** — the main screen. Evidence board with filters (type, suspect, timestamp). Opening an item shows the appropriate viewer (§6). The user may:
   - Mark evidence as "key" (pin)
   - Write notes (per case, autosaved)
   - Use the optional **Hint** button (max 3 per case; each reveals a progressively more specific nudge; costs score)
   - Interview suspects? → **OUT OF SCOPE v1** (do not build chat with suspects)
5. **Accusation** — user picks one suspect and must write a short **reasoning** (min 30 chars, max 1000) citing at least one evidence item (UI requires selecting 1–5 evidence items as "supporting evidence").
6. **Reveal** — server evaluates, returns: correct/incorrect, culprit identity, motive, method, full timeline, an explanation walking through the decisive clues, and a score. Case becomes `solved` or `failed` and is read-only for evidence/notes afterwards.
7. **History** — logged-in users see past cases and can replay a revealed case.

A user gets **one accusation per case** (no retries) — `DECISION`. (Keeps stakes meaningful.)

---

## 4. Domain Model (MongoDB / Mongoose)

All collections have `createdAt` / `updatedAt` (Mongoose timestamps). IDs are Mongo ObjectIds exposed as strings.

### 4.1 `User`
```ts
{
  _id, email: string (unique, lowercase), passwordHash: string,
  displayName: string (2-40),
  role: "user" | "admin"  // default "user"
  stats: { casesPlayed: number, casesSolved: number, totalScore: number }
}
```

### 4.2 `Case`
```ts
{
  _id,
  ownerId: ObjectId | null,        // null for guest
  guestToken: string | null,       // random uuid stored in a cookie for guest ownership
  seed: string,                    // user's original prompt
  difficulty: "easy" | "medium" | "hard",
  status: "generating" | "ready" | "failed_generation" | "solved" | "failed",
  generationStage: "bible" | "evidence" | "validation" | "done",
  generationError: string | null,

  // PUBLIC (safe to send to the client before reveal)
  title: string,
  setting: string,                 // place, time period, atmosphere
  incidentSummary: string,         // what happened, as known to investigators
  incidentTime: Date,              // fictional datetime, ISO
  suspects: Suspect[],             // see 4.3 (public fields only exposed pre-reveal)

  // SECRET (NEVER sent to the client before reveal)
  solution: {
    culpritSuspectId: string,
    motive: string,
    method: string,
    opportunity: string,
    timeline: { time: string, event: string, isPublic: boolean }[],
    decisiveEvidenceIds: string[],   // 2-4 evidence ids that logically pin the culprit
    redHerrings: { suspectId: string, evidenceIds: string[], whyMisleading: string }[],
    explanation: string               // reveal narrative (markdown)
  },
  hints: string[],                  // exactly 3, ordered vague → specific. SECRET until requested.
  hintsUsed: number,                // 0-3

  accusation: {
    suspectId: string, reasoning: string, supportingEvidenceIds: string[],
    submittedAt: Date, correct: boolean, score: number
  } | null,

  modelMeta: { model: string, inputTokens: number, outputTokens: number, generationMs: number }
}
```

### 4.3 `Suspect` (embedded in Case)
```ts
{
  id: string,                   // stable slug e.g. "s1_marco_vale"
  name: string,
  age: number,
  role: string,                 // relation to victim/incident
  publicBio: string,            // 2-4 sentences
  alibiClaim: string,           // what they claim publicly
  portraitSvg: string,          // sanitized SVG avatar (simple, stylized)
  // secret fields live under case.solution, NOT here
}
```

### 4.4 `Evidence` (separate collection, `caseId` indexed)
```ts
{
  _id, caseId: ObjectId, 
  type: "whatsapp_chat" | "image" | "cctv" | "document" | "audio_transcript",
  title: string,
  description: string,           // 1-2 sentence neutral description (shown on the board card)
  timestamp: Date,               // in-world time the evidence was created/captured
  relatedSuspectIds: string[],   // who appears / is mentioned (public tagging, must not leak guilt)
  reliability: "verified" | "unverified",  // flavor; unverified items may be misleading
  payload: WhatsappPayload | ImagePayload | CctvPayload | DocumentPayload | AudioTranscriptPayload,
  isDecisive: boolean            // SECRET: never sent pre-reveal
}
```

**Payloads** (discriminated union on `type`):
```ts
WhatsappPayload = {
  chatName: string, isGroup: boolean, participants: {id:string, displayName:string, suspectId?:string}[],
  messages: { id: string, senderId: string, text: string, sentAt: string(ISO),
              status?: "sent"|"delivered"|"read", deleted?: boolean, edited?: boolean,
              replyToId?: string, attachmentLabel?: string }[]   // 8-40 messages
}
ImagePayload = { svg: string, altDescription: string, caption?: string, metadata?: { camera?:string, location?:string, takenAt?:string } }
CctvPayload  = { cameraLabel: string, location: string, frames: { t: string(ISO), svg: string, caption: string }[],  // 4-12 frames
                 operatorLog: string[], gaps?: { from: string, to: string, reason: string }[] }   // gaps = missing footage, can be clues
DocumentPayload = { kind: "receipt"|"email"|"note"|"report"|"log"|"ticket", html: string (sanitized), plainText: string }
AudioTranscriptPayload = { speakers: string[], lines: { speaker: string, text: string, t: string }[], noiseNotes?: string[] }
```

### 4.5 `Note`
```ts
{ _id, caseId, userId|guestToken, content: string (≤ 10000), pinnedEvidenceIds: string[] }
```
One note document per (case, owner). Upsert.

### 4.6 Indexes
- `Case`: `{ ownerId: 1, createdAt: -1 }`, `{ guestToken: 1 }`
- `Evidence`: `{ caseId: 1, timestamp: 1 }`
- `Note`: unique `{ caseId: 1, ownerKey: 1 }`
- `User`: unique `email`

---

## 5. AI Generation Pipeline (core of the product)

Implemented in `server/src/ai/`. All Gemini calls go through a single `geminiClient.ts` wrapper that: sets model from env, applies timeouts (60s per call), retries (max 2, exponential backoff, only on 429/5xx/timeouts), logs token usage, and **forces JSON output validated by Zod**. If validation fails, retry once with the Zod error appended ("Your previous output failed validation: …; return corrected JSON only"). After that, fail the stage.

Use structured output via tool-use / JSON schema where available; otherwise instruct "Return ONLY a JSON object" and parse. Strip code fences before parsing.

### Stage 1 — Case Bible (`stage: "bible"`)
Input: `seed`, `difficulty`.
Output (Zod `CaseBibleSchema`): title, setting, incidentSummary, incidentTime, 4–6 suspects (easy: 4, medium: 5, hard: 6) with hidden attributes, solution object (§4.2), a **ground-truth timeline**, and an **evidence plan**: a list of evidence items to create, each with `{ id, type, intent, whatItReveals, linkedSuspectIds, isDecisive, isRedHerring }`.

Rules enforced in the prompt AND verified in code:
- Exactly **one** culprit; culprit must be among suspects.
- Every suspect has a plausible motive, so the culprit is not obvious by motive alone.
- The culprit is identifiable **only** through the combination of 2–4 decisive evidence items (logical deduction: e.g., a timestamp contradiction + a message + a CCTV gap).
- **Difficulty tuning:** easy = 8 evidence, 1 red herring, decisive clues fairly direct; medium = 11 evidence, 2–3 red herrings, one contradiction to spot; hard = 14 evidence, 3–4 red herrings, culprit's alibi appears solid until cross-referencing two sources.
- Evidence mix must include at least **2 WhatsApp chats, 2 images, 1 CCTV** (medium/hard: 2 CCTV), and the remainder from document/audio_transcript.
- All names, businesses, phone numbers, and places are fictional. Phone numbers must use fictional ranges (e.g., `+91 98XXX 0XXXX` patterns with obviously fake digits like `…01234`). No real brands as wrongdoers.
- No explicit gore, sexual content, or content involving minors as victims/suspects. Crimes are PG-13 mystery tone (theft, fraud, sabotage, poisoning-off-screen, murder with no graphic detail). If the seed requests disallowed content, the bible stage returns `{ "refused": true, "reason": string }` and the case becomes `failed_generation` with a friendly message.

### Stage 2 — Evidence Generation (`stage: "evidence"`)
For each planned evidence item, one Gemini call (run **in parallel, concurrency 4**) with the full bible as context (in a cached system prompt block to save tokens) plus the specific plan entry. Each call returns a payload matching the Zod schema for its type.
Rules in prompt:
- Every in-evidence fact must be **consistent** with the bible timeline.
- Decisive evidence must contain its clue **subtly**, never stated outright ("X did it"). Clues are embedded in details: timestamps, wording, a deleted message, an object visible in a frame, a gap in CCTV, a receipt time.
- Red herrings must look suspicious but be explainable by facts available elsewhere in the evidence set.
- WhatsApp chats must feel real: slang, typos, emojis, voice-note placeholders, "this message was deleted", read-receipt timing, group vs 1:1.
- SVG rules: `viewBox` required, max 8KB per SVG, no `<script>`, no `<foreignObject>`, no external `href`/`xlink:href`, no event-handler attributes, no `<image>` with remote URLs. Style: flat, moody, simple shapes; text inside SVG limited.
- CCTV frames: consistent camera angle across frames (same static background group), with moving elements changing between frames; each frame has a caption written as neutral observation.

### Stage 3 — Validation (`stage: "validation"`)
A separate Gemini call acting as an **independent detective** receives ONLY the public case data and all evidence (no solution, no `isDecisive` flags) and must output `{ culpritSuspectId, reasoning, confidence: 0-1, evidenceIdsUsed[] }`.
- **Pass** if `culpritSuspectId === solution.culpritSuspectId` and `confidence >= 0.6`.
- **Fail** → regenerate only the decisive evidence items (max **2 repair loops**), passing the validator's reasoning as feedback ("a solver concluded X because Y; strengthen/clarify clue Z or fix contradiction").
- If it still fails, mark `failed_generation` with a retryable error. (Admin log records details.)
Additionally run **programmatic checks**: all `relatedSuspectIds` exist; all `decisiveEvidenceIds` exist; evidence counts/mix match difficulty; no SVG violates sanitization; timeline timestamps parse.

### Stage 4 — Finalize
Sanitize all HTML/SVG (§12), persist `Evidence` docs, set `Case.status = "ready"`.

**Cost controls:** max total tokens per case configurable (`MAX_TOKENS_PER_CASE`, default 120000); abort and fail gracefully if exceeded.

### Prompt files
Store prompts as versioned template files under `server/src/ai/prompts/` (`bible.md`, `whatsapp.md`, `image.md`, `cctv.md`, `document.md`, `audio.md`, `validator.md`, `repair.md`, `hints.md`). Include a `PROMPT_VERSION` constant saved in `modelMeta`. Prompts must contain the rules above verbatim.

---

## 6. Frontend Specification

### 6.1 Routes
| Route | Page | Auth |
|---|---|---|
| `/` | Landing + seed form | public |
| `/login`, `/register` | Auth forms | public |
| `/cases` | My cases (history) | user |
| `/case/:id/generating` | Progress screen | owner |
| `/case/:id` | Briefing | owner |
| `/case/:id/room` | Investigation room | owner |
| `/case/:id/accuse` | Accusation form | owner |
| `/case/:id/reveal` | Result + solution | owner (after accusation) |
| `/about` | How it works | public |
| `*` | 404 | public |

Guest ownership: server sets an httpOnly `guest_token` cookie on first case creation. On registration/login, a guest's cases are claimed (`ownerId` set, `guestToken` cleared).

### 6.2 Evidence Viewers
- **WhatsApp viewer:** faithful chat UI — green header with chat name, bubble layout (sender left, "me" right where applicable), timestamps, date separators, double ticks, "This message was deleted", reply quotes, voice-note placeholder with fake waveform, group chats with colored sender names.
- **Image viewer:** renders sanitized SVG inline; zoom (wheel/buttons) and pan; shows caption, `altDescription`, and metadata panel (EXIF-style).
- **CCTV viewer:** CRT-style frame, scanline overlay, `REC ●` blinking, timestamp + camera label overlay, play/pause, scrubber, speed (1×/2×), frame-step buttons, operator log in a side panel, "SIGNAL LOST" screen for gaps.
- **Document viewer:** paper-style card rendering sanitized HTML (use DOMPurify client-side as a second layer).
- **Audio transcript viewer:** script-style transcript with speaker colors and noise annotations (no real audio in v1).

### 6.3 Investigation Room Layout
- Left: evidence list/board (cards with type icon, title, time, suspect avatars, pin toggle). Filters: type, suspect, "pinned only", search. Sort by in-world time (default).
- Center: active evidence viewer.
- Right (collapsible): Suspects panel (bios, alibi claims), Notes editor (autosave debounce 800ms), Timeline helper (auto-built from evidence timestamps, read-only).
- Header: case title, hints button (shows remaining), "Make Accusation" button.
- Responsive: usable at ≥360px width (panels become tabs on mobile).

### 6.4 Visual Design
Dark noir theme, accent amber (`#f5a524`) and desaturated red; monospace for CCTV/log elements, serif headings. Provide empty/loading/error states for every async view. Accessible: keyboard navigation, focus rings, ARIA labels, `alt` text from `altDescription`, reduced-motion support (disable scanline flicker and auto-play).

### 6.5 State
TanStack Query for server state; local component state otherwise. No Redux.

---

## 7. API Specification

Base path `/api/v1`. JSON only. Errors use a uniform shape:
```json
{ "error": { "code": "STRING_CODE", "message": "Human readable", "details": {} } }
```
Validation with Zod middleware → `400 VALIDATION_ERROR`.

### 7.1 Auth
| Method & Path | Body | Response |
|---|---|---|
| `POST /auth/register` | `{email, password(min 8), displayName}` | `201 {user}` + sets cookie |
| `POST /auth/login` | `{email, password}` | `200 {user}` + cookie |
| `POST /auth/logout` | — | `204` |
| `GET /auth/me` | — | `200 {user}` or `401` |

### 7.2 Cases
| Method & Path | Description | Response |
|---|---|---|
| `POST /cases` | Body `{seed, difficulty}`. Creates case, starts async generation. Guest limit: 1 case per `guest_token`; user limit: 5 per day (configurable). | `202 {caseId, status:"generating"}` |
| `GET /cases/:id/status` | Poll for progress | `{status, generationStage, error?}` |
| `GET /cases/:id/events` | **SSE** stream of stage updates (optional enhancement; polling must work without it) | event stream |
| `GET /cases` | List current user's cases (summary) | `{cases: [{id,title,difficulty,status,createdAt,score?}]}` |
| `GET /cases/:id` | Public case view (no solution, no hints text, no `isDecisive`) | `{case}` |
| `DELETE /cases/:id` | Owner deletes a case and its evidence/notes | `204` |

### 7.3 Evidence
| Method & Path | Description |
|---|---|
| `GET /cases/:id/evidence` | List with summary fields (no payload) |
| `GET /cases/:id/evidence/:evidenceId` | Full item incl. payload (never `isDecisive` pre-reveal) |

### 7.4 Notes
| `GET /cases/:id/notes` | → `{content, pinnedEvidenceIds}` |
| `PUT /cases/:id/notes` | Body `{content, pinnedEvidenceIds}` → `200` (rejects if case already revealed) |

### 7.5 Hints
`POST /cases/:id/hints` → returns next hint `{index, text, remaining}`; increments `hintsUsed`; `409 NO_HINTS_LEFT` after 3.

### 7.6 Accusation
`POST /cases/:id/accuse` Body `{suspectId, reasoning, supportingEvidenceIds[]}`.
- `409 ALREADY_ACCUSED` if accusation exists.
- Server computes correctness; sets status `solved`/`failed`; computes score; updates user stats.
- Response: `{correct, score, solution: {culprit, motive, method, opportunity, timeline, decisiveEvidenceIds, redHerrings, explanation}}`.

`GET /cases/:id/reveal` — returns the same solution payload; `403 NOT_REVEALED` if no accusation yet.

### 7.7 Scoring
```
base = correct ? 1000 : 0
evidenceBonus = correct ? 100 × |supportingEvidenceIds ∩ decisiveEvidenceIds| (cap 300) : 0
hintPenalty = 150 × hintsUsed
difficultyMultiplier = easy 1.0, medium 1.25, hard 1.5
score = max(0, (base + evidenceBonus − hintPenalty)) × difficultyMultiplier   // rounded to integer
```
Incorrect accusations score 0.

### 7.8 Admin / Health
- `GET /health` → `{ok:true, db:"up"|"down"}`
- `GET /admin/cases/:id/debug` (role admin) → full case including solution and generation logs.

### 7.9 Security of secrets
Public serializers (`toPublicCase`, `toPublicEvidence`) are the **only** way to return case/evidence data pre-reveal. Add a unit test asserting that no key named `solution`, `hints`, `isDecisive`, or `culpritSuspectId` appears in any pre-reveal response.

---

## 8. Backend Architecture

```
/ (monorepo root, npm workspaces)
├─ package.json
├─ .env.example
├─ docs/
│   ├─ SPEC.md              (this file)
│   └─ ASSUMPTIONS.md
├─ shared/                  (Zod schemas + TS types shared by both sides)
│   └─ src/{schemas,types}.ts
├─ server/
│   └─ src/
│       ├─ index.ts, app.ts, config.ts
│       ├─ db/connect.ts
│       ├─ models/{User,Case,Evidence,Note}.ts
│       ├─ routes/{auth,cases,evidence,notes,hints,accuse,admin,health}.ts
│       ├─ controllers/
│       ├─ services/{caseService,scoringService,serializerService}.ts
│       ├─ ai/
│       │   ├─ geminiClient.ts
│       │   ├─ pipeline.ts            (orchestrates stages)
│       │   ├─ stages/{bible,evidence,validation,hints}.ts
│       │   ├─ prompts/*.md
│       │   └─ sanitize.ts            (SVG/HTML sanitizers)
│       ├─ jobs/generationQueue.ts    (in-process queue, concurrency 2)
│       ├─ middleware/{auth,guest,validate,rateLimit,error}.ts
│       ├─ storage/StorageProvider.ts
│       └─ utils/
├─ client/
│   └─ src/{main.tsx, App.tsx, pages/, components/{viewers,room,ui}/, api/, hooks/, styles/}
└─ tests/  (e2e)
```

**Generation execution:** `POST /cases` creates the doc then enqueues a job on an **in-process queue** (no Redis in v1). On server start, any case stuck in `generating` for >10 minutes is marked `failed_generation`. Each stage updates `generationStage` for progress display.

**Hints** are generated during the bible stage (stored in `Case.hints`) — no extra call at request time.

---

## 9. Non-Functional Requirements

- **Performance:** generation target p50 ≤ 90s (medium). Room page interactive < 2s after data fetch. Evidence payloads fetched lazily on open.
- **Rate limiting:** global 100 req/min/IP; `POST /cases` and `/auth/*` stricter (10/min/IP). Use `express-rate-limit`.
- **Security:** helmet, CORS limited to `CLIENT_ORIGIN`, httpOnly + sameSite=lax cookies, bcrypt cost 12, never log secrets or API keys, Zod-validate every input, escape all text rendering in React (no `dangerouslySetInnerHTML` except through the sanitizer component).
- **Logging:** pino, request IDs, per-stage generation timings and token counts.
- **Stats page (optional minor feature):** `/cases` shows total played/solved/average score from `User.stats`.
- **Observability of failures:** failed generation shows a friendly retry button that re-enqueues using the same seed.
- **Accessibility:** WCAG AA contrast on the dark theme.

---

## 10. Environment Variables (`.env.example`)

```
NODE_ENV=development
PORT=4000
CLIENT_ORIGIN=http://localhost:5173
MONGODB_URI=mongodb://localhost:27017/ai-mystery-room
JWT_SECRET=change-me
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash
MAX_TOKENS_PER_CASE=120000
GENERATION_CONCURRENCY=2
EVIDENCE_CONCURRENCY=4
GUEST_CASE_LIMIT=5
USER_DAILY_CASE_LIMIT=10
STORAGE_DRIVER=local
```
Client: `VITE_API_BASE_URL=http://localhost:4000/api/v1`.

---

## 11. Testing & Acceptance Criteria

### 11.1 Required Tests
- **Unit:** scoring formula; serializers never leak secrets; sanitizers strip `<script>`, `on*` attributes, `foreignObject`, external hrefs; Zod schemas accept valid / reject invalid fixtures; Gemini client retry logic (mocked).
- **Integration (Supertest + mongodb-memory-server):** auth flow; create case with **mocked Gemini** returning fixture JSON; status polling; evidence list/detail; notes upsert; hints exhaustion; accusation correct/incorrect; double-accusation 409; reveal 403 before accusation.
- **E2E (Playwright, mocked Gemini via env flag `AI_MOCK=true`):** landing → generate → briefing → open each evidence type → hint → accuse → reveal.

**`AI_MOCK=true`** must make the pipeline return deterministic fixtures from `server/src/ai/fixtures/` with no network calls. Ship one complete medium-difficulty fixture case.

### 11.2 Definition of Done (v1)
1. A user can enter a seed and receive a playable case with all evidence types rendering correctly.
2. The solution and decisive flags never appear in any API response before an accusation (verified by test).
3. The validation stage is implemented and a failed validation triggers the repair loop (verified with mocked failing validator).
4. Accusation scoring matches §7.7 exactly.
5. Guest → registered user case claiming works.
6. All tests in §11.1 pass; `npm run lint` and `npm run typecheck` pass with zero errors.
7. README documents setup, env vars, scripts (`dev`, `build`, `test`, `lint`, `typecheck`), and how to run with `AI_MOCK=true`.

---

## 12. Safety, Content & Legal Guardrails

- All cases are fiction; display a footer note: "All characters and events are fictional and AI-generated."
- Seed moderation: before the bible call, run a cheap Gemini classification (`allowed | disallowed`) on the seed. Disallowed: sexual content, minors in harm, real named individuals as culprits/victims, instructions for real-world harm, hate content. Return `422 SEED_NOT_ALLOWED` with a neutral message.
- Evidence must not contain functional instructions for real-world crimes (e.g., real poison dosages, hacking steps). Keep methods narrative-level.
- **Sanitization is mandatory** for every AI-produced SVG/HTML on both server (`sanitize-html` / custom SVG allowlist) and client (DOMPurify). Allowed SVG elements: `svg,g,defs,linearGradient,radialGradient,stop,rect,circle,ellipse,line,polyline,polygon,path,text,tspan,title,desc,filter(feGaussianBlur,feColorMatrix,feTurbulence only),pattern,clipPath,mask`. No scripts, no external references, no `style` attributes with `url(http…)`.
- Never expose the Gemini API key to the client; all AI calls are server-side.
- Add a "Report problem with this case" button storing a `Report` doc `{caseId, userId?, message}` (simple, no UI for admin in v1; accessible via admin debug endpoint list).

---

## 13. Build Order (milestones for Codex)

1. **M1 — Scaffolding:** monorepo, TS configs, lint/prettier, shared package, env config, health endpoint, Mongo connection.
2. **M2 — Auth & guest ownership:** models, routes, middleware, tests.
3. **M3 — Domain models & serializers:** Case, Evidence, Note, public serializers + leak test.
4. **M4 — AI layer with mock mode:** `geminiClient`, Zod schemas, fixtures, pipeline with `AI_MOCK=true`, queue, status endpoint.
5. **M5 — Real prompts & stages:** bible, evidence, validation + repair loop, sanitizers, seed moderation.
6. **M6 — Remaining API:** evidence, notes, hints, accuse, reveal, scoring.
7. **M7 — Frontend foundation:** routing, theme, API client, auth pages, landing + seed form, generating screen.
8. **M8 — Viewers & room:** WhatsApp, image, CCTV, document, audio viewers; investigation room layout; notes/pins/hints.
9. **M9 — Accusation & reveal flows**, history page.
10. **M10 — Polish:** accessibility pass, empty/error states, rate limits, E2E test, README.

Complete and test each milestone before starting the next. Commit per milestone with message `feat(Mx): …`.

---

## 14. Open Items (resolved defaults — change only by editing this file)

| Item | Default |
|---|---|
| Language of cases | English only |
| Real image generation | Not in v1 (SVG only; `ImageProvider` interface left for future) |
| Real audio/video | Not in v1 |
| Suspect interviews | Not in v1 |
| Accusation attempts | 1 per case |
| Queue infra | In-process (no Redis) |
| Case retention | Indefinite until owner deletes; guest cases auto-delete after 7 days (TTL index on `createdAt` where `ownerId` is null) |