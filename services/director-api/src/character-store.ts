import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./store.js";
import type { Character } from "./types.js";

const characterRoot = path.join(dataDir, "characters");

function validateCharacterId(characterId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(characterId)) {
    const error = new Error("Invalid CHARACTER_ID; use letters, numbers, underscores, or hyphens");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }
}

function characterPath(characterId: string) {
  validateCharacterId(characterId);
  return path.join(characterRoot, `${characterId}.json`);
}

export async function saveCharacter(character: Character) {
  await mkdir(characterRoot, { recursive: true });
  character.updatedAt = new Date().toISOString();
  const target = characterPath(character.characterId);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(character, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return character;
}

export async function loadCharacter(characterId: string): Promise<Character> {
  try {
    return JSON.parse(await readFile(characterPath(characterId), "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") Object.assign(error, { statusCode: 404 });
    throw error;
  }
}

export async function characterExists(characterId: string) {
  try {
    await loadCharacter(characterId);
    return true;
  } catch (error: any) {
    if (error?.statusCode === 404) return false;
    throw error;
  }
}

export async function searchCharacters(filters: { clientId?: string; query?: string; tags?: string[] }) {
  await mkdir(characterRoot, { recursive: true });
  const entries = await readdir(characterRoot, { withFileTypes: true });
  const characters = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => loadCharacter(entry.name.slice(0, -5)).catch(() => null)),
  );
  const query = filters.query?.trim().toLocaleLowerCase();
  const tags = (filters.tags || []).map((tag) => tag.toLocaleLowerCase());
  return characters
    .filter((character): character is Character => character !== null)
    .filter((character) => !filters.clientId || character.clientId === filters.clientId)
    .filter((character) => {
      if (!query) return true;
      const haystack = [character.characterId, character.name, character.description || "", ...character.aliases, ...character.tags].join(" ").toLocaleLowerCase();
      return haystack.includes(query);
    })
    .filter((character) => !tags.length || tags.every((tag) => character.tags.some((candidate) => candidate.toLocaleLowerCase() === tag)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
