import { createSign, randomUUID } from "node:crypto";
import { characterExists, loadCharacter, saveCharacter, searchCharacters } from "./character-store.js";
import type { Character, CharacterAssetRole } from "./types.js";

const folderMime = "application/vnd.google-apps.folder";

type DriveItem = { id: string; name: string; mimeType: string; webViewLink?: string };
type DriveImage = DriveItem & { folderNames: string[] };
type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

export type VaultScanResult = {
  startedAt: string;
  completedAt: string;
  source: "manual" | "automatic";
  clients: number;
  projects: number;
  people: number;
  charactersCreated: number;
  charactersUpdated: number;
  assetsAdded: number;
  assetsUpdated: number;
  assetsSkipped: number;
  warnings: string[];
};

let tokenCache: { accessToken: string; expiresAt: number } | undefined;
let scanPromise: Promise<VaultScanResult> | undefined;
let lastScan: VaultScanResult | undefined;

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON
    || (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_BASE64
      ? Buffer.from(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_BASE64, "base64").toString("utf8")
      : "");
  if (!raw) throw new Error("Google Drive scanner is not configured: missing service account JSON");
  const parsed = JSON.parse(raw) as ServiceAccount;
  if (!parsed.client_email || !parsed.private_key) throw new Error("Google Drive service account JSON is incomplete");
  return parsed;
}

async function accessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.accessToken;
  const oauthClientId = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
  const oauthRefreshToken = process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN;
  if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauthClientId,
        client_secret: oauthClientSecret,
        refresh_token: oauthRefreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) throw new Error(`Google OAuth refresh failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { access_token: string; expires_in?: number };
    tokenCache = { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
    return body.access_token;
  }
  const account = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: account.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const assertion = `${header}.${claim}.${base64url(signer.sign(account.private_key))}`;
  const response = await fetch(account.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error(`Google OAuth failed (${response.status}): ${await response.text()}`);
  const body = await response.json() as { access_token: string; expires_in?: number };
  tokenCache = { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return body.access_token;
}

export async function downloadDriveImage(fileId: string) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { authorization: `Bearer ${await accessToken()}` } },
  );
  if (!response.ok) {
    throw new Error(`Drive image download failed (${response.status}): ${await response.text()}`);
  }
  const mimeType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Drive file ${fileId} is not an image (${mimeType})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error(`Drive image ${fileId} is empty`);
  if (bytes.length > 50 * 1024 * 1024) throw new Error(`Drive image ${fileId} exceeds the 50 MB edit limit`);
  return { bytes, mimeType };
}

async function listChildren(parentId: string): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${parentId.replaceAll("'", "\\'")}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,webViewLink)",
      pageSize: "1000",
      orderBy: "name_natural",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    if (!response.ok) throw new Error(`Drive folder listing failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { files?: DriveItem[]; nextPageToken?: string };
    items.push(...(body.files || []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return items;
}

async function listImagesRecursively(folderId: string, folderNames: string[] = []): Promise<DriveImage[]> {
  const children = await listChildren(folderId);
  const nested = await Promise.all(children
    .filter((item) => item.mimeType === folderMime)
    .map((item) => listImagesRecursively(item.id, [...folderNames, item.name])));
  return [
    ...children.filter((item) => item.mimeType.startsWith("image/")).map((item) => ({ ...item, folderNames })),
    ...nested.flat(),
  ];
}

function slug(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

function characterId(client: string, project: string, person: string) {
  return [client, project, person].map(slug).filter(Boolean).join("-").slice(0, 120);
}

function classificationText(image: DriveImage) {
  return [...image.folderNames, image.name.replace(/\.[^.]+$/, "")]
    .join(" ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim();
}

function inferAssetRole(image: DriveImage): CharacterAssetRole {
  const value = classificationText(image);
  if (/\b(face lock|facelock|identity lock|identity reference)\b/.test(value)) return "FACE_LOCK";
  if (/\b(character sheet|char sheet|charsheet|turnaround|model sheet)\b/.test(value)) return "CHAR_SHEET";
  if (/\b(hero reference|hero ref|hero)\b/.test(value)) return "HERO_REFERENCE";
  if (/\b(expression|expressions)\b/.test(value)) return "EXPRESSION";
  if (/\b(outfit|wardrobe|look)\b/.test(value)) return "OUTFIT";
  if (/\b(pose|poses)\b/.test(value)) return "POSE";
  return "OTHER";
}

function canonicalSnapshot(character: Character) {
  return {
    name: character.name,
    aliases: character.aliases,
    description: character.description,
    identityTraits: character.identityTraits,
    lockedElements: character.lockedElements,
    negativeConstraints: character.negativeConstraints,
    tags: character.tags,
    relationships: character.relationships,
    driveFolderId: character.driveFolderId,
    approvedAssetIds: character.assets.filter((asset) => asset.approved).map((asset) => asset.id),
  };
}

async function importPerson(client: DriveItem, project: DriveItem, person: DriveItem, result: VaultScanResult) {
  const id = characterId(client.name, project.name, person.name);
  let character: Character;
  if (await characterExists(id)) {
    character = await loadCharacter(id);
    if (character.driveFolderId && character.driveFolderId !== person.id) {
      result.warnings.push(`Skipped ${client.name}/${project.name}/${person.name}: CHARACTER_ID collision (${id})`);
      return;
    }
    result.charactersUpdated += 1;
  } else {
    const now = new Date().toISOString();
    character = {
      characterId: id,
      clientId: client.name,
      name: person.name,
      aliases: [],
      status: "DRAFT",
      canonVersion: 0,
      identityTraits: {},
      lockedElements: [],
      negativeConstraints: [],
      tags: ["aidol", `project:${project.name}`],
      relationships: [],
      driveFolderId: person.id,
      driveFolderUrl: person.webViewLink || `https://drive.google.com/drive/folders/${person.id}`,
      assets: [],
      versions: [],
      createdAt: now,
      updatedAt: now,
    };
    result.charactersCreated += 1;
  }

  const existing = new Map(character.assets.map((asset) => [asset.driveFileId, asset]));
  for (const image of await listImagesRecursively(person.id)) {
    const inferredRole = inferAssetRole(image);
    const inferredApproved = inferredRole !== "OTHER";
    const current = existing.get(image.id);
    if (current) {
      if (current.role === "OTHER" && !current.approved && inferredApproved) {
        current.role = inferredRole;
        current.approved = true;
        current.tags = [...new Set([...current.tags, "auto-classified", `role:${inferredRole}`])];
        current.notes = `Auto-classified as ${inferredRole} from Drive filename or folder.`;
        current.updatedAt = new Date().toISOString();
        result.assetsUpdated += 1;
      } else {
        result.assetsSkipped += 1;
      }
      continue;
    }
    const now = new Date().toISOString();
    character.assets.push({
      id: randomUUID(),
      driveFileId: image.id,
      driveUrl: image.webViewLink || `https://drive.google.com/file/d/${image.id}/view`,
      name: image.name,
      mimeType: image.mimeType,
      role: inferredRole,
      tags: ["auto-imported", `project:${project.name}`, ...(inferredApproved ? ["auto-classified", `role:${inferredRole}`] : [])],
      notes: inferredApproved
        ? `Imported and auto-classified as ${inferredRole} from Drive filename or folder.`
        : "Imported automatically from Character Vault; pending review and classification.",
      approved: inferredApproved,
      createdAt: now,
      updatedAt: now,
    });
    result.assetsAdded += 1;
  }

  const hasApprovedFaceLock = character.assets.some((asset) => asset.approved && asset.role === "FACE_LOCK");
  if (hasApprovedFaceLock && character.canonVersion === 0) {
    const now = new Date().toISOString();
    const version = 1;
    character.versions.push({
      version,
      createdAt: now,
      createdBy: "Character Vault Scanner",
      summary: "Activated canonical character from automatically classified Drive references.",
      snapshot: canonicalSnapshot(character),
    });
    character.canonVersion = version;
    character.status = "ACTIVE";
  }
  await saveCharacter(character);
}

async function performScan(source: "manual" | "automatic") {
  const rootId = process.env.CHARACTER_VAULT_INBOX_FOLDER_ID;
  if (!rootId) throw new Error("Google Drive scanner is not configured: missing CHARACTER_VAULT_INBOX_FOLDER_ID");
  const startedAt = new Date().toISOString();
  const result: VaultScanResult = { startedAt, completedAt: startedAt, source, clients: 0, projects: 0, people: 0, charactersCreated: 0, charactersUpdated: 0, assetsAdded: 0, assetsUpdated: 0, assetsSkipped: 0, warnings: [] };
  const rootChildren = await listChildren(rootId);
  const clientsFolder = rootChildren.find((item) => item.mimeType === folderMime && item.name.toLowerCase() === "clients");
  const clientFolders = (clientsFolder ? await listChildren(clientsFolder.id) : rootChildren).filter((item) => item.mimeType === folderMime);
  result.clients = clientFolders.length;
  for (const client of clientFolders) {
    const projects = (await listChildren(client.id)).filter((item) => item.mimeType === folderMime);
    for (const project of projects) {
      const aidols = (await listChildren(project.id)).find((item) => item.mimeType === folderMime && item.name.toLowerCase() === "aidols");
      if (!aidols) continue;
      result.projects += 1;
      const people = (await listChildren(aidols.id)).filter((item) => item.mimeType === folderMime);
      result.people += people.length;
      for (const person of people) await importPerson(client, project, person, result);
    }
  }
  result.completedAt = new Date().toISOString();
  lastScan = result;
  return result;
}

export function scanCharacterVault(source: "manual" | "automatic" = "manual") {
  if (!scanPromise) scanPromise = performScan(source).finally(() => { scanPromise = undefined; });
  return scanPromise;
}

export function characterVaultScannerStatus() {
  const oauthConfigured = Boolean(
    process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID
    && process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET
    && process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN,
  );
  const serviceAccountConfigured = Boolean(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_BASE64);
  return {
    configured: Boolean((oauthConfigured || serviceAccountConfigured) && process.env.CHARACTER_VAULT_INBOX_FOLDER_ID),
    authentication: oauthConfigured ? "oauth" : serviceAccountConfigured ? "service_account" : "none",
    running: Boolean(scanPromise),
    intervalMinutes: Number(process.env.CHARACTER_VAULT_SCAN_INTERVAL_MINUTES || 15),
    lastScan,
  };
}

export function startCharacterVaultScanner() {
  const intervalMinutes = Number(process.env.CHARACTER_VAULT_SCAN_INTERVAL_MINUTES || 15);
  if (!characterVaultScannerStatus().configured || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return;
  const run = () => scanCharacterVault("automatic").catch((error) => console.error("Character Vault automatic scan failed", error));
  setTimeout(run, 5_000).unref();
  setInterval(run, intervalMinutes * 60_000).unref();
}
