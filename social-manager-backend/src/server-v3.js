import express from 'express';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash, randomUUID } from 'node:crypto';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const VERSION = '0.10.1';
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
const SUPPLY_SCHEDULER_ENABLED = !/^(0|false|no)$/i.test(process.env.SUPPLY_SCHEDULER_ENABLED ?? 'true');
const SUPPLY_SCHEDULER_INTERVAL_MS = Math.max(Number(process.env.SUPPLY_SCHEDULER_INTERVAL_MS ?? 60000),15000);
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

async function ensureAutomationSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS client_profiles (
      client_slug text PRIMARY KEY,
      client_name text NOT NULL,
      summary text,
      business jsonb NOT NULL DEFAULT '{}'::jsonb,
      audience jsonb NOT NULL DEFAULT '{}'::jsonb,
      offers jsonb NOT NULL DEFAULT '[]'::jsonb,
      goals jsonb NOT NULL DEFAULT '[]'::jsonb,
      brand jsonb NOT NULL DEFAULT '{}'::jsonb,
      visual_style jsonb NOT NULL DEFAULT '{}'::jsonb,
      copy_style jsonb NOT NULL DEFAULT '{}'::jsonb,
      constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      profile_hash text NOT NULL,
      updated_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE content_items
      ADD COLUMN IF NOT EXISTS item_id text,
      ADD COLUMN IF NOT EXISTS root_item_id text,
      ADD COLUMN IF NOT EXISTS parent_item_id text,
      ADD COLUMN IF NOT EXISTS variant_key text,
      ADD COLUMN IF NOT EXISTS source_content_version integer,
      ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS client_profile_revision integer,
      ADD COLUMN IF NOT EXISTS council_id uuid,
      ADD COLUMN IF NOT EXISTS stage_owner text,
      ADD COLUMN IF NOT EXISTS next_action text,
      ADD COLUMN IF NOT EXISTS publisher_kind text;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_client_item_id
      ON content_items (client_slug, item_id) WHERE item_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_content_client_root_item
      ON content_items (client_slug, root_item_id, variant_key);
    CREATE TABLE IF NOT EXISTS research_receipts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug text NOT NULL,
      content_id uuid REFERENCES content_items(id) ON DELETE SET NULL,
      item_id text,
      mode text NOT NULL CHECK (mode IN ('news','watch','research')),
      source_tool text NOT NULL,
      query text,
      sources jsonb NOT NULL DEFAULT '[]'::jsonb,
      findings jsonb NOT NULL DEFAULT '[]'::jsonb,
      deduplication jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL CHECK (status IN ('VERIFIED','PARTIAL','NOT_VERIFIED')),
      researched_at timestamptz NOT NULL,
      receipt_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS creative_councils (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug text NOT NULL,
      content_id uuid REFERENCES content_items(id) ON DELETE SET NULL,
      item_id text NOT NULL,
      content_version integer NOT NULL CHECK (content_version > 0),
      client_profile_revision integer NOT NULL CHECK (client_profile_revision > 0),
      research_receipt_id uuid REFERENCES research_receipts(id) ON DELETE SET NULL,
      concept_package jsonb NOT NULL,
      agency_verdict text,
      agency_receipt jsonb,
      director_verdict text,
      director_receipt jsonb,
      auditor_verdict text,
      auditor_receipt jsonb,
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CORRECTIONS','CONCEPT_LOCKED','BLOCKED')),
      package_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (client_slug, item_id, content_version)
    );
    CREATE TABLE IF NOT EXISTS audit_results (
      audit_id text PRIMARY KEY,
      client_slug text NOT NULL,
      client_id uuid,
      item_id text NOT NULL,
      content_version integer NOT NULL CHECK (content_version > 0),
      content_hash text NOT NULL,
      platform text NOT NULL,
      audit_stage text NOT NULL,
      auditor_identity text NOT NULL,
      verdict text NOT NULL CHECK (verdict IN ('PASS','CORRECTIONS','BLOCKED')),
      findings jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      council_id uuid REFERENCES creative_councils(id) ON DELETE SET NULL,
      client_profile_revision integer,
      receipt jsonb,
      signature_digest text,
      audited_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS release_factor_approvals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_slug text NOT NULL,item_id text NOT NULL,
      content_version integer NOT NULL CHECK(content_version>0),content_hash text NOT NULL,destination_id text NOT NULL,
      factor text NOT NULL CHECK(factor IN ('agency','director','auditor')),
      verdict text NOT NULL CHECK(verdict IN ('PASS','CORRECTIONS','BLOCKED')),client_profile_revision integer,
      evidence jsonb NOT NULL,actor_receipt jsonb NOT NULL,approved_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(client_slug,item_id,content_version,content_hash,destination_id,factor)
    );
    CREATE TABLE IF NOT EXISTS automatic_orchestration_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug text NOT NULL,
      content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
      item_id text NOT NULL,
      content_version integer NOT NULL CHECK(content_version > 0),
      council_id uuid REFERENCES creative_councils(id) ON DELETE SET NULL,
      phase text NOT NULL DEFAULT 'CONCEPT_COUNCIL' CHECK(phase IN (
        'CONCEPT_COUNCIL','CONCEPT_REVISION','PRODUCTION','FINAL_REVIEW','FINAL_CORRECTION','OWNER_DECISION','COMPLETE'
      )),
      status text NOT NULL DEFAULT 'RUNNING' CHECK(status IN (
        'RUNNING','WAITING_ACTOR','CORRECTIONS','BLOCKED','USER_APPROVAL_REQUIRED','COMPLETE'
      )),
      correction_round integer NOT NULL DEFAULT 0 CHECK(correction_round >= 0),
      max_correction_rounds integer NOT NULL DEFAULT 3 CHECK(max_correction_rounds > 0),
      content_hash text,
      destination_id text,
      final_package jsonb,
      exact_blocker jsonb,
      owner_override_allowed boolean NOT NULL DEFAULT true,
      last_transition jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(client_slug,item_id,content_version)
    );
    CREATE TABLE IF NOT EXISTS automatic_actor_actions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id uuid NOT NULL REFERENCES automatic_orchestration_runs(id) ON DELETE CASCADE,
      phase text NOT NULL,
      actor text NOT NULL CHECK(actor IN ('agency','director','auditor','social-manager','owner')),
      action_type text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CLAIMED','COMPLETED','BLOCKED','CANCELLED')),
      attempt integer NOT NULL DEFAULT 1 CHECK(attempt > 0),
      package_hash text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      result jsonb,
      claimed_by text,
      claimed_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(run_id,phase,actor,action_type,attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_automatic_actions_pending
      ON automatic_actor_actions(status,actor,created_at);
  `);
}

async function ensureSupplySchema() {
  await query(`
    ALTER TABLE content_items
      ADD COLUMN IF NOT EXISTS scheduled_recorded_at timestamptz;
    CREATE TABLE IF NOT EXISTS content_supply_policies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug text NOT NULL,
      campaign text NOT NULL DEFAULT 'default',
      platform text NOT NULL DEFAULT 'instagram',
      automation_enabled boolean NOT NULL DEFAULT false,
      manual_enabled boolean NOT NULL DEFAULT true,
      timezone text NOT NULL DEFAULT 'America/Bogota',
      daily_trigger_time time NOT NULL DEFAULT '09:00',
      lead_days integer NOT NULL DEFAULT 3 CHECK(lead_days >= 0),
      minimum_ready_items integer NOT NULL DEFAULT 6 CHECK(minimum_ready_items >= 0),
      target_ready_items integer NOT NULL DEFAULT 10 CHECK(target_ready_items >= minimum_ready_items),
      minimum_scheduled_items integer NOT NULL DEFAULT 3 CHECK(minimum_scheduled_items >= 0),
      publication_order jsonb NOT NULL DEFAULT '[]'::jsonb,
      production_instructions jsonb NOT NULL DEFAULT '{}'::jsonb,
      research_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
      owner_approval_required boolean NOT NULL DEFAULT true,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(client_slug,campaign,platform)
    );
    CREATE TABLE IF NOT EXISTS content_supply_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      policy_id uuid NOT NULL REFERENCES content_supply_policies(id) ON DELETE CASCADE,
      client_slug text NOT NULL,
      campaign text NOT NULL,
      platform text NOT NULL,
      trigger_source text NOT NULL CHECK(trigger_source IN ('daily','manual')),
      idempotency_key text,
      local_date date NOT NULL,
      status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','NO_ACTION','ORDERS_PENDING','COMPLETE','BLOCKED')),
      inventory_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      decision jsonb NOT NULL DEFAULT '{}'::jsonb,
      shown_at timestamptz,
      requested_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_supply_daily_once
      ON content_supply_runs(policy_id,local_date) WHERE trigger_source='daily';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_supply_manual_idempotency
      ON content_supply_runs(policy_id,idempotency_key)
      WHERE trigger_source='manual' AND idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS content_supply_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id uuid NOT NULL REFERENCES content_supply_runs(id) ON DELETE CASCADE,
      actor text NOT NULL CHECK(actor IN ('autopilot','director','social-manager')),
      action_type text NOT NULL,
      sequence integer NOT NULL CHECK(sequence > 0),
      depends_on uuid REFERENCES content_supply_orders(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CLAIMED','COMPLETED','BLOCKED','CANCELLED')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      result jsonb,
      claimed_by text,
      claimed_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(run_id,sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_supply_orders_pending
      ON content_supply_orders(actor,status,created_at);
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

async function getClientProfile(clientSlug) {
  return (await query('SELECT * FROM client_profiles WHERE client_slug=$1',[clientSlug]))[0] ?? null;
}

async function upsertClientProfile(input) {
  const payload = {
    client_slug: input.client_slug,
    client_name: input.client_name,
    summary: input.summary ?? null,
    business: input.business ?? {},
    audience: input.audience ?? {},
    offers: input.offers ?? [],
    goals: input.goals ?? [],
    brand: input.brand ?? {},
    visual_style: input.visual_style ?? {},
    copy_style: input.copy_style ?? {},
    constraints: input.constraints ?? [],
    source_refs: input.source_refs ?? []
  };
  const profileHash = sha256(payload);
  const current = await getClientProfile(input.client_slug);
  if (current?.profile_hash === profileHash) return {changed:false,profile:current};
  const rows = await query(`
    INSERT INTO client_profiles
      (client_slug,client_name,summary,business,audience,offers,goals,brand,visual_style,copy_style,constraints,source_refs,revision,profile_hash,updated_by,updated_at)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,1,$13,$14,now())
    ON CONFLICT (client_slug) DO UPDATE SET
      client_name=EXCLUDED.client_name,summary=EXCLUDED.summary,business=EXCLUDED.business,audience=EXCLUDED.audience,
      offers=EXCLUDED.offers,goals=EXCLUDED.goals,brand=EXCLUDED.brand,visual_style=EXCLUDED.visual_style,
      copy_style=EXCLUDED.copy_style,constraints=EXCLUDED.constraints,source_refs=EXCLUDED.source_refs,
      revision=client_profiles.revision+1,profile_hash=EXCLUDED.profile_hash,updated_by=EXCLUDED.updated_by,updated_at=now()
    RETURNING *
  `,[payload.client_slug,payload.client_name,payload.summary,JSON.stringify(payload.business),JSON.stringify(payload.audience),
    JSON.stringify(payload.offers),JSON.stringify(payload.goals),JSON.stringify(payload.brand),JSON.stringify(payload.visual_style),
    JSON.stringify(payload.copy_style),JSON.stringify(payload.constraints),JSON.stringify(payload.source_refs),profileHash,input.updated_by]);
  return {changed:true,profile:rows[0]};
}

async function saveResearchReceipt(input) {
  const payload = {
    client_slug:input.client_slug,content_id:input.content_id ?? null,item_id:input.item_id ?? null,mode:input.mode,
    source_tool:input.source_tool,query:input.query ?? null,sources:input.sources,findings:input.findings,
    deduplication:input.deduplication ?? {},status:input.status,researched_at:input.researched_at
  };
  const rows = await query(`
    INSERT INTO research_receipts
      (client_slug,content_id,item_id,mode,source_tool,query,sources,findings,deduplication,status,researched_at,receipt_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12) RETURNING *
  `,[payload.client_slug,payload.content_id,payload.item_id,payload.mode,payload.source_tool,payload.query,
    JSON.stringify(payload.sources),JSON.stringify(payload.findings),JSON.stringify(payload.deduplication),payload.status,
    payload.researched_at,sha256(payload)]);
  return rows[0];
}

async function openCreativeCouncil(input) {
  const profile = await getClientProfile(input.client_slug);
  if (!profile) throw new Error('CLIENT_PROFILE_REQUIRED: persist the client profile before opening council');
  if (profile.revision !== input.client_profile_revision) throw new Error(`CLIENT_PROFILE_REVISION_MISMATCH: current=${profile.revision}`);
  const packageHash = sha256(input.concept_package);
  const rows = await query(`
    INSERT INTO creative_councils
      (client_slug,content_id,item_id,content_version,client_profile_revision,research_receipt_id,concept_package,package_hash,status,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'OPEN',now())
    ON CONFLICT (client_slug,item_id,content_version) DO UPDATE SET
      content_id=EXCLUDED.content_id,client_profile_revision=EXCLUDED.client_profile_revision,
      research_receipt_id=EXCLUDED.research_receipt_id,concept_package=EXCLUDED.concept_package,
      package_hash=EXCLUDED.package_hash,agency_verdict=NULL,agency_receipt=NULL,director_verdict=NULL,
      director_receipt=NULL,auditor_verdict=NULL,auditor_receipt=NULL,status='OPEN',updated_at=now()
    RETURNING *
  `,[input.client_slug,input.content_id ?? null,input.item_id,input.content_version,input.client_profile_revision,
    input.research_receipt_id ?? null,JSON.stringify(input.concept_package),packageHash]);
  if (input.content_id) await query(`UPDATE content_items SET council_id=$2,client_profile_revision=$3,stage_owner='social-manager',next_action='RUN_CREATIVE_COUNCIL',updated_at=now() WHERE id=$1`,[input.content_id,rows[0].id,input.client_profile_revision]);
  return rows[0];
}

async function getCreativeCouncil(input) {
  if (input.council_id) return (await query('SELECT * FROM creative_councils WHERE id=$1',[input.council_id]))[0] ?? null;
  return (await query('SELECT * FROM creative_councils WHERE client_slug=$1 AND item_id=$2 AND content_version=$3',[input.client_slug,input.item_id,input.content_version]))[0] ?? null;
}

async function recordCouncilVerdict(input) {
  const council = await getCreativeCouncil({council_id:input.council_id});
  if (!council) throw new Error('Creative council not found');
  if (council.package_hash !== input.expected_package_hash) throw new Error('COUNCIL_PACKAGE_MISMATCH');
  if (input.verdict === 'CORRECTIONS' && !Array.isArray(input.receipt?.corrections)) {
    throw new Error('COUNCIL_CORRECTIONS_REQUIRE_EXPLICIT_CORRECTIONS');
  }
  if (input.verdict === 'BLOCKED' && (!input.receipt?.blocker || typeof input.receipt.blocker !== 'object')) {
    throw new Error('COUNCIL_BLOCKED_REQUIRES_EXACT_BLOCKER');
  }
  const verdictColumn = `${input.role}_verdict`;
  const receiptColumn = `${input.role}_receipt`;
  const allowedColumns = new Set(['agency_verdict','agency_receipt','director_verdict','director_receipt','auditor_verdict','auditor_receipt']);
  if (!allowedColumns.has(verdictColumn) || !allowedColumns.has(receiptColumn)) throw new Error('Invalid council role');
  await query(`UPDATE creative_councils SET ${verdictColumn}=$2,${receiptColumn}=$3::jsonb,updated_at=now() WHERE id=$1`,
    [input.council_id,input.verdict,JSON.stringify({...input.receipt,role:input.role,verdict:input.verdict,package_hash:council.package_hash})]);
  const updated = await getCreativeCouncil({council_id:input.council_id});
  let status = 'OPEN';
  const verdicts = [updated.agency_verdict,updated.director_verdict,updated.auditor_verdict];
  if (verdicts.some(v => v === 'BLOCKED')) status = 'BLOCKED';
  else if (verdicts.some(v => v === 'CORRECTIONS')) status = 'CORRECTIONS';
  else if (verdicts.every(v => v === 'PASS')) status = 'CONCEPT_LOCKED';
  const rows = await query(`UPDATE creative_councils SET status=$2,updated_at=now() WHERE id=$1 RETURNING *`,[input.council_id,status]);
  if (rows[0].content_id) {
    const nextAction = status === 'CONCEPT_LOCKED' ? 'DIRECTOR_PRODUCE' : status === 'CORRECTIONS' ? 'DIRECTOR_REVISE_CONCEPT' : status === 'BLOCKED' ? 'RESOLVE_COUNCIL_BLOCKER' : 'CONTINUE_COUNCIL';
    await query(`UPDATE content_items SET stage_owner=$2,next_action=$3,updated_at=now() WHERE id=$1`,
      [rows[0].content_id,status === 'CONCEPT_LOCKED' || status === 'CORRECTIONS' ? 'director' : 'social-manager',nextAction]);
  }
  return rows[0];
}

async function recordAuditResult(input) {
  const auditedAt = new Date(input.audited_at ?? Date.now()).toISOString();
  const auditId = input.audit_id ?? `audit-${randomUUID()}`;
  const auditorIdentity = 'oneforall-auditor';
  const publishablePass = input.verdict === 'PASS' && input.audit_stage === 'postflight';

  const rows = await query(`
    INSERT INTO audit_results
      (audit_id,client_slug,client_id,item_id,content_version,content_hash,platform,audit_stage,
       auditor_identity,verdict,findings,evidence,council_id,client_profile_revision,receipt,signature_digest,audited_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15::jsonb,$16,$17)
    ON CONFLICT (audit_id) DO UPDATE SET
      findings=EXCLUDED.findings,evidence=EXCLUDED.evidence,receipt=EXCLUDED.receipt,
      signature_digest=EXCLUDED.signature_digest,audited_at=EXCLUDED.audited_at
    RETURNING *
  `,[auditId,input.client_slug,input.client_id ?? null,input.item_id,input.content_version,input.content_hash.toLowerCase(),
    input.platform,input.audit_stage,auditorIdentity,input.verdict,JSON.stringify(input.findings ?? []),
    JSON.stringify(input.evidence ?? []),input.council_id ?? null,input.client_profile_revision ?? null,
    null,null,auditedAt]);

  if (input.content_id) {
    const status = publishablePass ? 'approved' : input.verdict === 'PASS' ? 'in_production' : input.verdict === 'CORRECTIONS' ? 'needs_revision' : 'blocked';
    const owner = input.verdict === 'CORRECTIONS' || (input.verdict === 'PASS' && input.audit_stage === 'preflight') ? 'director' : 'social-manager';
    const nextAction = publishablePass ? 'SOCIAL_MANAGER_SCHEDULE_AND_PUBLISH' : input.verdict === 'PASS' ? 'DIRECTOR_PRODUCE' :
      input.verdict === 'CORRECTIONS' ? 'DIRECTOR_APPLY_AUDIT_CORRECTIONS' : 'RESOLVE_AUDIT_BLOCKER';
    await query(`UPDATE content_items SET status=$2,stage_owner=$3,next_action=$4,approval_receipt=$5::jsonb,updated_at=now() WHERE id=$1`,
      [input.content_id,status,owner,nextAction,JSON.stringify({audit_id:auditId,verdict:input.verdict,authenticated:false})]);
  }

  return {
    audit: rows[0],
    authorization_status: 'PERSISTED_NOT_SIGNED',
    handoff: publishablePass
      ? {owner:'social-manager',next_action:'OBTAIN_AUTHENTICATED_AUDITOR_RECEIPT_OR_OWNER_OVERRIDE'}
      : input.verdict === 'PASS'
        ? {owner:'director',next_action:'PRODUCE_LOCKED_CONCEPT'}
      : input.verdict === 'CORRECTIONS'
        ? {owner:'director',next_action:'APPLY_AUDIT_CORRECTIONS'}
        : {owner:'social-manager',next_action:'RESOLVE_AUDIT_BLOCKER'}
  };
}

async function getAuditResult(input) {
  if (input.audit_id) return (await query('SELECT * FROM audit_results WHERE audit_id=$1',[input.audit_id]))[0] ?? null;
  return (await query(`SELECT * FROM audit_results WHERE client_slug=$1 AND item_id=$2 AND content_version=$3
    ORDER BY audited_at DESC LIMIT 1`,[input.client_slug,input.item_id,input.content_version]))[0] ?? null;
}

async function recordReleaseFactor(input) {
  const rows = await query(`
    INSERT INTO release_factor_approvals
      (client_slug,item_id,content_version,content_hash,destination_id,factor,verdict,client_profile_revision,evidence,actor_receipt,approved_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
    ON CONFLICT(client_slug,item_id,content_version,content_hash,destination_id,factor) DO UPDATE SET
      verdict=EXCLUDED.verdict,client_profile_revision=EXCLUDED.client_profile_revision,evidence=EXCLUDED.evidence,
      actor_receipt=EXCLUDED.actor_receipt,approved_at=EXCLUDED.approved_at
    RETURNING *
  `,[input.client_slug,input.item_id,input.content_version,input.content_hash.toLowerCase(),input.destination_id,input.factor,
    input.verdict,input.client_profile_revision ?? null,JSON.stringify(input.evidence),JSON.stringify(input.actor_receipt),input.approved_at]);
  return rows[0];
}

async function evaluateOwnerApprovalReadiness(input) {
  const factors = await query(`
    SELECT factor,verdict,client_profile_revision,evidence,actor_receipt,approved_at
    FROM release_factor_approvals
    WHERE client_slug=$1 AND item_id=$2 AND content_version=$3 AND content_hash=$4 AND destination_id=$5
  `,[input.client_slug,input.item_id,input.content_version,input.content_hash.toLowerCase(),input.destination_id]);
  const required = ['agency','director','auditor'];
  const byFactor = Object.fromEntries(factors.map(row => [row.factor,row]));
  const missing = required.filter(factor => !byFactor[factor]);
  const negative = required.filter(factor => byFactor[factor] && byFactor[factor].verdict !== 'PASS');
  const status = negative.length ? 'BLOCKED' : missing.length ? 'WAITING' : 'READY_FOR_OWNER_APPROVAL';
  return {
    status,ready:status === 'READY_FOR_OWNER_APPROVAL',client_slug:input.client_slug,item_id:input.item_id,
    content_version:input.content_version,content_hash:input.content_hash.toLowerCase(),destination_id:input.destination_id,
    approvals:byFactor,missing_factors:missing,blocking_factors:negative,
    next_action:status === 'READY_FOR_OWNER_APPROVAL' ? 'SHOW_EXACT_PACKAGE_TO_OWNER' :
      status === 'BLOCKED' ? 'RETURN_TO_RESPONSIBLE_ACTOR_OR_REQUEST_OWNER_OVERRIDE' : 'COLLECT_MISSING_REVIEWS',
    authorization_created:false
  };
}

async function getAutomaticRun(runId) {
  return (await query('SELECT * FROM automatic_orchestration_runs WHERE id=$1',[runId]))[0] ?? null;
}

async function getAutomaticRunSnapshot(runId) {
  const run = await getAutomaticRun(runId);
  if (!run) throw new Error('AUTOMATIC_ORCHESTRATION_RUN_NOT_FOUND');
  const [actions,council,item] = await Promise.all([
    query('SELECT * FROM automatic_actor_actions WHERE run_id=$1 ORDER BY created_at,id',[runId]),
    run.council_id ? getCreativeCouncil({council_id:run.council_id}) : null,
    query('SELECT * FROM content_items WHERE id=$1',[run.content_id]).then(rows => rows[0] ?? null)
  ]);
  return {run,council,item,actions};
}

async function setAutomaticRun(runId, patch) {
  const allowed = new Set(['content_version','council_id','phase','status','correction_round','content_hash','destination_id','final_package','exact_blocker','last_transition']);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (!entries.length) return getAutomaticRun(runId);
  const values = [runId];
  const assignments = entries.map(([key,value]) => {
    values.push(key === 'final_package' || key === 'exact_blocker' || key === 'last_transition' ? JSON.stringify(value) : value);
    const cast = key === 'final_package' || key === 'exact_blocker' || key === 'last_transition' ? '::jsonb' : '';
    return `${key}=$${values.length}${cast}`;
  });
  return (await query(`UPDATE automatic_orchestration_runs SET ${assignments.join(',')},updated_at=now() WHERE id=$1 RETURNING *`,values))[0];
}

async function enqueueAutomaticAction(run, input) {
  const attempt = input.attempt ?? (run.correction_round + 1);
  const rows = await query(`
    INSERT INTO automatic_actor_actions(run_id,phase,actor,action_type,attempt,package_hash,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT(run_id,phase,actor,action_type,attempt) DO UPDATE SET
      payload=EXCLUDED.payload,package_hash=EXCLUDED.package_hash,updated_at=now()
    RETURNING *
  `,[run.id,input.phase,input.actor,input.action_type,attempt,input.package_hash ?? null,JSON.stringify(input.payload ?? {})]);
  return rows[0];
}

function exactCouncilBlocker(council) {
  for (const actor of ['agency','director','auditor']) {
    if (council?.[`${actor}_verdict`] !== 'BLOCKED') continue;
    const receipt = council[`${actor}_receipt`] ?? {};
    return {actor,stage:'CONCEPT_COUNCIL',...(receipt.blocker ?? {code:'BLOCKER_DETAILS_MISSING',message:'The blocking actor did not provide an exact blocker'})};
  }
  return null;
}

async function reconcileAutomaticRun(runId) {
  let run = await getAutomaticRun(runId);
  if (!run) throw new Error('AUTOMATIC_ORCHESTRATION_RUN_NOT_FOUND');
  if (['BLOCKED','USER_APPROVAL_REQUIRED','COMPLETE'].includes(run.status)) return getAutomaticRunSnapshot(runId);

  if (['CONCEPT_COUNCIL','CONCEPT_REVISION'].includes(run.phase)) {
    const council = await getCreativeCouncil({council_id:run.council_id});
    if (!council) throw new Error('AUTOMATIC_COUNCIL_NOT_FOUND');
    if (council.status === 'BLOCKED') {
      run = await setAutomaticRun(runId,{status:'BLOCKED',exact_blocker:exactCouncilBlocker(council),last_transition:{reason:'COUNCIL_BLOCKED',at:new Date().toISOString()}});
      await query("UPDATE automatic_actor_actions SET status='CANCELLED',updated_at=now() WHERE run_id=$1 AND status IN ('PENDING','CLAIMED')",[runId]);
      return getAutomaticRunSnapshot(runId);
    }
    if (council.status === 'CORRECTIONS') {
      run = await setAutomaticRun(runId,{phase:'CONCEPT_REVISION',status:'CORRECTIONS',last_transition:{reason:'COUNCIL_CORRECTIONS',at:new Date().toISOString()}});
      await query("UPDATE automatic_actor_actions SET status='CANCELLED',updated_at=now() WHERE run_id=$1 AND phase='CONCEPT_COUNCIL' AND status IN ('PENDING','CLAIMED')",[runId]);
      await enqueueAutomaticAction(run,{phase:'CONCEPT_REVISION',actor:'director',action_type:'REVISE_CONCEPT',package_hash:council.package_hash,payload:{council_id:council.id,corrections:{agency:council.agency_receipt?.corrections ?? [],director:council.director_receipt?.corrections ?? [],auditor:council.auditor_receipt?.corrections ?? []}}});
      return getAutomaticRunSnapshot(runId);
    }
    if (council.status === 'CONCEPT_LOCKED') {
      run = await setAutomaticRun(runId,{phase:'PRODUCTION',status:'RUNNING',last_transition:{reason:'ALL_COUNCIL_FACTORS_PASS',at:new Date().toISOString()}});
      await query("UPDATE automatic_actor_actions SET status='CANCELLED',updated_at=now() WHERE run_id=$1 AND status IN ('PENDING','CLAIMED')",[runId]);
      await enqueueAutomaticAction(run,{phase:'PRODUCTION',actor:'director',action_type:'PRODUCE_LOCKED_CONCEPT',package_hash:council.package_hash,payload:{council_id:council.id,concept_package:council.concept_package,client_profile_revision:council.client_profile_revision}});
      return getAutomaticRunSnapshot(runId);
    }
    for (const actor of ['agency','director','auditor']) {
      if (!council[`${actor}_verdict`]) await enqueueAutomaticAction(run,{phase:'CONCEPT_COUNCIL',actor,action_type:'REVIEW_CONCEPT',package_hash:council.package_hash,payload:{council_id:council.id,concept_package:council.concept_package,client_profile_revision:council.client_profile_revision}});
    }
    await setAutomaticRun(runId,{phase:'CONCEPT_COUNCIL',status:'WAITING_ACTOR',last_transition:{reason:'COUNCIL_ACTIONS_DISPATCHED',at:new Date().toISOString()}});
    return getAutomaticRunSnapshot(runId);
  }

  if (run.phase === 'PRODUCTION') {
    const council = await getCreativeCouncil({council_id:run.council_id});
    if (!council || council.status !== 'CONCEPT_LOCKED') throw new Error('PRODUCTION_REQUIRES_CONCEPT_LOCKED');
    await enqueueAutomaticAction(run,{phase:'PRODUCTION',actor:'director',action_type:'PRODUCE_LOCKED_CONCEPT',package_hash:council.package_hash,payload:{council_id:council.id,concept_package:council.concept_package,client_profile_revision:council.client_profile_revision}});
    await setAutomaticRun(runId,{status:'WAITING_ACTOR',last_transition:{reason:'DIRECTOR_PRODUCTION_DISPATCHED',at:new Date().toISOString()}});
    return getAutomaticRunSnapshot(runId);
  }

  if (run.phase === 'FINAL_REVIEW') {
    if (!run.content_hash || !run.destination_id) throw new Error('FINAL_PACKAGE_FINGERPRINT_REQUIRED');
    const reviews = await query(`SELECT * FROM release_factor_approvals WHERE client_slug=$1 AND item_id=$2 AND content_version=$3 AND content_hash=$4 AND destination_id=$5`,[run.client_slug,run.item_id,run.content_version,run.content_hash,run.destination_id]);
    const byActor = Object.fromEntries(reviews.map(row => [row.factor,row]));
    const blocked = reviews.find(row => row.verdict === 'BLOCKED');
    if (blocked) {
      await setAutomaticRun(runId,{status:'BLOCKED',exact_blocker:{actor:blocked.factor,stage:'FINAL_REVIEW',evidence:blocked.evidence},last_transition:{reason:'FINAL_REVIEW_BLOCKED',at:new Date().toISOString()}});
      return getAutomaticRunSnapshot(runId);
    }
    if (reviews.some(row => row.verdict === 'CORRECTIONS')) {
      run = await setAutomaticRun(runId,{phase:'FINAL_CORRECTION',status:'CORRECTIONS',last_transition:{reason:'FINAL_REVIEW_CORRECTIONS',at:new Date().toISOString()}});
      await query("UPDATE automatic_actor_actions SET status='CANCELLED',updated_at=now() WHERE run_id=$1 AND phase='FINAL_REVIEW' AND status IN ('PENDING','CLAIMED')",[runId]);
      await enqueueAutomaticAction(run,{phase:'FINAL_CORRECTION',actor:'director',action_type:'CORRECT_FINAL_PACKAGE',payload:{current_content_hash:run.content_hash,corrections:Object.fromEntries(reviews.filter(row => row.verdict === 'CORRECTIONS').map(row => [row.factor,row.evidence]))}});
      return getAutomaticRunSnapshot(runId);
    }
    if (['agency','director','auditor'].every(actor => byActor[actor]?.verdict === 'PASS')) {
      await setAutomaticRun(runId,{phase:'OWNER_DECISION',status:'USER_APPROVAL_REQUIRED',last_transition:{reason:'ALL_FINAL_FACTORS_PASS',next_action:'SHOW_EXACT_PACKAGE_TO_OWNER',at:new Date().toISOString()}});
      await query(`UPDATE content_items SET status='approved',stage_owner='owner',next_action='SHOW_EXACT_PACKAGE_TO_OWNER',updated_at=now() WHERE id=$1`,[run.content_id]);
      return getAutomaticRunSnapshot(runId);
    }
    for (const actor of ['agency','director','auditor']) {
      if (!byActor[actor]) await enqueueAutomaticAction(run,{phase:'FINAL_REVIEW',actor,action_type:'REVIEW_FINAL_PACKAGE',payload:{content_hash:run.content_hash,destination_id:run.destination_id,final_package:run.final_package}});
    }
    await setAutomaticRun(runId,{status:'WAITING_ACTOR',last_transition:{reason:'FINAL_REVIEW_ACTIONS_DISPATCHED',at:new Date().toISOString()}});
  }
  return getAutomaticRunSnapshot(runId);
}

async function startAutomaticOrchestration(input) {
  const item = (await query(`SELECT * FROM content_items WHERE client_slug=$1 AND item_id=$2`,[input.client_slug,input.item_id]))[0];
  if (!item) throw new Error('CONTENT_ITEM_NOT_FOUND');
  if (item.content_version !== input.content_version) throw new Error(`CONTENT_VERSION_MISMATCH: current=${item.content_version}`);
  const council = await getCreativeCouncil({client_slug:input.client_slug,item_id:input.item_id,content_version:input.content_version});
  if (!council) throw new Error('CREATIVE_COUNCIL_REQUIRED');
  const profile = await getClientProfile(input.client_slug);
  if (!profile || profile.revision !== council.client_profile_revision) throw new Error('CLIENT_PROFILE_REVISION_MISMATCH');
  const initialPhase = council.status === 'CONCEPT_LOCKED' ? 'PRODUCTION' : council.status === 'CORRECTIONS' ? 'CONCEPT_REVISION' : 'CONCEPT_COUNCIL';
  const rows = await query(`
    INSERT INTO automatic_orchestration_runs(client_slug,content_id,item_id,content_version,council_id,phase,status,max_correction_rounds,owner_override_allowed,last_transition)
    VALUES($1,$2,$3,$4,$5,$6,'RUNNING',$7,true,$8::jsonb)
    ON CONFLICT(client_slug,item_id,content_version) DO UPDATE SET
      content_id=EXCLUDED.content_id,council_id=EXCLUDED.council_id,max_correction_rounds=EXCLUDED.max_correction_rounds,
      owner_override_allowed=true,updated_at=now()
    RETURNING *
  `,[input.client_slug,item.id,input.item_id,input.content_version,council.id,initialPhase,input.max_correction_rounds ?? 3,JSON.stringify({reason:'AUTOMATIC_ORCHESTRATION_STARTED',at:new Date().toISOString()})]);
  await query(`UPDATE content_items SET stage_owner='social-manager',next_action='AUTOMATIC_ORCHESTRATION',updated_at=now() WHERE id=$1`,[item.id]);
  return reconcileAutomaticRun(rows[0].id);
}

async function claimAutomaticAction(input) {
  const rows = await query(`
    UPDATE automatic_actor_actions SET status='CLAIMED',claimed_by=$3,claimed_at=now(),updated_at=now()
    WHERE id=(SELECT id FROM automatic_actor_actions WHERE run_id=$1 AND actor=$2 AND status='PENDING' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *
  `,[input.run_id,input.actor,input.claimed_by]);
  return {action:rows[0] ?? null,run:await getAutomaticRun(input.run_id)};
}

async function completeAutomaticAction(input) {
  const action = (await query('SELECT * FROM automatic_actor_actions WHERE id=$1',[input.action_id]))[0];
  if (!action) throw new Error('AUTOMATIC_ACTION_NOT_FOUND');
  if (action.status === 'COMPLETED') return getAutomaticRunSnapshot(action.run_id);
  if (!['PENDING','CLAIMED'].includes(action.status)) throw new Error(`AUTOMATIC_ACTION_NOT_COMPLETABLE: ${action.status}`);
  if (action.actor !== input.actor) throw new Error('AUTOMATIC_ACTION_ACTOR_MISMATCH');
  if (action.claimed_by && action.claimed_by !== input.completed_by) throw new Error('AUTOMATIC_ACTION_CLAIM_IDENTITY_MISMATCH');
  let run = await getAutomaticRun(action.run_id);
  if (!run) throw new Error('AUTOMATIC_ORCHESTRATION_RUN_NOT_FOUND');
  const result = input.result ?? {};

  if (action.action_type === 'REVIEW_CONCEPT') {
    await recordCouncilVerdict({council_id:run.council_id,expected_package_hash:action.package_hash,role:input.actor,verdict:input.verdict,receipt:result});
  } else if (action.action_type === 'REVISE_CONCEPT') {
    if (!result.concept_package) throw new Error('REVISED_CONCEPT_PACKAGE_REQUIRED');
    if (run.correction_round >= run.max_correction_rounds) {
      await setAutomaticRun(run.id,{status:'BLOCKED',exact_blocker:{code:'CONCEPT_CORRECTION_BUDGET_EXHAUSTED',rounds:run.correction_round},last_transition:{reason:'CORRECTION_BUDGET_EXHAUSTED',at:new Date().toISOString()}});
    } else {
      const council = await getCreativeCouncil({council_id:run.council_id});
      const revised = await openCreativeCouncil({client_slug:run.client_slug,content_id:run.content_id,item_id:run.item_id,content_version:run.content_version,client_profile_revision:council.client_profile_revision,research_receipt_id:council.research_receipt_id,concept_package:result.concept_package});
      run = await setAutomaticRun(run.id,{council_id:revised.id,phase:'CONCEPT_COUNCIL',status:'RUNNING',correction_round:run.correction_round+1,last_transition:{reason:'DIRECTOR_REVISED_CONCEPT',at:new Date().toISOString()}});
    }
  } else if (action.action_type === 'PRODUCE_LOCKED_CONCEPT' || action.action_type === 'CORRECT_FINAL_PACKAGE') {
    if (action.action_type === 'CORRECT_FINAL_PACKAGE' && run.correction_round >= run.max_correction_rounds) {
      await setAutomaticRun(run.id,{status:'BLOCKED',exact_blocker:{code:'FINAL_CORRECTION_BUDGET_EXHAUSTED',rounds:run.correction_round},last_transition:{reason:'CORRECTION_BUDGET_EXHAUSTED',at:new Date().toISOString()}});
      await query(`UPDATE automatic_actor_actions SET status='BLOCKED',result=$2::jsonb,completed_at=now(),updated_at=now() WHERE id=$1`,[action.id,JSON.stringify({blocker:{code:'FINAL_CORRECTION_BUDGET_EXHAUSTED',rounds:run.correction_round}})]);
      return getAutomaticRunSnapshot(run.id);
    }
    if (!result.content_hash || !/^[0-9a-f]{64}$/i.test(result.content_hash)) throw new Error('VALID_FINAL_CONTENT_HASH_REQUIRED');
    if (!result.destination_id || !result.final_package) throw new Error('FINAL_PACKAGE_AND_DESTINATION_REQUIRED');
    const nextVersion = result.content_version ?? run.content_version;
    if (nextVersion < run.content_version) throw new Error('CONTENT_VERSION_CANNOT_DECREASE');
    await query(`UPDATE content_items SET content_version=$2,status='audit',stage_owner='social-manager',next_action='RUN_FINAL_REVIEWS',asset_ids=COALESCE($3::jsonb,asset_ids),caption=COALESCE($4,caption),updated_at=now() WHERE id=$1`,[run.content_id,nextVersion,JSON.stringify(result.final_package.asset_ids ?? null),result.final_package.caption ?? null]);
    run = await setAutomaticRun(run.id,{content_version:nextVersion,phase:'FINAL_REVIEW',status:'RUNNING',content_hash:result.content_hash.toLowerCase(),destination_id:result.destination_id,final_package:result.final_package,correction_round:action.action_type === 'CORRECT_FINAL_PACKAGE' ? run.correction_round+1 : run.correction_round,last_transition:{reason:action.action_type === 'PRODUCE_LOCKED_CONCEPT' ? 'PRODUCTION_COMPLETED' : 'FINAL_CORRECTION_COMPLETED',at:new Date().toISOString()}});
  } else if (action.action_type === 'REVIEW_FINAL_PACKAGE') {
    if (!Array.isArray(result.evidence) || result.evidence.length === 0) throw new Error('FINAL_REVIEW_EVIDENCE_REQUIRED');
    if (input.verdict === 'CORRECTIONS' && (!Array.isArray(result.corrections) || result.corrections.length === 0)) throw new Error('FINAL_CORRECTIONS_REQUIRE_EXPLICIT_CORRECTIONS');
    if (input.verdict === 'BLOCKED' && (!result.blocker || typeof result.blocker !== 'object')) throw new Error('FINAL_BLOCKED_REQUIRES_EXACT_BLOCKER');
    await recordReleaseFactor({client_slug:run.client_slug,item_id:run.item_id,content_version:run.content_version,content_hash:run.content_hash,destination_id:run.destination_id,factor:input.actor,verdict:input.verdict,client_profile_revision:result.client_profile_revision ?? null,evidence:result.evidence,actor_receipt:{...result,actor:input.actor,verdict:input.verdict},approved_at:new Date().toISOString()});
  }

  await query(`UPDATE automatic_actor_actions SET status='COMPLETED',result=$2::jsonb,completed_at=now(),updated_at=now() WHERE id=$1`,[action.id,JSON.stringify({verdict:input.verdict ?? null,...result})]);
  return reconcileAutomaticRun(action.run_id);
}

async function createContent(input) {
  const rows = await query(`
    INSERT INTO content_items
      (client_slug,item_id,root_item_id,parent_item_id,variant_key,source_content_version,
       content_version,client_profile_revision,stage_owner,next_action,publisher_kind,
       campaign,platform,format,pillar,title,idea,hook,objective,cta,status,priority,
       scheduled_at,published_at,publisher_post_id,published_url,asset_ids,caption,source_idea_id,director_project_id,
       approval_receipt,metadata,google_calendar_id,google_calendar_event_id,calendar_sync_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb,$28,$29,$30,$31::jsonb,$32::jsonb,$33,$34,$35)
    RETURNING *
  `, [input.client_slug,input.item_id,input.root_item_id ?? input.item_id,input.parent_item_id ?? null,input.variant_key ?? 'master',input.source_content_version ?? null,
      input.content_version ?? 1,input.client_profile_revision ?? null,input.stage_owner ?? 'social-manager',
      input.next_action ?? 'LOAD_CLIENT_CONTEXT',input.publisher_kind ?? null,input.campaign ?? 'default',input.platform ?? 'instagram',
      input.format,input.pillar ?? null,input.title,input.idea ?? null,input.hook ?? null,input.objective ?? null,input.cta ?? null,
      input.status ?? 'idea',input.priority ?? 50,input.scheduled_at ?? null,input.published_at ?? null,input.publisher_post_id ?? null,
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
      scheduled_recorded_at=CASE
        WHEN $2='scheduled' AND ($3::timestamptz IS NOT NULL OR scheduled_at IS NOT NULL)
          THEN COALESCE(scheduled_recorded_at,now())
        ELSE scheduled_recorded_at
      END,
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

function zonedClock(timezone, instant = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US',{
    timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  }).formatToParts(instant).filter(part => part.type !== 'literal').map(part => [part.type,part.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}:${parts.second}`};
}

function assertTimezone(timezone) {
  try { zonedClock(timezone); }
  catch { throw new Error(`INVALID_TIMEZONE: ${timezone}`); }
}

async function getContentSupplyPolicy(input) {
  return (await query(`SELECT * FROM content_supply_policies WHERE client_slug=$1 AND campaign=$2 AND platform=$3`,[
    input.client_slug,input.campaign ?? 'default',input.platform ?? 'instagram'
  ]))[0] ?? null;
}

async function upsertContentSupplyPolicy(input) {
  assertTimezone(input.timezone);
  const profile = await getClientProfile(input.client_slug);
  if (!profile) throw new Error('CLIENT_PROFILE_REQUIRED: Agency OS profile must exist before content supply automation is configured');
  if (input.target_ready_items < input.minimum_ready_items) throw new Error('TARGET_READY_ITEMS_MUST_MEET_MINIMUM');
  const rows = await query(`
    INSERT INTO content_supply_policies
      (client_slug,campaign,platform,automation_enabled,manual_enabled,timezone,daily_trigger_time,lead_days,
       minimum_ready_items,target_ready_items,minimum_scheduled_items,publication_order,production_instructions,
       research_policy,owner_approval_required,created_by,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,now())
    ON CONFLICT(client_slug,campaign,platform) DO UPDATE SET
      automation_enabled=EXCLUDED.automation_enabled,manual_enabled=EXCLUDED.manual_enabled,timezone=EXCLUDED.timezone,
      daily_trigger_time=EXCLUDED.daily_trigger_time,lead_days=EXCLUDED.lead_days,
      minimum_ready_items=EXCLUDED.minimum_ready_items,target_ready_items=EXCLUDED.target_ready_items,
      minimum_scheduled_items=EXCLUDED.minimum_scheduled_items,publication_order=EXCLUDED.publication_order,
      production_instructions=EXCLUDED.production_instructions,research_policy=EXCLUDED.research_policy,
      owner_approval_required=EXCLUDED.owner_approval_required,updated_at=now()
    RETURNING *
  `,[input.client_slug,input.campaign ?? 'default',input.platform ?? 'instagram',input.automation_enabled ?? false,
    input.manual_enabled ?? true,input.timezone,input.daily_trigger_time,input.lead_days,input.minimum_ready_items,
    input.target_ready_items,input.minimum_scheduled_items,JSON.stringify(input.publication_order ?? []),
    JSON.stringify(input.production_instructions ?? {}),JSON.stringify(input.research_policy ?? {}),
    input.owner_approval_required ?? true,input.created_by]);
  return rows[0];
}

async function contentSupplyInventory(policy) {
  const summary = (await query(`
    SELECT
      count(*) FILTER (WHERE status='approved')::int AS approved_unscheduled,
      count(*) FILTER (WHERE status='scheduled' AND scheduled_at>now())::int AS scheduled_future,
      max(scheduled_at) FILTER (WHERE status='scheduled' AND scheduled_at>now()) AS coverage_until,
      count(*) FILTER (
        WHERE status='scheduled' AND scheduled_at>now() AND scheduled_recorded_at IS NOT NULL
          AND scheduled_at < scheduled_recorded_at + ($4::int * interval '1 day')
      )::int AS lead_time_violations
    FROM content_items
    WHERE client_slug=$1 AND campaign=$2 AND platform=$3
  `,[policy.client_slug,policy.campaign,policy.platform,policy.lead_days]))[0];
  const readyInventory = summary.approved_unscheduled + summary.scheduled_future;
  return {
    approved_unscheduled:summary.approved_unscheduled,
    scheduled_future:summary.scheduled_future,
    ready_inventory:readyInventory,
    coverage_until:summary.coverage_until,
    lead_time_violations:summary.lead_time_violations,
    minimum_ready_items:policy.minimum_ready_items,
    target_ready_items:policy.target_ready_items,
    minimum_scheduled_items:policy.minimum_scheduled_items,
    lead_days:policy.lead_days
  };
}

async function getContentSupplyRun(runId) {
  const run = (await query('SELECT * FROM content_supply_runs WHERE id=$1',[runId]))[0] ?? null;
  if (!run) throw new Error('CONTENT_SUPPLY_RUN_NOT_FOUND');
  const [policy,orders] = await Promise.all([
    query('SELECT * FROM content_supply_policies WHERE id=$1',[run.policy_id]).then(rows => rows[0] ?? null),
    query('SELECT * FROM content_supply_orders WHERE run_id=$1 ORDER BY sequence',[runId])
  ]);
  return {run,policy,orders};
}

async function runContentSupply(input) {
  const policy = await getContentSupplyPolicy(input);
  if (!policy) throw new Error('CONTENT_SUPPLY_POLICY_NOT_FOUND');
  if (input.trigger_source === 'daily' && !policy.automation_enabled) throw new Error('CONTENT_SUPPLY_AUTOMATION_DISABLED');
  if (input.trigger_source === 'manual' && !policy.manual_enabled) throw new Error('CONTENT_SUPPLY_MANUAL_RUN_DISABLED');
  if (input.trigger_source === 'manual' && !input.idempotency_key) throw new Error('MANUAL_IDEMPOTENCY_KEY_REQUIRED');
  const clock = zonedClock(policy.timezone);
  const insertSql = input.trigger_source === 'daily'
    ? `INSERT INTO content_supply_runs(policy_id,client_slug,campaign,platform,trigger_source,local_date,requested_by)
       VALUES($1,$2,$3,$4,'daily',$5,$6)
       ON CONFLICT(policy_id,local_date) WHERE trigger_source='daily' DO NOTHING RETURNING *`
    : `INSERT INTO content_supply_runs(policy_id,client_slug,campaign,platform,trigger_source,idempotency_key,local_date,requested_by)
       VALUES($1,$2,$3,$4,'manual',$5,$6,$7)
       ON CONFLICT(policy_id,idempotency_key) WHERE trigger_source='manual' AND idempotency_key IS NOT NULL DO NOTHING RETURNING *`;
  const insertParams = input.trigger_source === 'daily'
    ? [policy.id,policy.client_slug,policy.campaign,policy.platform,clock.date,input.requested_by]
    : [policy.id,policy.client_slug,policy.campaign,policy.platform,input.idempotency_key,clock.date,input.requested_by];
  let run = (await query(insertSql,insertParams))[0];
  if (!run) {
    const existing = input.trigger_source === 'daily'
      ? await query(`SELECT * FROM content_supply_runs WHERE policy_id=$1 AND trigger_source='daily' AND local_date=$2`,[policy.id,clock.date])
      : await query(`SELECT * FROM content_supply_runs WHERE policy_id=$1 AND trigger_source='manual' AND idempotency_key=$2`,[policy.id,input.idempotency_key]);
    return {...await getContentSupplyRun(existing[0].id),created:false};
  }

  const inventory = await contentSupplyInventory(policy);
  const thresholdGeneration = inventory.ready_inventory < policy.minimum_ready_items
    ? Math.max(policy.target_ready_items - inventory.ready_inventory,0) : 0;
  const generationCount = input.trigger_source === 'manual' && input.requested_count != null
    ? input.requested_count : thresholdGeneration;
  const scheduleCount = Math.max(policy.minimum_scheduled_items - inventory.scheduled_future,0);
  const scheduleReadyCount = Math.min(scheduleCount,inventory.approved_unscheduled);
  const decision = {
    generation_required:generationCount > 0,
    generation_count:generationCount,
    scheduling_required:scheduleCount > 0,
    scheduling_count:scheduleCount,
    scheduling_order_count:scheduleReadyCount,
    scheduling_deferred_count:scheduleCount - scheduleReadyCount,
    lead_time_warning:inventory.lead_time_violations > 0,
    trigger_source:input.trigger_source,
    owner_approval_required:policy.owner_approval_required
  };
  let sequence = 1;
  let researchOrder = null;
  const sharedPayload = {
    client_slug:policy.client_slug,campaign:policy.campaign,platform:policy.platform,
    policy_id:policy.id,publication_order:policy.publication_order,
    production_instructions:policy.production_instructions,owner_approval_required:policy.owner_approval_required
  };
  if (generationCount > 0 && policy.research_policy?.enabled) {
    researchOrder = (await query(`
      INSERT INTO content_supply_orders(run_id,actor,action_type,sequence,payload)
      VALUES($1,'autopilot','REFRESH_CONTENT_RESEARCH',$2,$3::jsonb) RETURNING *
    `,[run.id,sequence++,JSON.stringify({...sharedPayload,research_policy:policy.research_policy})]))[0];
  }
  if (generationCount > 0) {
    await query(`
      INSERT INTO content_supply_orders(run_id,actor,action_type,sequence,depends_on,payload)
      VALUES($1,'director','GENERATE_CONTENT_BATCH',$2,$3,$4::jsonb)
    `,[run.id,sequence++,researchOrder?.id ?? null,JSON.stringify({...sharedPayload,count:generationCount,research_order_id:researchOrder?.id ?? null})]);
  }
  if (scheduleReadyCount > 0) {
    await query(`
      INSERT INTO content_supply_orders(run_id,actor,action_type,sequence,payload)
      VALUES($1,'social-manager','SCHEDULE_READY_CONTENT',$2,$3::jsonb)
    `,[run.id,sequence++,JSON.stringify({...sharedPayload,count:scheduleReadyCount,lead_days:policy.lead_days,approved_content_only:true})]);
  }
  const status = sequence === 1 ? 'NO_ACTION' : 'ORDERS_PENDING';
  run = (await query(`UPDATE content_supply_runs SET status=$2,inventory_snapshot=$3::jsonb,decision=$4::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,[
    run.id,status,JSON.stringify(inventory),JSON.stringify(decision)
  ]))[0];
  return {...await getContentSupplyRun(run.id),created:true};
}

async function claimContentSupplyOrder(input) {
  const params = [input.actor,input.claimed_by];
  const runFilter = input.run_id ? `AND candidate.run_id=$3` : '';
  if (input.run_id) params.push(input.run_id);
  const rows = await query(`
    WITH candidate AS (
      SELECT candidate.id,candidate.run_id
      FROM content_supply_orders candidate
      LEFT JOIN content_supply_orders dependency ON dependency.id=candidate.depends_on
      WHERE candidate.actor=$1 AND candidate.status='PENDING'
        AND (candidate.depends_on IS NULL OR dependency.status='COMPLETED') ${runFilter}
      ORDER BY candidate.created_at,candidate.sequence
      LIMIT 1 FOR UPDATE OF candidate SKIP LOCKED
    )
    UPDATE content_supply_orders target
    SET status='CLAIMED',claimed_by=$2,claimed_at=now(),updated_at=now()
    FROM candidate WHERE target.id=candidate.id RETURNING target.*
  `,params);
  return {order:rows[0] ?? null,run:rows[0] ? (await getContentSupplyRun(rows[0].run_id)).run : null};
}

async function completeContentSupplyOrder(input) {
  const order = (await query('SELECT * FROM content_supply_orders WHERE id=$1',[input.order_id]))[0];
  if (!order) throw new Error('CONTENT_SUPPLY_ORDER_NOT_FOUND');
  if (order.status === 'COMPLETED') return getContentSupplyRun(order.run_id);
  if (!['PENDING','CLAIMED'].includes(order.status)) throw new Error(`CONTENT_SUPPLY_ORDER_NOT_COMPLETABLE: ${order.status}`);
  if (order.actor !== input.actor) throw new Error('CONTENT_SUPPLY_ORDER_ACTOR_MISMATCH');
  if (order.claimed_by && order.claimed_by !== input.completed_by) throw new Error('CONTENT_SUPPLY_ORDER_CLAIM_IDENTITY_MISMATCH');
  if (input.status === 'BLOCKED' && (!input.result?.blocker || typeof input.result.blocker !== 'object')) {
    throw new Error('CONTENT_SUPPLY_BLOCKED_REQUIRES_EXACT_BLOCKER');
  }
  await query(`UPDATE content_supply_orders SET status=$2,result=$3::jsonb,completed_at=now(),updated_at=now() WHERE id=$1`,[
    order.id,input.status,JSON.stringify(input.result ?? {})
  ]);
  if (input.status === 'BLOCKED') {
    await query(`UPDATE content_supply_runs SET status='BLOCKED',decision=decision || $2::jsonb,updated_at=now() WHERE id=$1`,[
      order.run_id,JSON.stringify({blocker:input.result.blocker,blocked_order_id:order.id})
    ]);
  } else {
    const counts = (await query(`SELECT
      count(*) FILTER(WHERE status IN ('PENDING','CLAIMED'))::int AS open,
      count(*) FILTER(WHERE status='BLOCKED')::int AS blocked
      FROM content_supply_orders WHERE run_id=$1`,[order.run_id]))[0];
    const status = counts.blocked > 0 ? 'BLOCKED' : counts.open === 0 ? 'COMPLETE' : 'ORDERS_PENDING';
    await query('UPDATE content_supply_runs SET status=$2,updated_at=now() WHERE id=$1',[order.run_id,status]);
  }
  return getContentSupplyRun(order.run_id);
}

async function getDailySupplyDigest(input) {
  const policy = await getContentSupplyPolicy(input);
  if (!policy) throw new Error('CONTENT_SUPPLY_POLICY_NOT_FOUND');
  const localDate = zonedClock(policy.timezone).date;
  let run = (await query(`SELECT * FROM content_supply_runs WHERE policy_id=$1 AND trigger_source='daily' AND local_date=$2`,[
    policy.id,localDate
  ]))[0] ?? null;
  if (!run) return {display:false,reason:'DAILY_TRIGGER_NOT_RUN',local_date:localDate,policy};
  if (run.shown_at) return {display:false,reason:'ALREADY_SHOWN_TODAY',shown_at:run.shown_at,local_date:localDate};
  if (input.mark_shown !== false) {
    run = (await query('UPDATE content_supply_runs SET shown_at=now(),updated_at=now() WHERE id=$1 AND shown_at IS NULL RETURNING *',[run.id]))[0] ?? run;
  }
  return {display:true,local_date:localDate,...await getContentSupplyRun(run.id)};
}

async function runDueContentSupplyPolicies() {
  const policies = await query('SELECT * FROM content_supply_policies WHERE automation_enabled=true ORDER BY client_slug,campaign,platform');
  const results = [];
  for (const policy of policies) {
    const clock = zonedClock(policy.timezone);
    if (clock.time < String(policy.daily_trigger_time)) continue;
    try {
      const result = await runContentSupply({
        client_slug:policy.client_slug,campaign:policy.campaign,platform:policy.platform,
        trigger_source:'daily',requested_by:'content-supply-scheduler'
      });
      if (result.created) results.push({policy_id:policy.id,run_id:result.run.id,status:result.run.status});
    } catch (error) {
      console.error('Content supply scheduler policy failed',{policy_id:policy.id,error:error.message});
    }
  }
  return {checked:policies.length,created:results.length,runs:results};
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

  tool('set_content_supply_policy','Create or update the opt-in Agency OS content supply policy for one client account. Automation remains disabled unless automation_enabled is explicitly true.',{
    client_slug:z.string().regex(/^[a-z0-9-]+$/),campaign:z.string().default('default'),platform:z.string().default('instagram'),
    automation_enabled:z.boolean().default(false),manual_enabled:z.boolean().default(true),timezone:z.string().default('America/Bogota'),
    daily_trigger_time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/).default('09:00'),
    lead_days:z.number().int().nonnegative().default(3),minimum_ready_items:z.number().int().nonnegative(),
    target_ready_items:z.number().int().nonnegative(),minimum_scheduled_items:z.number().int().nonnegative(),
    publication_order:z.array(z.any()).default([]),production_instructions:z.record(z.any()).default({}),
    research_policy:z.record(z.any()).default({}),owner_approval_required:z.boolean().default(true),created_by:z.string().min(1).max(180)
  },['social.admin'],async input => toolResult(await upsertContentSupplyPolicy(input)));

  tool('get_content_supply_policy','Get the opt-in content cadence, order, buffer, lead-time and research policy for one client account.',{
    client_slug:z.string(),campaign:z.string().default('default'),platform:z.string().default('instagram')
  },['social.read'],async input => toolResult({policy:await getContentSupplyPolicy(input)}));

  tool('run_content_supply','Run the same persisted content supply decision manually or from the daily scheduler. Manual runs require an idempotency key and work only when manual execution is enabled.',{
    client_slug:z.string(),campaign:z.string().default('default'),platform:z.string().default('instagram'),
    trigger_source:z.enum(['daily','manual']),idempotency_key:z.string().min(8).max(180).optional(),
    requested_count:z.number().int().positive().max(100).optional(),requested_by:z.string().min(1).max(180)
  },['social.write'],async input => toolResult(await runContentSupply(input)));

  tool('run_due_content_supply','Run all due opt-in daily policies now. Daily uniqueness prevents duplicate triggers.',{
  },['social.admin'],async () => toolResult(await runDueContentSupplyPolicies()));

  tool('get_content_supply_run','Get one supply run with exact policy and ordered actor work.',{
    run_id:z.string().uuid()
  },['social.read'],async ({run_id}) => toolResult(await getContentSupplyRun(run_id)));

  tool('claim_content_supply_order','Claim the next dependency-ready supply order for Autopilot, Director or Social Manager.',{
    actor:z.enum(['autopilot','director','social-manager']),claimed_by:z.string().min(1).max(180),run_id:z.string().uuid().optional()
  },['social.write'],async input => toolResult(await claimContentSupplyOrder(input)));

  tool('complete_content_supply_order','Persist real execution evidence for one supply order. BLOCKED requires an exact blocker.',{
    order_id:z.string().uuid(),actor:z.enum(['autopilot','director','social-manager']),completed_by:z.string().min(1).max(180),
    status:z.enum(['COMPLETED','BLOCKED']),result:z.record(z.any()).default({})
  },['social.write'],async input => toolResult(await completeContentSupplyOrder(input)));

  tool('get_daily_supply_digest','Return today\'s daily supply trigger once. Subsequent reads report ALREADY_SHOWN_TODAY.',{
    client_slug:z.string(),campaign:z.string().default('default'),platform:z.string().default('instagram'),mark_shown:z.boolean().default(true)
  },['social.read'],async input => toolResult(await getDailySupplyDigest(input)));

  tool('create_content_item','Register an idea or production item in the persistent editorial pipeline',{
    client_slug:z.string(),item_id:z.string().min(1).max(180),content_version:z.number().int().positive().default(1),
    root_item_id:z.string().min(1).max(180).optional(),parent_item_id:z.string().min(1).max(180).optional(),
    variant_key:z.string().min(1).max(80).optional(),source_content_version:z.number().int().positive().optional(),
    client_profile_revision:z.number().int().positive().optional(),stage_owner:z.string().optional(),next_action:z.string().optional(),
    publisher_kind:z.enum(['instagram','youtube','tiktok']).optional(),campaign:z.string().default('default'),platform:z.string().default('instagram'),
    format:z.enum(['image','carousel','reel','story','other']),title:z.string(),pillar:z.string().optional(),idea:z.string().optional(),hook:z.string().optional(),objective:z.string().optional(),cta:z.string().optional(),status:z.enum(STATUSES).optional(),priority:z.number().int().min(0).max(100).optional(),caption:z.string().optional(),asset_ids:z.array(z.string()).optional(),director_project_id:z.string().optional(),google_calendar_id:z.string().optional(),google_calendar_event_id:z.string().optional(),calendar_sync_status:z.string().optional(),metadata:z.record(z.any()).optional()
  },['social.write'],async input => toolResult(await createContent(input)));

  tool('get_client_profile','Get the canonical versioned client profile used by Agency OS, Director and Auditor',{
    client_slug:z.string()
  },['social.read'],async ({client_slug}) => toolResult({profile:await getClientProfile(client_slug)}));

  tool('upsert_client_profile','Create or update the canonical client profile. A material change increments revision and changes profile_hash',{
    client_slug:z.string().regex(/^[a-z0-9-]+$/),client_name:z.string().min(1).max(180),summary:z.string().optional(),
    business:z.record(z.any()).optional(),audience:z.record(z.any()).optional(),offers:z.array(z.any()).optional(),goals:z.array(z.any()).optional(),
    brand:z.record(z.any()).optional(),visual_style:z.record(z.any()).optional(),copy_style:z.record(z.any()).optional(),
    constraints:z.array(z.any()).optional(),source_refs:z.array(z.any()).optional(),updated_by:z.string().min(1).max(180)
  },['social.write'],async input => toolResult(await upsertClientProfile(input)));

  tool('save_research_receipt','Persist verified or explicitly partial research from UCI, web or Agent Reach before creative selection',{
    client_slug:z.string(),content_id:z.string().uuid().optional(),item_id:z.string().max(180).optional(),mode:z.enum(['news','watch','research']),
    source_tool:z.string().min(1),query:z.string().optional(),sources:z.array(z.record(z.any())),findings:z.array(z.record(z.any())),
    deduplication:z.record(z.any()).optional(),status:z.enum(['VERIFIED','PARTIAL','NOT_VERIFIED']),researched_at:z.string().datetime({offset:true})
  },['social.write'],async input => toolResult(await saveResearchReceipt(input)));

  tool('open_creative_council','Open or replace the pre-production council for one exact ITEM_ID/version and client-profile revision',{
    client_slug:z.string(),content_id:z.string().uuid().optional(),item_id:z.string().min(1).max(180),content_version:z.number().int().positive(),
    client_profile_revision:z.number().int().positive(),research_receipt_id:z.string().uuid().optional(),concept_package:z.record(z.any())
  },['social.write'],async input => toolResult(await openCreativeCouncil(input)));

  tool('record_council_verdict','Record one Agency, Director or Auditor verdict against the immutable council package hash; locks only after all three PASS',{
    council_id:z.string().uuid(),expected_package_hash:z.string().regex(/^[0-9a-f]{64}$/i),role:z.enum(['agency','director','auditor']),
    verdict:z.enum(['PASS','CORRECTIONS','BLOCKED']),receipt:z.record(z.any())
  },['social.write'],async input => toolResult(await recordCouncilVerdict(input)));

  tool('get_creative_council','Retrieve a council by ID or exact client/ITEM_ID/version',{
    council_id:z.string().uuid().optional(),client_slug:z.string().optional(),item_id:z.string().optional(),content_version:z.number().int().positive().optional()
  },['social.read'],async input => {
    if (!input.council_id && !(input.client_slug && input.item_id && input.content_version)) throw new Error('council_id or client_slug+item_id+content_version required');
    return toolResult({council:await getCreativeCouncil(input)});
  });

  tool('record_audit_observation','Persist a real Auditor preflight or postflight observation with evidence. This records workflow state but does not mint a Publisher authorization signature',{
    audit_id:z.string().min(1).max(180).optional(),client_slug:z.string(),client_id:z.string().uuid().optional(),
    content_id:z.string().uuid().optional(),item_id:z.string().min(1).max(180),content_version:z.number().int().positive(),
    content_hash:z.string().regex(/^[0-9a-f]{64}$/i),platform:z.enum(['instagram','youtube','tiktok']),
    audit_stage:z.enum(['preflight','postflight']),verdict:z.enum(['PASS','CORRECTIONS','BLOCKED']),
    findings:z.array(z.record(z.any())).default([]),evidence:z.array(z.record(z.any())).min(1),
    council_id:z.string().uuid().optional(),client_profile_revision:z.number().int().positive().optional(),
    audited_at:z.string().datetime({offset:true}).optional()
  },['social.write'],async input => toolResult(await recordAuditResult(input)));

  tool('get_audit_observation','Retrieve the latest persisted Auditor observation by audit ID or exact client/ITEM_ID/version',{
    audit_id:z.string().optional(),client_slug:z.string().optional(),item_id:z.string().optional(),content_version:z.number().int().positive().optional()
  },['social.read'],async input => {
    if (!input.audit_id && !(input.client_slug && input.item_id && input.content_version)) throw new Error('audit_id or client_slug+item_id+content_version required');
    return toolResult({audit:await getAuditResult(input)});
  });

  tool('record_release_review','Record an Agency, Director or Auditor review for one exact content fingerprint and destination. This is advisory workflow evidence only: it never authorizes publication, never impersonates an authenticated actor and never creates an Auditor signature or owner approval.',{
    client_slug:z.string(),item_id:z.string().min(1).max(180),content_version:z.number().int().positive(),
    content_hash:z.string().regex(/^[0-9a-f]{64}$/i),destination_id:z.string().min(1).max(240),
    factor:z.enum(['agency','director','auditor']),verdict:z.enum(['PASS','CORRECTIONS','BLOCKED']),
    client_profile_revision:z.number().int().positive().optional(),evidence:z.array(z.record(z.any())).min(1),
    actor_receipt:z.record(z.any()),reviewed_at:z.string().datetime({offset:true}).optional()
  },['social.write'],async input => toolResult({
    review:await recordReleaseFactor({...input,approved_at:input.reviewed_at ?? new Date().toISOString()}),
    authorization_created:false
  }));

  tool('evaluate_owner_approval_readiness','Check whether Agency, Director and Auditor all recorded PASS for the same client, ITEM_ID, version, fingerprint and destination. READY_FOR_OWNER_APPROVAL is not publication authorization: the owner must still approve the exact Publisher item, or explicitly register OWNER_OVERRIDE.',{
    client_slug:z.string(),item_id:z.string().min(1).max(180),content_version:z.number().int().positive(),
    content_hash:z.string().regex(/^[0-9a-f]{64}$/i),destination_id:z.string().min(1).max(240)
  },['social.read'],async input => toolResult(await evaluateOwnerApprovalReadiness(input)));

  tool('start_automatic_orchestration','Start or resume the persistent Automatic Council Orchestration state machine. It dispatches Agency OS, Director and Auditor actions without asking the owner to invoke plugins manually; it stops only for exact owner approval or a concrete blocker.',{
    client_slug:z.string(),item_id:z.string().min(1).max(180),content_version:z.number().int().positive(),
    max_correction_rounds:z.number().int().min(1).max(10).default(3)
  },['social.write'],async input => toolResult(await startAutomaticOrchestration(input)));

  tool('get_automatic_orchestration','Get the complete automatic orchestration run, actor queue, council and current content item.',{
    run_id:z.string().uuid()
  },['social.read'],async ({run_id}) => toolResult(await getAutomaticRunSnapshot(run_id)));

  tool('claim_next_actor_action','Claim the next pending action for one identified Oneforall actor. The orchestrator must call this automatically when the actor is available; the owner must not be asked to invoke the plugin.',{
    run_id:z.string().uuid(),actor:z.enum(['agency','director','auditor']),claimed_by:z.string().min(1).max(240)
  },['social.write'],async input => toolResult(await claimAutomaticAction(input)));

  tool('complete_actor_action','Persist the real result of a claimed Agency OS, Director or Auditor action and immediately advance the state machine. PASS continues, CORRECTIONS creates a Director revision action, and BLOCKED requires an exact blocker.',{
    action_id:z.string().uuid(),actor:z.enum(['agency','director','auditor']),
    completed_by:z.string().min(1).max(240),verdict:z.enum(['PASS','CORRECTIONS','BLOCKED']).optional(),result:z.record(z.any()).default({})
  },['social.write'],async input => toolResult(await completeAutomaticAction(input)));

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
  .then(() => ensureAutomationSchema())
  .then(() => ensureSupplySchema())
  .then(() => app.listen(port, () => {
    console.log(`Oneforall Social Manager ${VERSION} listening on ${port}`);
    if (SUPPLY_SCHEDULER_ENABLED) {
      runDueContentSupplyPolicies().catch(error => console.error('Initial content supply scheduler failed',error));
      const timer = setInterval(() => {
        runDueContentSupplyPolicies().catch(error => console.error('Content supply scheduler failed',error));
      },SUPPLY_SCHEDULER_INTERVAL_MS);
      timer.unref();
    }
  }))
  .catch(error => { console.error('Database schema initialization failed', error); process.exit(1); });

