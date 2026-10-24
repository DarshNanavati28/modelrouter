# ModelRouter

A cost-, latency-, and quality-aware inference gateway prototype. ModelRouter estimates request difficulty, filters model endpoints against hard constraints, chooses by an explicit preference, and only fails over to another candidate when that attempt still fits the remaining latency and cost budgets.

## Run locally

Requires Node.js 20 or newer. The project has no third-party runtime dependencies.

1. Run \`npm start\` from this folder.
2. Open http://127.0.0.1:3000.
3. Use the built-in simulator without credentials, or choose **Connect live** and enter an OpenRouter API key for real inference.

The key is held in page memory only and is sent over the same-origin route endpoint. ModelRouter does not save or log it. A live request is forwarded to OpenRouter; do not send sensitive prompts to a provider unless your account and provider settings permit it.

## Routing rules

- Latency, estimated request cost, minimum capability, context window, and endpoint availability are hard filters.
- The request's estimated difficulty can raise the user-set capability floor. An unclear short request gets a one-level safety uplift.
- The default preference is lowest estimated cost; ties go to lower p95 latency. Latency and capability preferences are also available.
- The server repeats the hard-filter checks before live inference.
- A timeout or provider error can trigger failover only if the next candidate still meets all constraints and fits the remaining end-to-end latency and reserved cost budget.
- If no model qualifies, or no fallback fits, the request stops. No constraint is relaxed.
- The simulator's one-shot failure switch lets you inspect the failover path without spending credits.

## Model catalog

The starter list is a snapshot of OpenRouter model IDs, context windows, and per-token prices. The Vercel function at \`/api/models\` refreshes context and pricing from OpenRouter's public model catalog. Quality levels and p95 latency values are operator estimates; use measured values for a real deployment. The request controls let a judge vary latency and availability and see the decision change.

## Live mode and limits

Live mode uses OpenRouter's Chat Completions endpoint and current prompt/completion pricing when the model catalog can be refreshed. It limits output tokens and reserves the estimated cost of each attempted model. Provider usage is checked before a response is returned. Provider-side billing and tokenization can differ from estimates, so the live route is a prototype, not a production billing guarantee. The public Vercel demo should not be used as a shared production gateway without authentication, rate limits, and provider-specific billing controls.

The Vercel deployment needs no secret configured: each user may enter their own OpenRouter key in the interface. The app keeps that key in memory for the current page session only.

## Project structure

- \`index.html\`, \`src/\`: dashboard and routing engine
- \`api/models.js\`: live catalog refresh
- \`api/route.js\`: server-side constraint validation, live request, and safe failover
- \`server.js\`: zero-dependency local server
- \`vercel.json\`: static and serverless deployment configuration


## GitHub Pages demo

The GitHub Pages workflow publishes only `index.html` and `src/` as a static simulator. The live catalog and inference API remain on Vercel; GitHub Pages does not run the server endpoints. On the Pages build, the live connection control is hidden and the included model snapshot is used.
