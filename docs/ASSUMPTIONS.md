# Assumptions

- `spec.md` was provided at the workspace root, so this project keeps that file as the source of truth instead of duplicating it into `docs/SPEC.md`.
- Evidence identifiers use stable string IDs (for example, `ev-chat`) so decisive clue references remain stable across mock and generated cases. The case and user identifiers remain MongoDB ObjectIds.
- The initial deterministic mock case uses one complete, repeatable case fixture and adapts the visible suspect count to the selected difficulty. Its fixture content is starter content, not a promise that all difficulty-specific evidence counts in the spec are met.
- The server starts only after MongoDB connects. This keeps readiness and writes truthful; configure a local Mongo instance before running the app.
- In v1 development, SVG and document assets are stored inline in MongoDB. The `StorageProvider` abstraction can be introduced when generated assets move to disk or object storage.
- The UI labels case events as fictional and uses a small set of starter SVG illustrations. This keeps the default experience self-contained without a real image-generation service.
- The provider choice was updated at the user's request: server generation uses Google's `@google/genai` SDK. Model selection is controlled by `GEMINI_MODEL`, defaulting to `gemini-3.8-flash`.
