import express from 'express';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const VERSION = '0.6.1';
const AUTH_ENABLED = /^(1|true|yes)$/i.test(process.env.AUTH_ENABLED ?? 'false');
const AUTH_ISSUER = process.env.AUTH_ISSUER;
const AUTH_AUDIENCE = process.env.AUTH_AUDIENCE;
const AUTH_JWKS_URI = process.env.AUTH_JWKS_URI ?? (AUTH_ISSUER ? `${AUTH_ISSUER.replace(/\/$/, '')}/.well-known/jwks.json` : null);
const AUTH_EMAIL_CLAIM = process.env.AUTH_EMAIL_CLAIM ?? 'https://oneforall.ocloud.click/email';
const MCP_RESOURCE_URL = (process.env.MCP_RESOURCE_URL ?? 'https://social-manager.ocloud.click').replace(/\/$/, '');
const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS ?? 'wilson.meza@gmail.com,agency.oneforall@gmail.com')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
);
const OAUTH_SCOPES = ['social.read','social.write','social.publish','social.admin'];
let remoteJwks;
const STATUSES = [
  'idea','generated','in_production','produced','audit','needs_revision',
  'approved','scheduled','published','blocked','failed'
];

const app = createMcpExpressApp ? createMcpExpressApp({
  host: '0.0.0.0',
  allowedHosts: [
    'social-manager.ocloud.click',
    'www.social-manager.ocloud.click',
    'ew1x2xznx26o7ja8s3dxjqn4.181.215.135.132.sslip.io'
  ]
}) : express();
app.use(express.json({ limit: '2mb' }));

function authChallenge(requiredScopes = ['social.read'], error = 'invalid_token', description = 'Authentication is required') {
  const metadata = `${MCP_RESOURCE_URL}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${metadata}", scope="${requiredScopes.join(' ')}", error="${error}", error_description="${description}"`;
}

function unauthorized(res, requiredScopes, error, description) {
  const challenge = authChallenge(requiredScopes, error, description);
  res.set('WWW-Authenticate', challenge);
  return res.status(401).json({ error, error_description: description });
}

function authDiagnostics() {
  return {
    enabled: AUTH_ENABLED,
    configured: Boolean(AUTH_ISSUER && AUTH_AUDIENCE && AUTH_JWKS_URI && ALLOWED_EMAILS.size),
    resource: MCP_RESOURCE_URL,
    issuer_configured: Boolean(AUTH_ISSUER),
    audience_configured: Boolean(AUTH_AUDIENCE),
    jwks_configured: Boolean(AUTH_JWKS_URI),
    email_claim: AUTH_EMAIL_CLAIM,
    allowed_email_count: ALLOWED_EMAILS.size,
    scopes_supported: OAUTH_SCOPES
  };
}

function validateAuthConfiguration() {
  if (!AUTH_ENABLED) return;
  const missing = [
    ['AUTH_ISSUER', AUTH_ISSUER],
    ['AUTH_AUDIENCE', AUTH_AUDIENCE],
    ['AUTH_JWKS_URI', AUTH_JWKS_URI]
  ].filter(([,value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`OAuth is enabled but missing: ${missing.join(', ')}`);
  if (ALLOWED_EMAILS.size === 0) throw new Error('OAuth is enabled but ALLOWED_EMAILS is empty');
}

function scopesFromPayload(payload) {
  const scopes = new Set(String(payload.scope ?? '').split(/\s+/).filter(Boolean));
  for (const permission of Array.isArray(payload.permissions) ? payload.permissions : []) scopes.add(permission);
  return scopes;
}

async function verifyAccessToken(token) {
  if (!remoteJwks) remoteJwks = createRemoteJWKSet(new URL(AUTH_JWKS_URI));
  const { payload } = await jwtVerify(token, remoteJwks, {
    issuer: AUTH_ISSUER,
    audience: AUTH_AUDIENCE
  });
  const email = String(payload[AUTH_EMAIL_CLAIM] ?? payload.email ?? payload.upn ?? '').trim().toLowerCase();
  if (!email || !ALLOWED_EMAILS.has(email)) {
    const error = new Error('This account is not authorized for Oneforall Social Manager');
    error.code = 'account_not_allowed';
    throw error;
  }
  return { subject: payload.sub, email, scopes: scopesFromPayload(payload), claims: payload };
}

async function authenticateRequest(req, res, next) {
  if (!AUTH_ENABLED) {
    req.auth = { subject: 'legacy-anonymous', email: null, scopes: new Set(OAUTH_SCOPES), legacy: true };
    return next();
  }
  const match = req.get('authorization')?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    console.warn('OAuth authentication failed', { path: req.path, code: 'missing_bearer', message: 'Authorization Bearer token not provided' });
    return unauthorized(res, [], 'invalid_token', 'A valid OAuth access token is required');
  }
  try {
    req.auth = await verifyAccessToken(match[1]);
    return next();
  } catch (error) {
    console.warn('OAuth authentication failed', {
      path: req.path,
      code: error.code ?? error.name ?? 'invalid_token',
      message: error.message
    });
    const description = error.code === 'account_not_allowed'
      ? error.message
      : 'The OAuth access token is invalid or expired';
    return unauthorized(res, [], error.code ?? 'invalid_token', description);
  }
}

function requireScopes(requiredScopes) {
  return (req, res, next) => {
    if (requiredScopes.every(scope => req.auth?.scopes?.has(scope))) return next();
    return unauthorized(res, requiredScopes, 'insufficient_scope', `Required scopes: ${requiredScopes.join(' ')}`);
  };
}

function assertToolScopes(principal, requiredScopes) {
  if (requiredScopes.every(scope => principal?.scopes?.has(scope))) return;
  const error = new Error(`Required scopes: ${requiredScopes.join(' ')}`);
  error.code = 'insufficient_scope';
  error.challenge = authChallenge(requiredScopes, error.code, error.message);
  throw error;
}

app.get('/.well-known/oauth-protected-resource', (_req,res) => {
  if (!AUTH_ENABLED) return res.status(404).json({error:'oauth_not_enabled'});
  res.json({
    resource: MCP_RESOURCE_URL,
    authorization_servers: [AUTH_ISSUER],
    scopes_supported: OAUTH_SCOPES
  });
});

async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

async function ensureDiscoverySchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS discovery_sets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
      version integer NOT NULL CHECK (version > 0),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','selected','published','evaluated','retired')),
      language text NOT NULL DEFAULT 'en',
      layers jsonb NOT NULL,
      terms jsonb NOT NULL,
      rationale text,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      hypothesis text,
      researched_at timestamptz NOT NULL,
      selected_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (content_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_discovery_sets_content
      ON discovery_sets (content_id, status, version DESC);
    CREATE TABLE IF NOT EXISTS discovery_metrics (
      id bigserial PRIMARY KEY,
      discovery_set_id uuid NOT NULL REFERENCES discovery_sets(id) ON DELETE CASCADE,
      content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
      source text NOT NULL,
      source_record_id text NOT NULL,
      measured_at timestamptz NOT NULL,
      window_hours integer NOT NULL CHECK (window_hours > 0),
      metrics jsonb NOT NULL,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (discovery_set_id, source, source_record_id, window_hours, measured_at)
    );
    CREATE INDEX IF NOT EXISTS idx_discovery_metrics_set
      ON discovery_metrics (discovery_set_id, measured_at DESC);
  `);
}

async function upsertPlan(input) {
  const rows = await query(`
    INSERT INTO social_plans
      (client_slug,campaign,platform,posts_per_week,buffer_min,buffer_target,format_mix,pillar_mix,preferred_slots,active,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,now())
    ON CONFLICT (client_slug,campaign,platform) DO UPDATE SET
      posts_per_week=EXCLUDED.posts_per_week,
      buffer_min=EXCLUDED.buffer_min,
      buffer_target=EXCLUDED.buffer_target,
      format_mix=EXCLUDED.format_mix,
      pillar_mix=EXCLUDED.pillar_mix,
      preferred_slots=EXCLUDED.preferred_slots,
      active=EXCLUDED.active,
      updated_at=now()
    RETURNING *
  `, [input.client_slug,input.campaign,input.platform,input.posts_per_week,input.buffer_min,input.buffer_target,
      JSON.stringify(input.format_mix ?? {}),JSON.stringify(input.pillar_mix ?? {}),JSON.stringify(input.preferred_slots ?? []),input.active ?? true]);
  return rows[0];
}

async function createContent(input) {
  const rows = await query(`
    INSERT INTO content_items
      (client_slug,campaign,platform,format,pillar,title,idea,hook,objective,cta,status,priority,
       scheduled_at,published_at,publisher_post_id,published_url,asset_ids,caption,source_idea_id,director_project_id,
       approval_receipt,metadata,google_calendar_id,google_calendar_event_id,calendar_sync_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21::jsonb,$22::jsonb,$23,$24,$25)
    RETURNING *
  `, [input.client_slug,input.campaign ?? 'default',input.platform ?? 'instagram',input.format,input.pillar ?? null,
      input.title,input.idea ?? null,input.hook ?? null,input.objective ?? null,input.cta ?? null,input.status ?? 'idea',
      input.priority ?? 50,input.scheduled_at ?? null,input.published_at ?? null,input.publisher_post_id ?? null,
      input.published_url ?? null,JSON.stringify(input.asset_ids ?? []),input.caption ?? null,input.source_idea_id ?? null,
      input.director_project_id ?? null,JSON.stringify(input.approval_receipt ?? null),JSON.stringify(input.metadata ?? {}),
      input.google_calendar_id ?? null,input.google_calendar_event_id ?? null,input.calendar_sync_status ?? null]);
  await query(`INSERT INTO content_events(content_id,event_type,to_status,actor,payload) VALUES($1,'created',$2,$3,$4::jsonb)`,
    [rows[0].id, rows[0].status, input.actor ?? 'social-manager', JSON.stringify({source:'create_content'})]);
  return rows[0];
}

async function transitionContent(id, toStatus, actor='social-manager', patch={}) {
  if (!STATUSES.includes(toStatus)) throw new Error('Invalid status');
  const current = (await query('SELECT * FROM content_items WHERE id=$1',[id]))[0];
  if (!current) throw new Error('Content item not found');
  const rows = await query(`
    UPDATE content_items SET
      status=$2,
      scheduled_at=COALESCE($3,scheduled_at),
      published_at=COALESCE($4,published_at),
      publisher_post_id=COALESCE($5,publisher_post_id),
      published_url=COALESCE($6,published_url),
      asset_ids=COALESCE($7::jsonb,asset_ids),
      caption=COALESCE($8,caption),
      approval_receipt=COALESCE($9::jsonb,approval_receipt),
      google_calendar_id=COALESCE($10,google_calendar_id),
      google_calendar_event_id=COALESCE($11,google_calendar_event_id),
      calendar_sync_status=COALESCE($12,calendar_sync_status),
      metadata=COALESCE(metadata,'{}'::jsonb) || COALESCE($13::jsonb,'{}'::jsonb),
      updated_at=now()
    WHERE id=$1 RETURNING *
  `,[id,toStatus,patch.scheduled_at ?? null,patch.published_at ?? null,patch.publisher_post_id ?? null,patch.published_url ?? null,
      patch.asset_ids ? JSON.stringify(patch.asset_ids) : null,patch.caption ?? null,
      patch.approval_receipt ? JSON.stringify(patch.approval_receipt) : null,
      patch.google_calendar_id ?? null,patch.google_calendar_event_id ?? null,patch.calendar_sync_status ?? null,
      patch.metadata ? JSON.stringify(patch.metadata) : null]);
  await query(`INSERT INTO content_events(content_id,event_type,from_status,to_status,actor,payload) VALUES($1,'transition',$2,$3,$4,$5::jsonb)`,
    [id,current.status,toStatus,actor,JSON.stringify(patch)]);
  return rows[0];
}

async function dashboard(clientSlug,campaign='default',platform='instagram') {
  const plan = (await query('SELECT * FROM social_plans WHERE client_slug=$1 AND campaign=$2 AND platform=$3',[clientSlug,campaign,platform]))[0] ?? null;
  const counts = Object.fromEntries(STATUSES.map(s => [s,0]));
  for (const row of await query('SELECT status,count(*)::int AS count FROM content_items WHERE client_slug=$1 AND campaign=$2 AND platform=$3 GROUP BY status',[clientSlug,campaign,platform])) counts[row.status]=row.count;
  const future = (await query(`SELECT count(*)::int AS count FROM content_items WHERE client_slug=$1 AND campaign=$2 AND platform=$3 AND status IN ('approved','scheduled') AND (scheduled_at IS NULL OR scheduled_at>now())`,[clientSlug,campaign,platform]))[0]?.count ?? 0;
  const published7d = (await query(`SELECT count(*)::int AS count FROM content_items WHERE client_slug=$1 AND campaign=$2 AND platform=$3 AND status='published' AND published_at>=now()-interval '7 days'`,[clientSlug,campaign,platform]))[0]?.count ?? 0;
  const calendar = await getClientCalendar(clientSlug);
  return {
    client_slug:clientSlug,campaign,platform,plan,calendar,counts,future_inventory:future,
    published_last_7_days:published7d,
    replenish:!!plan && future < plan.buffer_min,
    replenish_count:!!plan ? Math.max(plan.buffer_target - future,0) : null
  };
}

async function saveDiscoverySet(input) {
  const content = (await query('SELECT id,client_slug,campaign,platform,status FROM content_items WHERE id=$1',[input.content_id]))[0];
  if (!content) throw new Error('Content item not found');
  const version = input.version ?? ((await query('SELECT COALESCE(MAX(version),0)::int + 1 AS version FROM discovery_sets WHERE content_id=$1',[input.content_id]))[0].version);
  const rows = await query(`
    INSERT INTO discovery_sets
      (content_id,version,status,language,layers,terms,rationale,evidence,hypothesis,researched_at,selected_at,updated_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$10,
      CASE WHEN $3='selected' THEN now() ELSE NULL END,now())
    ON CONFLICT (content_id,version) DO UPDATE SET
      status=EXCLUDED.status,language=EXCLUDED.language,layers=EXCLUDED.layers,terms=EXCLUDED.terms,
      rationale=EXCLUDED.rationale,evidence=EXCLUDED.evidence,hypothesis=EXCLUDED.hypothesis,
      researched_at=EXCLUDED.researched_at,selected_at=CASE WHEN EXCLUDED.status='selected' THEN now() ELSE discovery_sets.selected_at END,
      updated_at=now()
    RETURNING *
  `,[input.content_id,version,input.status ?? 'draft',input.language ?? 'en',JSON.stringify(input.layers),JSON.stringify(input.terms),
      input.rationale ?? null,JSON.stringify(input.evidence),input.hypothesis ?? null,input.researched_at]);
  return rows[0];
}

async function listDiscoverySets(input={}) {
  const where=[]; const args=[];
  for (const key of ['content_id','client_slug','campaign','platform','status']) {
    if (!input[key]) continue;
    if (key === 'content_id' || key === 'status') { args.push(input[key]); where.push(`ds.${key}=$${args.length}`); }
    else { args.push(input[key]); where.push(`ci.${key}=$${args.length}`); }
  }
  const limit = Math.min(Math.max(Number(input.limit ?? 100),1),500);
  args.push(limit);
  return query(`
    SELECT ds.*,ci.client_slug,ci.campaign,ci.platform,ci.title,ci.publisher_post_id,ci.published_url
    FROM discovery_sets ds JOIN content_items ci ON ci.id=ds.content_id
    ${where.length ? 'WHERE '+where.join(' AND ') : ''}
    ORDER BY ds.researched_at DESC, ds.version DESC LIMIT $${args.length}
  `,args);
}

async function recordDiscoveryMetrics(input) {
  const source = String(input.source ?? '').trim();
  if (/dummy|mock|sample|placeholder|test/i.test(source)) throw new Error('DATA_INTEGRITY_FAILURE: test/dummy metric source is not allowed');
  const setRow = (await query(`
    SELECT ds.*,ci.status AS content_status,ci.id AS bound_content_id
    FROM discovery_sets ds JOIN content_items ci ON ci.id=ds.content_id WHERE ds.id=$1
  `,[input.discovery_set_id]))[0];
  if (!setRow) throw new Error('Discovery set not found');
  if (setRow.content_status !== 'published') throw new Error('Metrics may only be recorded for content confirmed as published');
  const rows = await query(`
    INSERT INTO discovery_metrics
      (discovery_set_id,content_id,source,source_record_id,measured_at,window_hours,metrics,notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
    ON CONFLICT (discovery_set_id,source,source_record_id,window_hours,measured_at) DO UPDATE SET
      metrics=EXCLUDED.metrics,notes=EXCLUDED.notes
    RETURNING *
  `,[input.discovery_set_id,setRow.bound_content_id,source,input.source_record_id,input.measured_at,input.window_hours,
      JSON.stringify(input.metrics),input.notes ?? null]);
  return rows[0];
}

async function discoveryLearning(input) {
  const where=['ci.client_slug=$1']; const args=[input.client_slug];
  for (const [key,value] of [['campaign',input.campaign],['platform',input.platform]]) if(value){args.push(value);where.push(`ci.${key}=$${args.length}`)}
  if (input.window_hours) { args.push(input.window_hours); where.push(`dm.window_hours=$${args.length}`); }
  const limit=Math.min(Math.max(Number(input.limit ?? 100),1),500); args.push(limit);
  const observations=await query(`
    SELECT ds.id AS discovery_set_id,ds.version,ds.terms,ds.layers,ds.hypothesis,ds.researched_at,
           ci.id AS content_id,ci.title,ci.format,ci.published_at,ci.publisher_post_id,ci.published_url,
           dm.source,dm.source_record_id,dm.measured_at,dm.window_hours,dm.metrics
    FROM discovery_metrics dm
    JOIN discovery_sets ds ON ds.id=dm.discovery_set_id
    JOIN content_items ci ON ci.id=dm.content_id
    WHERE ${where.join(' AND ')}
    ORDER BY dm.measured_at DESC LIMIT $${args.length}
  `,args);
  return {client_slug:input.client_slug,campaign:input.campaign ?? null,platform:input.platform ?? null,observations,integrity_status:observations.length?'VERIFIED':'PENDING_METRICS'};
}

const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET=process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN=process.env.GOOGLE_REFRESH_TOKEN;

async function getClientCalendar(clientSlug) {
  return (await query('SELECT * FROM client_calendars WHERE client_slug=$1',[clientSlug]))[0] ?? null;
}

async function storeClientCalendar(input) {
  const rows=await query(`
    INSERT INTO client_calendars(client_slug,google_calendar_id,calendar_name,timezone,source,updated_at)
    VALUES($1,$2,$3,$4,$5,now())
    ON CONFLICT(client_slug) DO UPDATE SET google_calendar_id=EXCLUDED.google_calendar_id,calendar_name=EXCLUDED.calendar_name,
      timezone=EXCLUDED.timezone,source=EXCLUDED.source,updated_at=now()
    RETURNING *
  `,[input.client_slug,input.google_calendar_id,input.calendar_name,input.timezone ?? 'America/Bogota',input.source ?? 'google-calendar']);
  return rows[0];
}

async function linkCalendarEvent(contentId,input) {
  const rows=await query(`UPDATE content_items SET google_calendar_id=$2,google_calendar_event_id=$3,calendar_sync_status=$4,updated_at=now() WHERE id=$1 RETURNING *`,
    [contentId,input.google_calendar_id,input.google_calendar_event_id,input.calendar_sync_status ?? 'linked']);
  if(!rows[0]) throw new Error('Content item not found');
  await query(`INSERT INTO content_events(content_id,event_type,actor,payload) VALUES($1,'calendar_linked',$2,$3::jsonb)`,
    [contentId,input.actor ?? 'social-manager',JSON.stringify({google_calendar_id:input.google_calendar_id,google_calendar_event_id:input.google_calendar_event_id,calendar_sync_status:input.calendar_sync_status ?? 'linked'})]);
  return rows[0];
}

async function googleAccessToken() {
  if(!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    const error=new Error('Google OAuth credentials are not configured for calendar provisioning'); error.code='GOOGLE_OAUTH_NOT_CONFIGURED'; throw error;
  }
  const response=await fetch('https://oauth2.googleapis.com/token',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:GOOGLE_CLIENT_ID,client_secret:GOOGLE_CLIENT_SECRET,refresh_token:GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'})
  });
  const data=await response.json();
  if(!response.ok || !data.access_token) throw new Error(`Google OAuth refresh failed: ${data.error_description ?? data.error ?? response.status}`);
  return data.access_token;
}

async function ensureClientCalendar(input) {
  const existing=await getClientCalendar(input.client_slug);
  if(existing && !input.force_new) return {created:false,calendar:existing};
  const token=await googleAccessToken();
  const calendarName=input.calendar_name ?? `Social — ${input.client_slug}`;
  const timezone=input.timezone ?? 'America/Bogota';
  const response=await fetch('https://www.googleapis.com/calendar/v3/calendars',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({summary:calendarName,description:input.description ?? `Oneforall Social Manager calendar for ${input.client_slug}`,timeZone:timezone})});
  const data=await response.json();
  if(!response.ok || !data.id) throw new Error(`Google Calendar creation failed: ${data.error?.message ?? response.status}`);
  const calendar=await storeClientCalendar({client_slug:input.client_slug,google_calendar_id:data.id,calendar_name:data.summary ?? calendarName,timezone:data.timeZone ?? timezone,source:'oneforall-google-api'});
  return {created:true,calendar};
}

app.get('/health', async (_req,res) => {
  try {
    await query('SELECT 1');
    res.json({
      ok:true,
      service:'oneforall-social-manager',
      version:VERSION,
      authentication:AUTH_ENABLED?'oauth2':'legacy-anonymous',
      oauth:authDiagnostics()
    });
  } catch (e) { res.status(503).json({ok:false,error:e.message,oauth:authDiagnostics()}); }
});

app.use('/api', authenticateRequest, (req,res,next) =>
  requireScopes(req.method === 'GET' ? ['social.read'] : ['social.write'])(req,res,next)
);

app.get('/api/dashboard/:client', async (req,res) => {
  try { res.json(await dashboard(req.params.client, req.query.campaign ?? 'default', req.query.platform ?? 'instagram')); }
  catch (e) { res.status(500).json({error:e.message}); }
});

app.post('/api/plans', async (req,res) => {
  try { res.json(await upsertPlan(req.body)); }
  catch (e) { res.status(400).json({error:e.message}); }
});

app.post('/api/content', async (req,res) => {
  try { res.status(201).json(await createContent(req.body)); }
  catch (e) { res.status(400).json({error:e.message}); }
});

app.patch('/api/content/:id/status', async (req,res) => {
  try { res.json(await transitionContent(req.params.id,req.body.status,req.body.actor,req.body.patch)); }
  catch (e) { res.status(400).json({error:e.message}); }
});

app.patch('/api/content/:id/calendar-link', async (req,res) => {
  try { res.json(await linkCalendarEvent(req.params.id,req.body)); }
  catch (e) { res.status(400).json({error:e.message}); }
});

app.get('/api/content', async (req,res) => {
  try {
    const where=[]; const args=[];
    for (const key of ['client_slug','campaign','platform','status']) {
      if (req.query[key]) { args.push(req.query[key]); where.push(`${key}=$${args.length}`); }
    }
    const rows=await query(`SELECT * FROM content_items${where.length?' WHERE '+where.join(' AND '):''} ORDER BY COALESCE(scheduled_at,created_at) ASC LIMIT 500`,args);
    res.json(rows);
  } catch (e) { res.status(500).json({error:e.message}); }
});

app.get('/api/calendars/:client', async (req,res) => {
  try { res.json({calendar:await getClientCalendar(req.params.client)}); }
  catch (e) { res.status(500).json({error:e.message}); }
});

app.post('/api/calendars/register', async (req,res) => {
  try { res.json(await storeClientCalendar(req.body)); }
  catch (e) { res.status(400).json({error:e.message}); }
});

app.post('/api/calendars/ensure', async (req,res) => {
  try { res.json(await ensureClientCalendar(req.body)); }
  catch (e) { res.status(e.code === 'GOOGLE_OAUTH_NOT_CONFIGURED' ? 503 : 400).json({error:e.message,code:e.code ?? null}); }
});

app.post('/api/discovery/sets', async (req,res) => {
  try { res.status(201).json(await saveDiscoverySet(req.body)); }
  catch (e) { res.status(400).json({error:e.message}); }
});

app.get('/api/discovery/sets', async (req,res) => {
  try { res.json(await listDiscoverySets(req.query)); }
  catch (e) { res.status(400).json({error:e.message}); }
});

app.post('/api/discovery/metrics', async (req,res) => {
  try { res.status(201).json(await recordDiscoveryMetrics(req.body)); }
  catch (e) { res.status(400).json({error:e.message}); }
});

app.get('/api/discovery/learning/:client', async (req,res) => {
  try { res.json(await discoveryLearning({client_slug:req.params.client,...req.query})); }
  catch (e) { res.status(400).json({error:e.message}); }
});

function toolResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }

function buildMcpServer(principal) {
  const server = new McpServer({ name: 'oneforall-social-manager', version: VERSION });
  const tool = (name, description, inputSchema, requiredScopes, handler) =>
    server.registerTool(name, {
      description,
      inputSchema,
      securitySchemes: [{type:'oauth2',scopes:requiredScopes}]
    }, async input => {
      try {
        assertToolScopes(principal, requiredScopes);
        return await handler(input);
      } catch (error) {
        if (!error.challenge) throw error;
        return {
          content:[{type:'text',text:`Authentication required: ${error.message}`}],
          _meta:{'mcp/www_authenticate':[error.challenge]},
          isError:true
        };
      }
    });
  tool('get_social_dashboard','Get pipeline counts, plan, future inventory, client calendar mapping and replenishment requirement',{
    client_slug:z.string(), campaign:z.string().default('default'), platform:z.string().default('instagram')
  },['social.read'],async ({client_slug,campaign,platform}) => toolResult(await dashboard(client_slug,campaign,platform)));

  tool('set_social_plan','Create or update weekly publication plan and buffer thresholds',{
    client_slug:z.string(), campaign:z.string().default('default'), platform:z.string().default('instagram'),
    posts_per_week:z.number().int().positive(), buffer_min:z.number().int().nonnegative(), buffer_target:z.number().int().nonnegative(),
    format_mix:z.record(z.any()).optional(), pillar_mix:z.record(z.any()).optional(), preferred_slots:z.array(z.any()).optional(), active:z.boolean().optional()
  },['social.write'],async input => toolResult(await upsertPlan(input)));

  tool('create_content_item','Register an idea or production item in the persistent editorial pipeline',{
    client_slug:z.string(),campaign:z.string().default('default'),platform:z.string().default('instagram'),
    format:z.enum(['image','carousel','reel','story','other']),title:z.string(),pillar:z.string().optional(),idea:z.string().optional(),hook:z.string().optional(),objective:z.string().optional(),cta:z.string().optional(),status:z.enum(STATUSES).optional(),priority:z.number().int().min(0).max(100).optional(),caption:z.string().optional(),asset_ids:z.array(z.string()).optional(),director_project_id:z.string().optional(),google_calendar_id:z.string().optional(),google_calendar_event_id:z.string().optional(),calendar_sync_status:z.string().optional(),metadata:z.record(z.any()).optional()
  },['social.write'],async input => toolResult(await createContent(input)));

  tool('transition_content_item','Change a content item state and record an immutable event',{
    content_id:z.string().uuid(),status:z.enum(STATUSES),actor:z.string().optional(),scheduled_at:z.string().optional(),published_at:z.string().optional(),publisher_post_id:z.string().optional(),published_url:z.string().optional(),asset_ids:z.array(z.string()).optional(),caption:z.string().optional(),approval_receipt:z.record(z.any()).optional(),google_calendar_id:z.string().optional(),google_calendar_event_id:z.string().optional(),calendar_sync_status:z.string().optional(),metadata:z.record(z.any()).optional()
  },['social.write'],async ({content_id,status,actor,...patch}) => toolResult(await transitionContent(content_id,status,actor,patch)));

  tool('list_content_items','List persistent content items by client and optional pipeline filters',{
    client_slug:z.string(),campaign:z.string().optional(),platform:z.string().optional(),status:z.enum(STATUSES).optional(),limit:z.number().int().min(1).max(500).default(100)
  },['social.read'],async ({client_slug,campaign,platform,status,limit}) => {
    const where=['client_slug=$1']; const args=[client_slug];
    for (const [key,value] of [['campaign',campaign],['platform',platform],['status',status]]) if(value){args.push(value);where.push(`${key}=$${args.length}`)}
    args.push(limit);
    return toolResult(await query(`SELECT * FROM content_items WHERE ${where.join(' AND ')} ORDER BY COALESCE(scheduled_at,created_at) ASC LIMIT $${args.length}`,args));
  });

  tool('get_client_calendar','Get the Google Calendar mapped to a Social Manager client',{
    client_slug:z.string()
  },['social.read'],async ({client_slug}) => toolResult({calendar:await getClientCalendar(client_slug)}));

  tool('register_client_calendar','Store a Google Calendar ID already created or selected through the connected Google Calendar capability',{
    client_slug:z.string(),google_calendar_id:z.string(),calendar_name:z.string(),timezone:z.string().default('America/Bogota'),source:z.string().default('google-calendar')
  },['social.write'],async input => toolResult(await storeClientCalendar(input)));

  tool('ensure_client_calendar','Create and persist one Google Calendar for a client when no mapping exists. Requires Google OAuth environment credentials on the backend.',{
    client_slug:z.string(),calendar_name:z.string().optional(),timezone:z.string().default('America/Bogota'),description:z.string().optional(),force_new:z.boolean().default(false)
  },['social.admin'],async input => toolResult(await ensureClientCalendar(input)));

  tool('link_calendar_event','Link a Google Calendar event to one persistent content item',{
    content_id:z.string().uuid(),google_calendar_id:z.string(),google_calendar_event_id:z.string(),calendar_sync_status:z.string().default('linked'),actor:z.string().default('social-manager')
  },['social.write'],async ({content_id,...input}) => toolResult(await linkCalendarEvent(content_id,input)));

  tool('save_discovery_set','Persist a researched, versioned discovery/hashtag set bound to one content item',{
    content_id:z.string().uuid(),version:z.number().int().positive().optional(),status:z.enum(['draft','selected','published','evaluated','retired']).default('draft'),
    language:z.string().default('en'),layers:z.object({
      world_lore:z.array(z.string()).min(1),artist_entity:z.array(z.string()).min(1),genre_niche:z.array(z.string()).min(1),post_context:z.array(z.string()).min(1)
    }),terms:z.array(z.string()).min(1),rationale:z.string().optional(),evidence:z.array(z.record(z.any())).min(1),
    hypothesis:z.string().optional(),researched_at:z.string(),actor:z.string().default('social-manager')
  },['social.write'],async input => toolResult(await saveDiscoverySet(input)));

  tool('list_discovery_sets','List persisted discovery sets with exact item and publication bindings',{
    content_id:z.string().uuid().optional(),client_slug:z.string().optional(),campaign:z.string().optional(),platform:z.string().optional(),
    status:z.enum(['draft','selected','published','evaluated','retired']).optional(),limit:z.number().int().min(1).max(500).default(100)
  },['social.read'],async input => toolResult(await listDiscoverySets(input)));

  tool('record_discovery_metrics','Record verified post-publish metrics for the exact discovery set used; rejects dummy/test sources',{
    discovery_set_id:z.string().uuid(),source:z.string(),source_record_id:z.string(),measured_at:z.string(),window_hours:z.number().int().positive(),
    metrics:z.record(z.number().nonnegative()),notes:z.string().optional()
  },['social.write'],async input => toolResult(await recordDiscoveryMetrics(input)));

  tool('get_discovery_learning','Retrieve verified observations for discovery rotation without fabricating causality',{
    client_slug:z.string(),campaign:z.string().optional(),platform:z.string().optional(),window_hours:z.number().int().positive().optional(),
    limit:z.number().int().min(1).max(500).default(100)
  },['social.read'],async input => toolResult(await discoveryLearning(input)));

  return server;
}

app.post('/mcp', authenticateRequest, async (req,res) => {
  const server = buildMcpServer(req.auth);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req,res,req.body);
});

const port = Number(process.env.PORT ?? 3000);
validateAuthConfiguration();
ensureDiscoverySchema()
  .then(() => app.listen(port, () => console.log(`Oneforall Social Manager ${VERSION} listening on ${port}`)))
  .catch(error => { console.error('Database schema initialization failed', error); process.exit(1); });
