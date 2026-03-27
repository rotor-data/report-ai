# Report AI

## Run

1. `npm install`
2. `npm run dev`

Netlify function routes are available under `/api/*`.

## Required env vars

- `NEON_DATABASE_URL`
- `HUB_JWT_PUBLIC_KEY_PEM`
- `HUB_JWT_ISSUER` (optional, default `hub.rotor-platform.com`)
- `ANTHROPIC_API_KEY` (optional for local fallback mode)
- `BROWSERLESS_TOKEN` (for PDF export)
