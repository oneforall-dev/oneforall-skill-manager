# Oneforall Social Manager Backend

Persistent editorial-state service for the Oneforall Social Manager plugin.

## What it stores

- weekly social plans per client/campaign/platform
- publication cadence and minimum/target content buffers
- content items from idea to publication
- scheduled/published timestamps
- Social Publisher post IDs and published URLs
- asset IDs, captions, Director project IDs and approval receipts
- immutable status-change events

## Pipeline

`idea -> generated -> in_production -> produced -> audit -> approved -> scheduled -> published`

Exception states: `needs_revision`, `blocked`, `failed`.

## Replenishment rule

Future inventory is the number of items in `approved` or `scheduled` whose scheduled date is still in the future (or not assigned yet).

If:

`future_inventory < buffer_min`

then:

`replenish = true`

and the number of content items that should be advanced toward readiness is:

`buffer_target - future_inventory`.

The orchestrator should first advance existing ideas and incomplete production before requesting net-new ideas from Oneforall Director.

## REST API

- `GET /health`
- `GET /api/dashboard/:client?campaign=default&platform=instagram`
- `POST /api/plans`
- `GET /api/content?client_slug=...&campaign=...&platform=...&status=...`
- `POST /api/content`
- `PATCH /api/content/:id/status`

## MCP endpoint

- `POST /mcp`

Exposed tools:

- `get_social_dashboard`
- `set_social_plan`
- `create_content_item`
- `transition_content_item`
- `list_content_items`

## Local setup

1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`.
3. Run `npm install`.
4. Run `npm run migrate`.
5. Run `npm start`.

## Production deployment

The service is container-ready through `Dockerfile`. In Coolify, create a service from this directory, attach PostgreSQL, set `DATABASE_URL`, expose port `3000`, and configure an HTTPS domain. After deployment, the plugin can point its `mcp.json` to `https://YOUR-DOMAIN/mcp`.

## Social Publisher handoff

The Social Manager does not duplicate publishing logic. Its publication workflow is:

1. Select an `approved` content item and an open schedule slot.
2. Ask Social Publisher to create/schedule the post.
3. After the required explicit publication/schedule approval, Social Publisher performs the side effect.
4. On confirmed scheduling, call `transition_content_item` with status `scheduled`, `scheduled_at` and `publisher_post_id`.
5. On confirmed live publication, call it again with status `published`, `published_at`, `publisher_post_id` and `published_url` when available.
6. Recalculate the dashboard. If the future buffer dropped below the minimum, begin replenishment.

## Director / Auditor handoff

- Director receives the highest-priority existing idea/brief first.
- Produced assets move to `audit`.
- Auditor PASS moves the exact version to `approved` with its approval receipt.
- Auditor FAIL moves it to `needs_revision`, preserving the feedback in metadata.
- Any modification after approval must invalidate or replace the previous approval receipt before publication.
