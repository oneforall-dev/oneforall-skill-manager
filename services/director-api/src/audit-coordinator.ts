import { auditJobId, listAuditJobs, loadAuditJobForVersion, saveAuditJob } from "./audit-store.js";
import { buildAuditPackage, createPublisherReceipt, executeAuditor, signPublisherReceipt } from "./auditor.js";
import { listContentItems, loadContentItem, saveContentItem } from "./content-store.js";
import { getPublisherContentItem, registerPublisherAuditReceipt } from "./publisher-client.js";
import { syncSocialManagerAudit } from "./social-manager-client.js";
import type { AuditJob, AuditResult, ContentItem } from "./types.js";

type Dependencies = {
  loadItem: typeof loadContentItem;
  saveItem: typeof saveContentItem;
  listItems: typeof listContentItems;
  getPublisherItem: typeof getPublisherContentItem;
  runAuditor: typeof executeAuditor;
  registerReceipt: typeof registerPublisherAuditReceipt;
  syncManager: typeof syncSocialManagerAudit;
  now: () => Date;
};

const defaults: Dependencies = {
  loadItem: loadContentItem,
  saveItem: saveContentItem,
  listItems: listContentItems,
  getPublisherItem: getPublisherContentItem,
  runAuditor: executeAuditor,
  registerReceipt: registerPublisherAuditReceipt,
  syncManager: syncSocialManagerAudit,
  now: () => new Date(),
};

const active = new Set<string>();
const creating = new Map<string, Promise<AuditJob>>();
let timer: NodeJS.Timeout | undefined;

function sanitizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .slice(0, 2000);
}

function isPermanent(error: unknown) {
  return Boolean((error as any)?.permanent) || /mismatch|missing|invalid|not configured|required/i.test(sanitizeError(error));
}

async function syncManagerResult(job: AuditJob, result: AuditResult, deps: Dependencies) {
  try {
    await deps.syncManager(job.clientId, job.itemId, result);
    result.socialManagerSyncStatus = "SYNCED";
    result.socialManagerSyncError = undefined;
  } catch (error) {
    result.socialManagerSyncStatus = "FAILED";
    result.socialManagerSyncError = sanitizeError(error);
  }
}

export async function ensureAuditJob(item: ContentItem) {
  if (item.currentVersion < 1) throw new Error("Cannot audit an item without a content version");
  const id = auditJobId(item.itemId, item.currentVersion);
  const existing = creating.get(id);
  if (existing) return existing;
  const creation = (async () => {
    try {
      return await loadAuditJobForVersion(item.itemId, item.currentVersion);
    } catch (error: any) {
      if (error?.statusCode !== 404) throw error;
    }
    const now = new Date().toISOString();
    return saveAuditJob({
      id,
      itemId: item.itemId,
      clientId: item.clientId,
      directorContentVersion: item.currentVersion,
      status: "QUEUED",
      attempt: 0,
      maxAttempts: Number(process.env.AUDITOR_MAX_ATTEMPTS || 3),
      createdAt: now,
      updatedAt: now,
    });
  })();
  creating.set(id, creation);
  try { return await creation; } finally { creating.delete(id); }
}

export async function processAuditJob(job: AuditJob, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  if (active.has(job.id)) return job;
  if (job.status === "COMPLETED" || job.status === "BLOCKED") return job;
  if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > deps.now().getTime()) return job;
  active.add(job.id);
  try {
    job.status = "RUNNING";
    job.attempt += 1;
    job.startedAt = deps.now().toISOString();
    job.lastError = undefined;
    await saveAuditJob(job);

    const item = await deps.loadItem(job.itemId);
    if (item.currentVersion !== job.directorContentVersion) {
      throw Object.assign(new Error(`Audit job is stale: job version ${job.directorContentVersion}, current ${item.currentVersion}`), { permanent: true });
    }
    if (item.status !== "READY_FOR_AUDIT") {
      throw Object.assign(new Error(`Item is not READY_FOR_AUDIT (current: ${item.status})`), { permanent: true });
    }
    const publisher = await deps.getPublisherItem(item.clientId, item.itemId);
    const auditPackage = buildAuditPackage(item, publisher);
    const audited = await deps.runAuditor(auditPackage);
    const currentItem = await deps.loadItem(job.itemId);
    if (currentItem.currentVersion !== job.directorContentVersion || currentItem.status !== "READY_FOR_AUDIT") {
      throw Object.assign(new Error("Content changed while Auditor was running; the result is stale and cannot be applied"), { permanent: true });
    }
    const currentPublisher = await deps.getPublisherItem(currentItem.clientId, currentItem.itemId);
    if (currentPublisher.content_version !== auditPackage.publisherContentVersion || currentPublisher.content_hash !== auditPackage.publisherContentHash) {
      throw Object.assign(new Error("Publisher content changed while Auditor was running; the result is stale and cannot be applied"), { permanent: true });
    }
    const auditedAt = deps.now().toISOString();
    const auditorIdentity = process.env.AUDITOR_IDENTITY || "Oneforall Auditor backend";
    const result: AuditResult = {
      auditId: `director-${job.id.slice(0, 24)}`,
      auditorIdentity,
      directorContentVersion: item.currentVersion,
      publisherContentVersion: publisher.content_version,
      publisherContentHash: publisher.content_hash,
      verdict: audited.verdict,
      summary: audited.summary,
      findings: audited.findings,
      auditedAt,
      publisherReceiptStatus: "NOT_REQUIRED",
    };

    if (audited.verdict === "CORRECTIONS") {
      currentItem.status = "CORRECTION_REQUIRED";
      currentItem.auditResults = [...(currentItem.auditResults || []), result];
      await deps.saveItem(currentItem);
      await syncManagerResult(job, result, deps);
      job.result = result;
      job.status = "COMPLETED";
      job.completedAt = auditedAt;
      return await saveAuditJob(job);
    }

    if (publisher.audit_required || process.env.AUDITOR_RECEIPT_HMAC_SECRET) {
      try {
        const { receipt, secret } = createPublisherReceipt(auditPackage, auditorIdentity, auditedAt);
        receipt.audit_id = result.auditId;
        const signature = signPublisherReceipt(receipt, secret);
        await deps.registerReceipt(receipt, signature);
        result.publisherReceiptStatus = "REGISTERED";
      } catch (error: any) {
        result.publisherReceiptStatus = error?.missingReceiptAuth ? "BLOCKED_MISSING_AUTH" : "FAILED";
        result.publisherReceiptError = sanitizeError(error);
        currentItem.auditResults = [...(currentItem.auditResults || []), result];
        await deps.saveItem(currentItem);
        job.result = result;
        job.status = "BLOCKED";
        job.completedAt = auditedAt;
        job.lastError = result.publisherReceiptError;
        return await saveAuditJob(job);
      }
    }

    currentItem.auditResults = [...(currentItem.auditResults || []), result];
    await deps.saveItem(currentItem);
    await syncManagerResult(job, result, deps);
    job.result = result;
    job.status = "COMPLETED";
    job.completedAt = auditedAt;
    return await saveAuditJob(job);
  } catch (error) {
    job.lastError = sanitizeError(error);
    if (isPermanent(error) || job.attempt >= job.maxAttempts) {
      job.status = "BLOCKED";
      job.completedAt = deps.now().toISOString();
    } else {
      job.status = "RETRY_WAIT";
      const base = Number(process.env.AUDITOR_RETRY_BASE_MS || 30_000);
      job.nextAttemptAt = new Date(deps.now().getTime() + base * 2 ** (job.attempt - 1)).toISOString();
    }
    return await saveAuditJob(job);
  } finally {
    active.delete(job.id);
  }
}

export async function auditWorkerPass() {
  if (process.env.AUDITOR_BACKFILL_READY === "true") {
    const items = await listContentItems();
    for (const item of items.filter((candidate) => candidate.status === "READY_FOR_AUDIT" && candidate.currentVersion > 0)) {
      await ensureAuditJob(item);
    }
  }
  const jobs = await listAuditJobs();
  for (const job of jobs.filter((candidate) => ["QUEUED", "RETRY_WAIT"].includes(candidate.status))) {
    await processAuditJob(job);
  }
  for (const job of jobs.filter((candidate) => candidate.status === "COMPLETED" && candidate.result?.socialManagerSyncStatus === "FAILED")) {
    await syncManagerResult(job, job.result!, defaults);
    await saveAuditJob(job);
  }
}

export function startAuditWorker() {
  if (timer) return;
  const intervalMs = Number(process.env.AUDITOR_WORKER_INTERVAL_MS || 15_000);
  void auditWorkerPass().catch((error) => console.error("Audit worker pass failed", sanitizeError(error)));
  timer = setInterval(() => void auditWorkerPass().catch((error) => console.error("Audit worker pass failed", sanitizeError(error))), intervalMs);
  timer.unref();
}

export function stopAuditWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
