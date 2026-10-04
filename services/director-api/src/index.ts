import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { analyze, buildPlan, render } from "./media.js";
import { ensureProjectDirs, listProjects, loadProject, saveProject } from "./store.js";
import { contentItemExists, listContentItems, loadContentItem, saveContentItem } from "./content-store.js";
import { characterExists, loadCharacter, saveCharacter, searchCharacters } from "./character-store.js";
import { characterVaultScannerStatus, scanCharacterVault, startCharacterVaultScanner } from "./character-vault-scanner.js";
import type { Character, CharacterAssetRole, ContentItem, ContentStatus, Project } from "./types.js";

const app = express();
const port = Number(process.env.PORT || 2800);
app.use(express.json({ limit: "2mb" }));

const createSchema = z.object({ name: z.string().trim().min(1).max(160), sourceUrl: z.string().url().optional() });
const contentStatuses = ["DRAFT", "IN_PRODUCTION", "READY_FOR_AUDIT", "APPROVED", "CORRECTION_REQUIRED", "REJECTED", "FAILED", "SUPERSEDED", "DO_NOT_PUBLISH"] as const;
const createContentSchema = z.object({
  itemId: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  clientId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  format: z.string().trim().min(1).max(80),
  objective: z.string().max(4000).optional(),
  context: z.string().max(12000).optional(),
  lockedElements: z.array(z.string().min(1).max(500)).max(100).default([]),
});
const updateContentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  format: z.string().trim().min(1).max(80).optional(),
  objective: z.string().max(4000).optional(),
  context: z.string().max(12000).optional(),
  status: z.enum(contentStatuses).optional(),
  lockedElements: z.array(z.string().min(1).max(500)).max(100).optional(),
});
const versionSchema = z.object({
  createdBy: z.string().trim().min(1).max(120).default("Oneforall Director"),
  summary: z.string().trim().min(1).max(4000),
  package: z.record(z.string(), z.unknown()),
  status: z.enum(contentStatuses).default("IN_PRODUCTION"),
});
const specialistCallSchema = z.object({
  specialist: z.string().trim().min(1).max(160),
  action: z.string().trim().min(1).max(160),
  task: z.string().trim().min(1).max(6000),
  context: z.string().max(12000).optional(),
  lockedElements: z.array(z.string().min(1).max(500)).max(100).default([]),
  expectedOutput: z.string().trim().min(1).max(6000),
  returnTo: z.string().trim().min(1).max(160).default("@Oneforall Director"),
  contentVersion: z.number().int().positive().optional(),
});
const specialistResultSchema = z.object({
  callId: z.string().uuid(),
  result: z.record(z.string(), z.unknown()),
});
const handoffSchema = z.object({
  targetNick: z.string().trim().min(1).max(160),
  targetPlugin: z.string().trim().min(1).max(200),
  action: z.string().trim().min(1).max(160),
  context: z.string().max(12000),
  expectedOutput: z.string().trim().min(1).max(6000),
  returnTo: z.string().max(200).optional(),
  attempt: z.number().int().positive().default(1),
  approvalReceipt: z.string().max(1000).optional(),
  dependencies: z.array(z.string().min(1).max(500)).max(100).default([]),
  contentVersion: z.number().int().positive().optional(),
});
const characterAssetRoles = ["FACE_LOCK", "HERO_REFERENCE", "OUTFIT", "POSE", "EXPRESSION", "APPROVED_RENDER", "REJECTED", "OTHER"] as const;
const createCharacterSchema = z.object({
  characterId: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  clientId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  description: z.string().max(6000).optional(),
  identityTraits: z.record(z.string(), z.unknown()).default({}),
  lockedElements: z.array(z.string().min(1).max(500)).max(200).default([]),
  negativeConstraints: z.array(z.string().min(1).max(500)).max(200).default([]),
  tags: z.array(z.string().min(1).max(120)).max(200).default([]),
  relationships: z.array(z.string().min(1).max(200)).max(200).default([]),
  driveFolderId: z.string().max(300).optional(),
  driveFolderUrl: z.string().url().optional(),
});
const updateCharacterSchema = createCharacterSchema.omit({ characterId: true, clientId: true }).partial().extend({
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
});
const characterAssetSchema = z.object({
  driveFileId: z.string().trim().min(1).max(300),
  driveUrl: z.string().url(),
  name: z.string().trim().min(1).max(300),
  mimeType: z.string().max(200).optional(),
  role: z.enum(characterAssetRoles).default("OTHER"),
  tags: z.array(z.string().min(1).max(120)).max(200).default([]),
  notes: z.string().max(4000).optional(),
  approved: z.boolean().default(false),
});
const updateCharacterAssetSchema = characterAssetSchema.omit({ driveFileId: true, driveUrl: true }).partial();
const characterVersionSchema = z.object({
  createdBy: z.string().trim().min(1).max(160).default("Oneforall Director"),
  summary: z.string().trim().min(1).max(4000),
});
const summary = (project: Project) => ({
  id: project.id,
  name: project.name,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  status: project.status,
  sourceFile: project.sourceFile,
  sourceUrl: project.sourceUrl,
  duration: project.duration,
  width: project.width,
  height: project.height,
  fps: project.fps,
  latestVersion: project.latestVersion,
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "oneforall-director-api" }));
app.get("/api/projects", async (_req, res, next) => {
  try { res.json({ projects: (await listProjects()).map(summary) }); } catch (error) { next(error); }
});
app.post("/api/projects", async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    const now = new Date().toISOString();
    const project: Project = { id: randomUUID(), name: input.name, sourceUrl: input.sourceUrl, createdAt: now, updatedAt: now, status: "created", silences: [], transcript: { text: "", segments: [] }, versions: [], latestVersion: 0, feedback: [] };
    await ensureProjectDirs(project.id);
    await saveProject(project);
    res.status(201).json(project);
  } catch (error) { next(error); }
});
app.get("/api/projects/:id", async (req, res, next) => {
  try { res.json(await loadProject(req.params.id)); } catch (error) { next(error); }
});
app.post("/api/projects/:id/analyze", async (req, res, next) => {
  let project: Project | undefined;
  try {
    project = await loadProject(req.params.id);
    project.status = "analyzing"; project.error = undefined; await saveProject(project);
    res.json(await analyze(project));
  } catch (error: any) {
    if (project) { project.status = "error"; project.error = error?.message || String(error); await saveProject(project).catch(() => {}); }
    next(error);
  }
});
app.post("/api/projects/:id/plan", async (req, res, next) => {
  try {
    const project = await loadProject(req.params.id);
    project.editPlan = buildPlan(project); project.status = "planned"; await saveProject(project);
    res.json({ projectId: project.id, editPlan: project.editPlan });
  } catch (error) { next(error); }
});
app.post("/api/projects/:id/render", async (req, res, next) => {
  let project: Project | undefined;
  try {
    project = await loadProject(req.params.id); project.status = "rendering"; await saveProject(project);
    res.status(201).json({ projectId: project.id, version: await render(project, false) });
  } catch (error: any) {
    if (project) { project.status = "error"; project.error = error?.message || String(error); await saveProject(project).catch(() => {}); }
    next(error);
  }
});
app.post("/api/projects/:id/revise", async (req, res, next) => {
  let project: Project | undefined;
  try {
    project = await loadProject(req.params.id); project.status = "rendering"; await saveProject(project);
    res.status(201).json({ projectId: project.id, version: await render(project, true) });
  } catch (error: any) {
    if (project) { project.status = "error"; project.error = error?.message || String(error); await saveProject(project).catch(() => {}); }
    next(error);
  }
});

app.get("/api/content-items", async (req, res, next) => {
  try {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    res.json({ items: await listContentItems(clientId) });
  } catch (error) { next(error); }
});

app.post("/api/content-items", async (req, res, next) => {
  try {
    const input = createContentSchema.parse(req.body);
    if (await contentItemExists(input.itemId)) {
      return res.status(409).json({ error: `ITEM_ID ${input.itemId} already exists` });
    }
    const now = new Date().toISOString();
    const item: ContentItem = {
      itemId: input.itemId,
      clientId: input.clientId,
      title: input.title,
      format: input.format,
      objective: input.objective,
      context: input.context,
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
      currentVersion: 0,
      lockedElements: input.lockedElements,
      versions: [],
      specialistCalls: [],
      handoffs: [],
    };
    await saveContentItem(item);
    res.status(201).json(item);
  } catch (error) { next(error); }
});

app.get("/api/content-items/:itemId", async (req, res, next) => {
  try { res.json(await loadContentItem(req.params.itemId)); } catch (error) { next(error); }
});

app.patch("/api/content-items/:itemId", async (req, res, next) => {
  try {
    const item = await loadContentItem(req.params.itemId);
    Object.assign(item, updateContentSchema.parse(req.body));
    await saveContentItem(item);
    res.json(item);
  } catch (error) { next(error); }
});

app.post("/api/content-items/:itemId/versions", async (req, res, next) => {
  try {
    const item = await loadContentItem(req.params.itemId);
    const input = versionSchema.parse(req.body);
    const version = item.currentVersion + 1;
    item.versions.push({ version, createdAt: new Date().toISOString(), createdBy: input.createdBy, summary: input.summary, package: input.package });
    item.currentVersion = version;
    item.status = input.status as ContentStatus;
    await saveContentItem(item);
    res.status(201).json({ itemId: item.itemId, contentVersion: version, status: item.status, version: item.versions.at(-1) });
  } catch (error) { next(error); }
});

app.post("/api/content-items/:itemId/specialist-calls", async (req, res, next) => {
  try {
    const item = await loadContentItem(req.params.itemId);
    const input = specialistCallSchema.parse(req.body);
    const call = { id: randomUUID(), ...input, contentVersion: input.contentVersion || item.currentVersion, status: "REQUESTED" as const, createdAt: new Date().toISOString() };
    item.specialistCalls.push(call);
    await saveContentItem(item);
    res.status(201).json({ itemId: item.itemId, specialistCall: call });
  } catch (error) { next(error); }
});

app.post("/api/content-items/:itemId/specialist-results", async (req, res, next) => {
  try {
    const item = await loadContentItem(req.params.itemId);
    const input = specialistResultSchema.parse(req.body);
    const call = item.specialistCalls.find((candidate) => candidate.id === input.callId);
    if (!call) return res.status(404).json({ error: `Specialist call ${input.callId} not found` });
    call.status = "COMPLETE";
    call.completedAt = new Date().toISOString();
    call.result = input.result;
    await saveContentItem(item);
    res.json({ itemId: item.itemId, specialistCall: call, returnTo: call.returnTo });
  } catch (error) { next(error); }
});

app.post("/api/content-items/:itemId/handoffs", async (req, res, next) => {
  try {
    const item = await loadContentItem(req.params.itemId);
    const input = handoffSchema.parse(req.body);
    const handoff = { id: randomUUID(), ...input, contentVersion: input.contentVersion || item.currentVersion, createdAt: new Date().toISOString() };
    item.handoffs.push(handoff);
    if (/auditor/i.test(input.targetPlugin) || /CHECK/i.test(input.targetNick)) item.status = "READY_FOR_AUDIT";
    await saveContentItem(item);
    res.status(201).json({ itemId: item.itemId, status: item.status, handoff });
  } catch (error) { next(error); }
});

app.get("/api/characters", async (req, res, next) => {
  try {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    const query = typeof req.query.query === "string" ? req.query.query : undefined;
    const tags = typeof req.query.tags === "string" ? req.query.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : undefined;
    res.json({ characters: await searchCharacters({ clientId, query, tags }) });
  } catch (error) { next(error); }
});

app.post("/api/characters", async (req, res, next) => {
  try {
    const input = createCharacterSchema.parse(req.body);
    if (await characterExists(input.characterId)) return res.status(409).json({ error: `CHARACTER_ID ${input.characterId} already exists` });
    const now = new Date().toISOString();
    const character: Character = { ...input, status: "DRAFT", canonVersion: 0, assets: [], versions: [], createdAt: now, updatedAt: now };
    await saveCharacter(character);
    res.status(201).json(character);
  } catch (error) { next(error); }
});

app.get("/api/characters/:characterId", async (req, res, next) => {
  try { res.json(await loadCharacter(req.params.characterId)); } catch (error) { next(error); }
});

app.patch("/api/characters/:characterId", async (req, res, next) => {
  try {
    const character = await loadCharacter(req.params.characterId);
    Object.assign(character, updateCharacterSchema.parse(req.body));
    await saveCharacter(character);
    res.json(character);
  } catch (error) { next(error); }
});

app.post("/api/characters/:characterId/assets", async (req, res, next) => {
  try {
    const character = await loadCharacter(req.params.characterId);
    const input = characterAssetSchema.parse(req.body);
    const duplicate = character.assets.find((asset) => asset.driveFileId === input.driveFileId);
    if (duplicate) return res.status(409).json({ error: `Drive file ${input.driveFileId} is already attached`, asset: duplicate });
    const now = new Date().toISOString();
    const asset = { id: randomUUID(), ...input, role: input.role as CharacterAssetRole, createdAt: now, updatedAt: now };
    character.assets.push(asset);
    await saveCharacter(character);
    res.status(201).json({ characterId: character.characterId, asset });
  } catch (error) { next(error); }
});

app.patch("/api/characters/:characterId/assets/:assetId", async (req, res, next) => {
  try {
    const character = await loadCharacter(req.params.characterId);
    const asset = character.assets.find((candidate) => candidate.id === req.params.assetId);
    if (!asset) return res.status(404).json({ error: `Asset ${req.params.assetId} not found` });
    Object.assign(asset, updateCharacterAssetSchema.parse(req.body), { updatedAt: new Date().toISOString() });
    await saveCharacter(character);
    res.json({ characterId: character.characterId, asset });
  } catch (error) { next(error); }
});

app.post("/api/characters/:characterId/versions", async (req, res, next) => {
  try {
    const character = await loadCharacter(req.params.characterId);
    const input = characterVersionSchema.parse(req.body);
    const version = character.canonVersion + 1;
    const snapshot = { name: character.name, aliases: character.aliases, description: character.description, identityTraits: character.identityTraits, lockedElements: character.lockedElements, negativeConstraints: character.negativeConstraints, tags: character.tags, relationships: character.relationships, driveFolderId: character.driveFolderId, approvedAssetIds: character.assets.filter((asset) => asset.approved).map((asset) => asset.id) };
    character.versions.push({ version, createdAt: new Date().toISOString(), createdBy: input.createdBy, summary: input.summary, snapshot });
    character.canonVersion = version;
    character.status = "ACTIVE";
    await saveCharacter(character);
    res.status(201).json({ characterId: character.characterId, canonVersion: version, status: character.status, version: character.versions.at(-1) });
  } catch (error) { next(error); }
});

app.get("/api/character-vault/scanner", (_req, res) => res.json(characterVaultScannerStatus()));

app.post("/api/character-vault/scan", async (_req, res, next) => {
  try { res.json(await scanCharacterVault("manual")); } catch (error) { next(error); }
});

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = error?.statusCode || (error instanceof z.ZodError ? 400 : 500);
  res.status(status).json({ error: error?.message || "Internal server error", details: error instanceof z.ZodError ? error.issues : undefined });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Oneforall Director API listening on ${port}`);
  startCharacterVaultScanner();
});
