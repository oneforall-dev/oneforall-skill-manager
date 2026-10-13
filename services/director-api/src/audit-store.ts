import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./store.js";
import type { AuditJob } from "./types.js";

const auditRoot = path.join(dataDir, "audit-jobs");

export function auditJobId(itemId: string, directorContentVersion: number) {
  return createHash("sha256").update(`${itemId}:${directorContentVersion}`).digest("hex");
}

function jobPath(id: string) {
  if (!/^[0-9a-f]{64}$/.test(id)) throw Object.assign(new Error("Invalid audit job id"), { statusCode: 400 });
  return path.join(auditRoot, `${id}.json`);
}

export async function saveAuditJob(job: AuditJob) {
  await mkdir(auditRoot, { recursive: true });
  job.updatedAt = new Date().toISOString();
  const target = jobPath(job.id);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temp, target);
      lastError = undefined;
      break;
    } catch (error: any) {
      lastError = error;
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
  if (lastError) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw lastError;
  }
  return job;
}

export async function loadAuditJob(id: string): Promise<AuditJob> {
  try {
    return JSON.parse(await readFile(jobPath(id), "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") Object.assign(error, { statusCode: 404 });
    throw error;
  }
}

export async function loadAuditJobForVersion(itemId: string, directorContentVersion: number) {
  return loadAuditJob(auditJobId(itemId, directorContentVersion));
}

export async function listAuditJobs(): Promise<AuditJob[]> {
  await mkdir(auditRoot, { recursive: true });
  const entries = await readdir(auditRoot, { withFileTypes: true });
  const jobs = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => loadAuditJob(entry.name.slice(0, -5)).catch(() => null)));
  return jobs.filter((job): job is AuditJob => job !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
