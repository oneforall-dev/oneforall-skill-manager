import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./store.js";
import type { ContentItem } from "./types.js";

const contentRoot = path.join(dataDir, "content-items");

function validateItemId(itemId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(itemId)) {
    const error = new Error("Invalid ITEM_ID; use letters, numbers, underscores, or hyphens");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }
}

function itemPath(itemId: string) {
  validateItemId(itemId);
  return path.join(contentRoot, `${itemId}.json`);
}

export async function saveContentItem(item: ContentItem) {
  await mkdir(contentRoot, { recursive: true });
  item.updatedAt = new Date().toISOString();
  const target = itemPath(item.itemId);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(item, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return item;
}

export async function loadContentItem(itemId: string): Promise<ContentItem> {
  try {
    return JSON.parse(await readFile(itemPath(itemId), "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") Object.assign(error, { statusCode: 404 });
    throw error;
  }
}

export async function contentItemExists(itemId: string) {
  try {
    await loadContentItem(itemId);
    return true;
  } catch (error: any) {
    if (error?.statusCode === 404) return false;
    throw error;
  }
}

export async function listContentItems(clientId?: string): Promise<ContentItem[]> {
  await mkdir(contentRoot, { recursive: true });
  const entries = await readdir(contentRoot, { withFileTypes: true });
  const items = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => loadContentItem(entry.name.slice(0, -5)).catch(() => null)),
  );
  return items
    .filter((item): item is ContentItem => item !== null)
    .filter((item) => !clientId || item.clientId === clientId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
