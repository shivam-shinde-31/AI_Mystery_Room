# AI Mystery Room

AI Mystery Room turns a short fictional scenario into a case file with suspects, evidence, notes, hints, and a final accusation. The project is an npm workspaces monorepo with a React client, Express API, MongoDB persistence, shared Zod schemas, and Google's Gemini API.

## Quick start

Requirements: Node.js 20 or newer and a MongoDB Atlas cluster (or another reachable MongoDB server).

1. Copy `.env.example` to the project root as `.env`, then set `MONGODB_URI` to your Atlas connection string. Replace the database username, password, and cluster host. URL-encode special characters in the password.
2. Install packages with `npm install`.
3. In Atlas, make sure the cluster is running, create a database user, and allow your current IP in **Network Access**.
4. Run `npm run dev` from the repository root, or run `npm run dev` from `server/` to start only the API. Both commands read the same project-root `.env`.
5. Open `http://localhost:5173`.

The API starts only after it can connect to MongoDB. For deployment, set `MONGODB_URI`, `JWT_SECRET`, `CLIENT_ORIGIN`, and any AI settings as environment variables in your hosting provider. In Atlas, allow the deployment server's outbound IP addresses in **Network Access**. The same Atlas URI can be used for local development and deployment, though separate databases or clusters are recommended for development and production.

The default configuration uses `AI_MOCK=true`, so it does not make AI network requests. To use Gemini, create a key in [Google AI Studio](https://aistudio.google.com/apikey), set it as `GEMINI_API_KEY`, and change `AI_MOCK` to `false`. `GEMINI_MODEL` selects the primary model and defaults to `gemini-3.8-flash`; if Gemini returns a temporary overload/rate-limit error, the server retries briefly and then tries `GEMINI_FALLBACK_MODEL` (`gemini-3.6-flash`) and `GEMINI_EMERGENCY_MODEL` (`gemini-3.5-flash-lite`). Fast generation uses Gemini's low thinking level and builds the case and evidence in one request, then checks them locally. Set `AI_DEEP_VALIDATION=true` to add the slower independent-solver check and any needed evidence repairs. Case creation is capped to control Gemini usage and prevent abuse: guests can create 5 cases per guest cookie, and signed-in accounts can create 10 cases per day. Change `GUEST_CASE_LIMIT` or `USER_DAILY_CASE_LIMIT` in `.env` or your hosting environment to adjust these caps.

## Scripts

- `npm run dev` — client and server in watch mode.
- `npm run build` — compile shared schemas, server, and client.
- `npm run lint` — lint the workspaces.
- `npm run typecheck` — type-check all workspaces.
- `npm test` — run Vitest.

## Structure

- `shared/` — request schemas and shared types.
- `server/` — Express API, Mongoose models, authentication, scoring, and AI pipeline.
- `client/` — React application and evidence viewers.
- `docs/ASSUMPTIONS.md` — implementation choices where the specification was underspecified.
- `spec.md` — source product and technical specification.

The API is served from `/api/v1`. The client uses `VITE_API_BASE_URL`; the server uses the variables documented in `.env.example`.

## Current scope

The workspace implements the main v1 investigation flow, seed moderation, an independent solver check with up to two evidence repair attempts, report intake, and a deterministic mock case path. Remaining production work includes splitting generation into per-item parallel prompts, full prompt/schema coverage for every evidence payload, token-budget accounting, and the unit, integration, and browser test suites described in `spec.md`.
