import express from 'express';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createMcpExpressApp } from '@modelcontextprotocol/express';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
       scheduled_at,published_at,publisher_post_id,published_url,asset_ids,caption,source_idea_id,director_project_id,approval_receipt,metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21::jsonb,$22::jsonb)
    RETURNING *
  `, [input.client_slug,input.campaign ?? 'default',input.platform ?? 'instagram',input.format,input.pillar ?? null,
      input.title,input.idea ?? null,input.hook ?? null,input.objective ?? null,input.cta ?? null,input.status ?? 'idea',
      input.priority ?? 50,input.scheduled_at ?? null,input.published_at ?? null,input.publisher_post_id ?? null,
      input.published_url ?? null,JSON.stringify(input.asset_ids ?? []),input.caption ?? null,input.source_idea_id ?? null,
      input.director_project_id ?? null,JSON.stringify(input.approval_receipt ?? null),JSON.stringify(input.metadata ?? {})]);
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
      updated_at=now()
    WHERE id=$1 RETURNING *
  `,[id,toStatus,patch.scheduled_at ?? null,patch.published_at ?? null,patch.publisher_post_id ?? null,
     patch.published_url ?? null,patch.asset_ids ? JSON.stringify(patch.asset_ids) : null,patch.caption ?? null,
     patch.approval_receipt ? JSON.stringify(patch.approval_receipt) : null,JSON.stringify(patch.metadata ?? {})]);
  await query(`INSERT INTO content_events(content_id,event_type,from_status,to_status,actor,payload) VALUES($1,'status_changed',$2,$3,$4,$5::jsonb)`,
    [id,current.status,toStatus,actor,JSON.stringify(patch)]);
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
  const byStatus = Object.fromEntries(STATUSES.map(s => [s,0]));
  for (const row of counts) byStatus[row.status] = row.count;
  const replenish = plan ? future < plan.buffer_min : false;
  const replenish_count = plan && replenish ? Math.max(0, plan.buffer_target - future) : 0;
  return {client_slug,campaign,platform,plan,counts:byStatus,future_inventory:future,published_last_7_days:published7d,replenish,replenish_count};
}

app.get('/health', async (_req,res) => {
  try { await query('SELECT 1'); res.json({ok:true,service:'oneforall-social-manager',version:'0.2.0'}); }
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

function toolResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }

function buildMcpServer() {
  const server = new McpServer({ name: 'oneforall-social-manager', version: '0.2.0' });
  server.registerTool('get_social_dashboard',{
    description:'Get pipeline counts, weekly plan, future inventory and replenishment requirement',
    inputSchema:{client_slug:z.string(), campaign:z.string().default('default'), platform:z.string().default('instagram')}
  },async ({client_slug,campaign,platform}) => toolResult(await dashboard(client_slug,campaign,platform)));
  server.registerTool('set_social_plan',{
    description:'Create or update weekly publication plan and buffer thresholds',
    inputSchema:{
      client_slug:z.string(), campaign:z.string().default('default'), platform:z.string().default('instagram'),
      posts_per_week:z.number().int().positive(), buffer_min:z.number().int().nonnegative(), buffer_target:z.number().int().nonnegative(),
      format_mix:z.record(z.any()).optional(), pillar_mix:z.record(z.any()).optional(), preferred_slots:z.array(z.any()).optional(), active:z.boolean().optional()
    }
  },async input => toolResult(await upsertPlan(input)));
  server.registerTool('create_content_item',{
    description:'Register an idea or production item in the persistent editorial pipeline',
    inputSchema:{
      client_slug:z.string(),campaign:z.string().default('default'),platform:z.string().default('instagram'),
      format:z.enum(['image','carousel','reel','story','other']),title:z.string(),pillar:z.string().optional(),idea:z.string().optional(),hook:z.string().optional(),objective:z.string().optional(),cta:z.string().optional(),status:z.enum(STATUSES).optional(),priority:z.number().int().min(0).max(100).optional(),caption:z.string().optional(),asset_ids:z.array(z.string()).optional(),director_project_id:z.string().optional(),metadata:z.record(z.any()).optional()
    }
  },async input => toolResult(await createContent(input)));
  server.registerTool('transition_content_item',{
    description:'Change a content item state and record an immutable event',
    inputSchema:{
      content_id:z.string().uuid(),status:z.enum(STATUSES),actor:z.string().optional(),scheduled_at:z.string().optional(),published_at:z.string().optional(),publisher_post_id:z.string().optional(),published_url:z.string().optional(),asset_ids:z.array(z.string()).optional(),caption:z.string().optional(),approval_receipt:z.record(z.any()).optional(),metadata:z.record(z.any()).optional()
    }
  },async ({content_id,status,actor,...patch}) => toolResult(await transitionContent(content_id,status,actor,patch)));
  server.registerTool('list_content_items',{
    description:'List persistent content items by client and optional pipeline filters',
    inputSchema:{client_slug:z.string(),campaign:z.string().optional(),platform:z.string().optional(),status:z.enum(STATUSES).optional(),limit:z.number().int().min(1).max(500).default(100)}
  },async ({client_slug,campaign,platform,status,limit}) => {
    const where=['client_slug=$1']; const args=[client_slug];
    for (const [key,value] of [['campaign',campaign],['platform',platform],['status',status]]) if(value){args.push(value);where.push(`${key}=$${args.length}`)}
    args.push(limit);
    return toolResult(await query(`SELECT * FROM content_items WHERE ${where.join(' AND ')} ORDER BY COALESCE(scheduled_at,created_at) ASC LIMIT $${args.length}`,args));
  });
  return server;
}

app.post('/mcp', async (req,res) => {
  const server = buildMcpServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req,res,req.body);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Oneforall Social Manager listening on ${port}`));
