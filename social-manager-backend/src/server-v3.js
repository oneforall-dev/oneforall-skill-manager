import express from 'express';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createMcpExpressApp } from '@modelcontextprotocol/express';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const VERSION = '0.4.0';
const STATUSES = [
  'idea','generated','in_production','produced','audit','needs_revision',
  'approved','scheduled','published','blocked','failed'
];

const app = createMcpExpressApp ? createMcpExpressApp() : express();
app.use(express.json({ limit: '2mb' }));

async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
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
      metadata=metadata || COALESCE($10::jsonb,'{}'::jsonb),
      google_calendar_id=COALESCE($11,google_calendar_id),
      google_calendar_event_id=COALESCE($12,google_calendar_event_id),
      calendar_sync_status=COALESCE($13,calendar_sync_status),
      updated_at=now()
    WHERE id=$1 RETURNING *
  `,[id,toStatus,patch.scheduled_at ?? null,patch.published_at ?? null,patch.publisher_post_id ?? null,
     patch.published_url ?? null,patch.asset_ids ? JSON.stringify(patch.asset_ids) : null,patch.caption ?? null,
     patch.approval_receipt ? JSON.stringify(patch.approval_receipt) : null,JSON.stringify(patch.metadata ?? {}),
     patch.google_calendar_id ?? null,patch.google_calendar_event_id ?? null,patch.calendar_sync_status ?? null]);
  await query(`INSERT INTO content_events(content_id,event_type,from_status,to_status,actor,payload) VALUES($1,'status_changed',$2,$3,$4,$5::jsonb)`,
    [id,current.status,toStatus,actor,JSON.stringify(patch)]);
  return rows[0];
}

async function linkCalendarEvent(contentId, input) {
  const current = (await query('SELECT * FROM content_items WHERE id=$1',[contentId]))[0];
  if (!current) throw new Error('Content item not found');
  const rows = await query(`
    UPDATE content_items SET
      google_calendar_id=$2,
      google_calendar_event_id=$3,
      calendar_sync_status=$4,
      updated_at=now()
    WHERE id=$1 RETURNING *
  `,[contentId,input.google_calendar_id,input.google_calendar_event_id,input.calendar_sync_status ?? 'linked']);
  await query(`INSERT INTO content_events(content_id,event_type,from_status,to_status,actor,payload)
               VALUES($1,'calendar_linked',$2,$2,$3,$4::jsonb)`,
    [contentId,current.status,input.actor ?? 'social-manager',JSON.stringify(input)]);
  return rows[0];
}

async function dashboard(client_slug, campaign='default', platform='instagram') {
  const counts = await query(`
    SELECT status, count(*)::int AS count
    FROM content_items
    WHERE client_slug=$1 AND campaign=$2 AND platform=$3
    GROUP BY status
  `,[client_slug,campaign,platform]);
  const plan = (await query(`SELECT * FROM social_plans WHERE client_slug=$1 AND campaign=$2 AND platform=$3 AND active=true`,[client_slug,campaign,platform]))[0] ?? null;
  const future = (await query(`
    SELECT count(*)::int AS count
    FROM content_items
    WHERE client_slug=$1 AND campaign=$2 AND platform=$3
      AND status IN ('approved','scheduled')
      AND (scheduled_at IS NULL OR scheduled_at >= now())
  `,[client_slug,campaign,platform]))[0].count;
  const published7d = (await query(`
    SELECT count(*)::int AS count FROM content_items
    WHERE client_slug=$1 AND campaign=$2 AND platform=$3
      AND status='published' AND published_at >= now() - interval '7 days'
  `,[client_slug,campaign,platform]))[0].count;
  const calendar = (await query(`SELECT * FROM client_calendars WHERE client_slug=$1`,[client_slug]))[0] ?? null;
  const byStatus = Object.fromEntries(STATUSES.map(s => [s,0]));
  for (const row of counts) byStatus[row.status] = row.count;
  const replenish = plan ? future < plan.buffer_min : false;
  const replenish_count = plan && replenish ? Math.max(0, plan.buffer_target - future) : 0;
  return {client_slug,campaign,platform,plan,calendar,counts:byStatus,future_inventory:future,published_last_7_days:published7d,replenish,replenish_count};
}

async function getClientCalendar(clientSlug) {
  return (await query('SELECT * FROM client_calendars WHERE client_slug=$1',[clientSlug]))[0] ?? null;
}

async function storeClientCalendar({client_slug,google_calendar_id,calendar_name,timezone='America/Bogota',source='google-calendar'}) {
  const rows = await query(`
    INSERT INTO client_calendars(client_slug,google_calendar_id,calendar_name,timezone,source,updated_at)
    VALUES($1,$2,$3,$4,$5,now())
    ON CONFLICT(client_slug) DO UPDATE SET
      google_calendar_id=EXCLUDED.google_calendar_id,
      calendar_name=EXCLUDED.calendar_name,
      timezone=EXCLUDED.timezone,
      source=EXCLUDED.source,
      updated_at=now()
    RETURNING *
  `,[client_slug,google_calendar_id,calendar_name,timezone,source]);
  return rows[0];
}

async function googleAccessToken() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    const error = new Error('Google Calendar creation is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN with Calendar scope.');
    error.code = 'GOOGLE_OAUTH_NOT_CONFIGURED';
    throw error;
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({
      client_id:GOOGLE_CLIENT_ID,
      client_secret:GOOGLE_CLIENT_SECRET,
      refresh_token:GOOGLE_REFRESH_TOKEN,
      grant_type:'refresh_token'
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Google OAuth refresh failed: ${data.error_description ?? data.error ?? response.status}`);
  return data.access_token;
}

async function ensureClientCalendar(input) {
  const existing = await getClientCalendar(input.client_slug);
  if (existing && !input.force_new) return {created:false,calendar:existing};

  const token = await googleAccessToken();
  const calendarName = input.calendar_name ?? `Social — ${input.client_slug}`;
  const timezone = input.timezone ?? 'America/Bogota';
  const response = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
    method:'POST',
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify({
      summary:calendarName,
      description:input.description ?? `Oneforall Social Manager calendar for ${input.client_slug}`,
      timeZone:timezone
    })
  });
  const data = await response.json();
  if (!response.ok || !data.id) throw new Error(`Google Calendar creation failed: ${data.error?.message ?? response.status}`);
  const calendar = await storeClientCalendar({
    client_slug:input.client_slug,
    google_calendar_id:data.id,
    calendar_name:data.summary ?? calendarName,
    timezone:data.timeZone ?? timezone,
    source:'oneforall-google-api'
  });
  return {created:true,calendar};
}

app.get('/health', async (_req,res) => {
  try { await query('SELECT 1'); res.json({ok:true,service:'oneforall-social-manager',version:VERSION}); }
  catch (e) { res.status(503).json({ok:false,error:e.message}); }
});

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

function toolResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }

function buildMcpServer() {
  const server = new McpServer({ name: 'oneforall-social-manager', version: VERSION });
  server.tool('get_social_dashboard','Get pipeline counts, plan, future inventory, client calendar mapping and replenishment requirement',{
    client_slug:z.string(), campaign:z.string().default('default'), platform:z.string().default('instagram')
  },async ({client_slug,campaign,platform}) => toolResult(await dashboard(client_slug,campaign,platform)));

  server.tool('set_social_plan','Create or update weekly publication plan and buffer thresholds',{
    client_slug:z.string(), campaign:z.string().default('default'), platform:z.string().default('instagram'),
    posts_per_week:z.number().int().positive(), buffer_min:z.number().int().nonnegative(), buffer_target:z.number().int().nonnegative(),
    format_mix:z.record(z.any()).optional(), pillar_mix:z.record(z.any()).optional(), preferred_slots:z.array(z.any()).optional(), active:z.boolean().optional()
  },async input => toolResult(await upsertPlan(input)));

  server.tool('create_content_item','Register an idea or production item in the persistent editorial pipeline',{
    client_slug:z.string(),campaign:z.string().default('default'),platform:z.string().default('instagram'),
    format:z.enum(['image','carousel','reel','story','other']),title:z.string(),pillar:z.string().optional(),idea:z.string().optional(),hook:z.string().optional(),objective:z.string().optional(),cta:z.string().optional(),status:z.enum(STATUSES).optional(),priority:z.number().int().min(0).max(100).optional(),caption:z.string().optional(),asset_ids:z.array(z.string()).optional(),director_project_id:z.string().optional(),google_calendar_id:z.string().optional(),google_calendar_event_id:z.string().optional(),calendar_sync_status:z.string().optional(),metadata:z.record(z.any()).optional()
  },async input => toolResult(await createContent(input)));

  server.tool('transition_content_item','Change a content item state and record an immutable event',{
    content_id:z.string().uuid(),status:z.enum(STATUSES),actor:z.string().optional(),scheduled_at:z.string().optional(),published_at:z.string().optional(),publisher_post_id:z.string().optional(),published_url:z.string().optional(),asset_ids:z.array(z.string()).optional(),caption:z.string().optional(),approval_receipt:z.record(z.any()).optional(),google_calendar_id:z.string().optional(),google_calendar_event_id:z.string().optional(),calendar_sync_status:z.string().optional(),metadata:z.record(z.any()).optional()
  },async ({content_id,status,actor,...patch}) => toolResult(await transitionContent(content_id,status,actor,patch)));

  server.tool('list_content_items','List persistent content items by client and optional pipeline filters',{
    client_slug:z.string(),campaign:z.string().optional(),platform:z.string().optional(),status:z.enum(STATUSES).optional(),limit:z.number().int().min(1).max(500).default(100)
  },async ({client_slug,campaign,platform,status,limit}) => {
    const where=['client_slug=$1']; const args=[client_slug];
    for (const [key,value] of [['campaign',campaign],['platform',platform],['status',status]]) if(value){args.push(value);where.push(`${key}=$${args.length}`)}
    args.push(limit);
    return toolResult(await query(`SELECT * FROM content_items WHERE ${where.join(' AND ')} ORDER BY COALESCE(scheduled_at,created_at) ASC LIMIT $${args.length}`,args));
  });

  server.tool('get_client_calendar','Get the Google Calendar mapped to a Social Manager client',{
    client_slug:z.string()
  },async ({client_slug}) => toolResult({calendar:await getClientCalendar(client_slug)}));

  server.tool('register_client_calendar','Store a Google Calendar ID already created or selected through the connected Google Calendar capability',{
    client_slug:z.string(),google_calendar_id:z.string(),calendar_name:z.string(),timezone:z.string().default('America/Bogota'),source:z.string().default('google-calendar')
  },async input => toolResult(await storeClientCalendar(input)));

  server.tool('ensure_client_calendar','Create and persist one Google Calendar for a client when no mapping exists. Requires Google OAuth environment credentials on the backend.',{
    client_slug:z.string(),calendar_name:z.string().optional(),timezone:z.string().default('America/Bogota'),description:z.string().optional(),force_new:z.boolean().default(false)
  },async input => toolResult(await ensureClientCalendar(input)));

  server.tool('link_calendar_event','Link a Google Calendar event to one persistent content item',{
    content_id:z.string().uuid(),google_calendar_id:z.string(),google_calendar_event_id:z.string(),calendar_sync_status:z.string().default('linked'),actor:z.string().default('social-manager')
  },async ({content_id,...input}) => toolResult(await linkCalendarEvent(content_id,input)));

  return server;
}

app.post('/mcp', async (req,res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req,res,req.body);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Oneforall Social Manager ${VERSION} listening on ${port}`));
