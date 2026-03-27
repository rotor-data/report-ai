# Report AI

## Run

1. `npm install`
2. `npm run dev`

Netlify function routes are available under `/api/*`.

## Required env vars

- `NEON_DATABASE_URL`
- `HUB_JWT_PUBLIC_KEY_PEM`
- `HUB_JWT_ISSUER` (optional, default `hub.rotor-platform.com`)
- `MODULE_AUDIENCE` (set to `report-ai`)
- `ANTHROPIC_API_KEY` (optional for local fallback mode)
- `BROWSERLESS_TOKEN` (for PDF export)

## Module audience pattern

- `brand-os`: `MODULE_AUDIENCE=brand-os`
- `email-ai`: `MODULE_AUDIENCE=email-ai`
- `report-ai`: `MODULE_AUDIENCE=report-ai`
