import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Project } from "./types.js";

export const dataDir = path.resolve(process.env.DATA_DIR || "./data");

export function projectDir(id: string) {
  return path.join(dataDir, "projects", id);
}

export async function ensureProjectDirs(id: string) {
  const root = projectDir(id);
  await Promise.all([
    mkdir(path.join(root, "source"), { recursive: true }),
    mkdir(path.join(root, "work"), { recursive: true }),
    mkdir(path.join(root, "renders"), { recursive: true }),
  ]);
  return root;
}

export async function saveProject(project: Project) {
  const root = await ensureProjectDirs(project.id);
  project.updatedAt = new Date().toISOString();
  const target = path.join(root, "project.json");
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return project;
}

export async function loadProject(id: string): Promise<Project> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid project id");
  try {
    return JSON.parse(await readFile(path.join(projectDir(id), "project.json"), "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") Object.assign(error, { statusCode: 404 });
    throw error;
  }
}

export async function listProjects(): Promise<Project[]> {
  const root = path.join(dataDir, "projects");
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const projects = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => loadProject(entry.name).catch(() => null)),
  );
  return projects.filter((project): project is Project => Boolean(project)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
