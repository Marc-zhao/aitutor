# Marc's AI Tutor

Production Socratic AI tutor and teacher dashboard.

## Runtime

- `index.html`: student tutor and teacher views
- `api/chat.js`: authenticated Zhipu conversation endpoint
- `api/search.js`: authenticated Zhipu and optional OpenAlex evidence search
- `guardrails.js`: response quality and safety checks
- `guardrail-regression.test.js`: local regression suite

## Deploy

1. Apply both SQL files in `supabase/migrations/` in filename order.
2. Add `ZHIPU_API_KEY` to the Vercel project for all environments. Existing
   deployments using the `Zhipu` variable name are also supported.
3. Add `OPENALEX_API_KEY` when academic evidence search is required.
4. Run `node guardrail-regression.test.js`.
5. Deploy this directory and verify student chat, search, assignments, and the
   teacher conversation viewer.

AI requests require a valid Supabase access token and consume a database-backed
per-user quota. Private provider keys are never sent to the browser.
