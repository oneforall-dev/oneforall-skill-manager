# Oneforall Social Manager Backend

Persistent editorial-state service for the Oneforall Social Manager plugin.

## What it stores

- weekly social plans per client/campaign/platform
- publication cadence and minimum/target content buffers
- content items from idea to publication
- scheduled/published timestamps
- Social Publisher post IDs and published URLs
- asset IDs, captions, Director project IDs and approval receipts
- Google Calendar mapping per client
- Google Calendar event IDs per content item
- immutable status-change events
- researched four-layer discovery/hashtag sets per content item
- verified post-publish discovery measurements and rotation history

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

The orchestrator should first advance existing ideas and incomplete production before requesting net-new ideas.

## REST API

- `GET /health`
- `GET /api/dashboard/:client?campaign=default&platform=instagram`
- `POST /api/plans`
- `GET /api/content?client_slug=...&campaign=...&platform=...&status=...`
- `POST /api/content`
- `PATCH /api/content/:id/status`
- `PATCH /api/content/:id/calendar-link`
- `GET /api/calendars/:client`
- `POST /api/calendars/register`
- `POST /api/calendars/ensure`
- `POST /api/discovery/sets`
- `GET /api/discovery/sets`
- `POST /api/discovery/metrics`
- `GET /api/discovery/learning/:client`

## MCP endpoint

- `POST /mcp`

Exposed tools:

- `get_social_dashboard`
- `set_social_plan`
- `create_content_item`
- `transition_content_item`
- `list_content_items`
- `get_client_calendar`
- `register_client_calendar`
- `ensure_client_calendar`
- `link_calendar_event`
- `save_discovery_set`
- `list_discovery_sets`
- `record_discovery_metrics`
- `get_discovery_learning`

## Discovery integrity

Discovery sets combine four explicit layers: world/lore, artist/entity, genre/niche and the exact post context. Every saved set requires current research evidence and is versioned against one content item. Post-publish metrics are accepted only for content confirmed as published and must include an external source record. Dummy, mock, sample, test and placeholder sources are rejected. When no verified analytics source is connected, learning remains `PENDING_METRICS` instead of fabricating performance.

## Google Calendar architecture

Google Calendar is the human-visible editorial planning layer; it is not the source of truth for whether a social post is actually scheduled or published.

- Social Manager ledger owns content identity, lifecycle, buffer and mappings.
- Google Calendar owns intended editorial dates and client-visible planning.
- Social Publisher owns actual scheduled/published state.
- Auditor owns creative approval evidence.

The ChatGPT Google Calendar connector can list calendars and read/create/update/delete events in visible calendars. At the time this backend was authored, it does not expose a `create_calendar` action. For that missing capability, this backend can create one dedicated Google Calendar per client via the official Google Calendar API and persist the resulting calendar ID.

Suggested calendar naming convention:

`Social — <Client Name>`

### Calendar creation OAuth

To enable `ensure_client_calendar`, configure:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

The refresh token must have Google Calendar write permission sufficient to create calendars. Do not commit credentials; configure them as Coolify environment secrets.

If these variables are absent, normal Social Manager operations and Calendar event syncing through the connected ChatGPT Google Calendar capability can still work, but automatic creation of a brand-new secondary calendar will return `GOOGLE_OAUTH_NOT_CONFIGURED` rather than pretending success.

## Local setup

1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`.
3. Optionally configure the Google OAuth values above for calendar provisioning.
4. Run `npm install`.
5. Run `npm run migrate`.
6. Run `npm start`.

## Production deployment

The service is container-ready through `Dockerfile`. In Coolify, create a service from this directory, attach PostgreSQL, set `DATABASE_URL`, expose port `3000`, and configure an HTTPS domain. Add Google OAuth secrets only if the service should be allowed to create secondary calendars. After deployment, the plugin can point its `mcp.json` to `https://YOUR-DOMAIN/mcp`.

## Calendar sync workflow

1. Social Manager resolves the client's mapped calendar.
2. If no mapping exists, it first checks visible Google Calendars for a suitable existing client calendar.
3. If a calendar is selected or created, its ID is persisted with `register_client_calendar` or `ensure_client_calendar`.
4. Planned editorial slots may be created as transparent Google Calendar events and linked with `link_calendar_event`.
5. A Calendar event alone does not move the content item to `scheduled`.
6. When Social Publisher confirms scheduling, the ledger moves to `scheduled` and the Calendar event should be aligned to the confirmed Publisher timestamp.
7. When Social Publisher confirms publication, the ledger moves to `published` and the Calendar event can be updated with published status and URL.
8. If a user manually moves a Calendar event after Publisher scheduling, Social Manager should flag a mismatch; it must not silently alter the Publisher schedule.

## Social Publisher handoff

The Social Manager does not duplicate publishing logic. Its publication workflow is:

1. Select an `approved` content item and an open schedule slot.
2. Ask Social Publisher to create/schedule the post.
3. After the required explicit publication/schedule approval, Social Publisher performs the side effect.
4. On confirmed scheduling, call `transition_content_item` with status `scheduled`, `scheduled_at` and `publisher_post_id`.
5. On confirmed live publication, call it again with status `published`, `published_at`, `publisher_post_id` and `published_url` when available.
6. Recalculate the dashboard. If the future buffer dropped below the minimum, begin replenishment.

## Director / Auditor handoff

- Existing suitable work is advanced before net-new ideas are requested.
- Video production routes to Director; non-video strategy/creative planning routes to the appropriate content capability.
- Produced assets move to `audit`.
- Auditor PASS moves the exact version to `approved` with its approval receipt.
- Auditor FAIL moves it to `needs_revision`, preserving the feedback in metadata.
- Any modification after approval must invalidate or replace the previous approval receipt before publication.
