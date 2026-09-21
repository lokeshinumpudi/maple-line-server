# Maple Line server

Jev world generation and sightseeing decisions for [Maple Line](https://github.com/lokeshinumpudi/maple-line), with optional Sarvam narration. Runs separately from the browser game as a Vercel Fluid Node function.

Install with `pnpm install`. Set the server-only variables from `.env.example`; run `pnpm start` for local development. Vercel uses `api/director/[...path].js` and `vercel.json`. Configure `ALLOWED_ORIGINS` with the public client origins. Keys never belong in browser variables.

Endpoints: GET `/api/director/status`, POST `/api/director/world`, POST `/api/director/decide`, POST `/api/director/narration`, GET `/api/director/narration/status`. Requests require JSON and are limited to 4,096 bytes. Provider failures return labelled fallback results. Narration uses an ephemeral cache under /tmp on Vercel.

Provider concurrency and cooldowns apply per function instance. CORS restricts browser origins; it is not user authentication or a global spending limit.

Verify with `pnpm test`, `pnpm typecheck`, and `pnpm lint`. Source is exported from the game workspace with `node scripts/export-director.mjs <directory>`.
