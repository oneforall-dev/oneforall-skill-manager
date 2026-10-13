import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";

process.env.DATA_DIR = await mkdtemp(path.join(process.cwd(), ".audit-tests-"));
after(async () => rm(process.env.DATA_DIR, { recursive: true, force: true }));
process.env.AUDITOR_RECEIPT_HMAC_SECRET = "test-only-secret-with-at-least-32-characters";
process.env.AUDITOR_RETRY_BASE_MS = "1";

const { ensureAuditJob, processAuditJob } = await import("../dist/audit-coordinator.js");
const { loadAuditJobForVersion, saveAuditJob } = await import("../dist/audit-store.js");
const { loadContentItem, saveContentItem } = await import("../dist/content-store.js");

let sequence = 0;
const caption = "Final caption\n\nFollow for updates.";
const assets = [1, 2, 3, 4].map((position) => ({
  id: `00000000-0000-4000-8000-00000000000${position}`,
  position: position - 1,
  kind: "image",
  public_url: `https://example.test/carousel_0${position}.jpg`,
  mime_type: "image/jpeg",
  label: `carousel_0${position}.jpg`,
}));

function item(overrides = {}) {
  sequence += 1;
  const now = new Date().toISOString();
  return {
    itemId: `AUDIT-TEST-${sequence}`,
    clientId: "wilson-mkt",
    title: "Audit test",
    format: "carousel 4:5 / 4 slides",
    objective: "Verify the package",
    status: "READY_FOR_AUDIT",
    createdAt: now,
    updatedAt: now,
    currentVersion: 2,
    lockedElements: ["4 slides", "No CTA DM"],
    versions: [
      { version: 1, createdAt: now, createdBy: "Director", summary: "copy", package: { caption } },
      { version: 2, createdAt: now, createdBy: "Director", summary: "assets", package: { asset_filenames: assets.map((asset) => asset.label) } },
    ],
    specialistCalls: [],
    handoffs: [],
    ...overrides,
  };
}

function publisher(current, overrides = {}) {
  return {
    client_id: "11111111-1111-4111-8111-111111111111",
    client_slug: current.clientId,
    item_id: current.itemId,
    content_version: 1,
    content_hash: "b068fd3ac2126b869089d546beffb56c2bb6b5f4d6daa8a4ef8375a1d6a08fc7",
    caption,
    format: "carousel",
    instagram_account_id: "22222222-2222-4222-8222-222222222222",
    instagram_username: "wilson.mkt",
    ordered_asset_ids: assets.map((asset) => asset.id),
    assets,
    audit_required: true,
    ...overrides,
  };
}

function deps(current, verdict = "PASS") {
  return {
    getPublisherItem: async () => publisher(current),
    runAuditor: async () => ({ verdict, summary: verdict === "PASS" ? "passed" : "fix copy", findings: verdict === "PASS" ? [] : [{ code: "COPY", severity: "ERROR", message: "fix" }] }),
    registerReceipt: async (receipt, signature) => ({ receipt, signature }),
    syncManager: async () => ({ synced: true }),
  };
}

test("PASS returns to Director, binds different Publisher version, and registers authenticated receipt", async () => {
  const current = item();
  await saveContentItem(current);
  const queued = await ensureAuditJob(current);
  const completed = await processAuditJob(queued, deps(current));
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.result.verdict, "PASS");
  assert.equal(completed.result.directorContentVersion, 2);
  assert.equal(completed.result.publisherContentVersion, 1);
  assert.equal(completed.result.publisherReceiptStatus, "REGISTERED");
  const stored = await loadContentItem(current.itemId);
  assert.equal(stored.auditResults.length, 1);
});

test("CORRECTIONS returns to the same ITEM_ID and moves Director to CORRECTION_REQUIRED", async () => {
  const current = item();
  await saveContentItem(current);
  const completed = await processAuditJob(await ensureAuditJob(current), deps(current, "CORRECTIONS"));
  assert.equal(completed.result.verdict, "CORRECTIONS");
  assert.equal((await loadContentItem(current.itemId)).status, "CORRECTION_REQUIRED");
});

test("one active/completed audit exists per ITEM_ID and Director version", async () => {
  const current = item();
  await saveContentItem(current);
  const [first, second] = await Promise.all([ensureAuditJob(current), ensureAuditJob(current)]);
  assert.equal(first.id, second.id);
  let runs = 0;
  const completed = await processAuditJob(first, { ...deps(current), runAuditor: async () => { runs += 1; return { verdict: "PASS", summary: "ok", findings: [] }; } });
  await processAuditJob(completed, { ...deps(current), runAuditor: async () => { runs += 1; return { verdict: "PASS", summary: "duplicate", findings: [] }; } });
  assert.equal(runs, 1);
});

test("content changed during inspection invalidates the returned Auditor result", async () => {
  const current = item();
  await saveContentItem(current);
  const blocked = await processAuditJob(await ensureAuditJob(current), {
    ...deps(current),
    runAuditor: async () => {
      const changed = await loadContentItem(current.itemId);
      changed.currentVersion = 3;
      changed.versions.push({ version: 3, createdAt: new Date().toISOString(), createdBy: "Director", summary: "changed during audit", package: { caption: "changed" } });
      await saveContentItem(changed);
      return { verdict: "PASS", summary: "stale", findings: [] };
    },
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.match(blocked.lastError, /changed while Auditor was running/i);
  assert.equal((await loadContentItem(current.itemId)).auditResults?.length || 0, 0);
});

test("a later content version invalidates the queued audit instead of inheriting approval", async () => {
  const current = item();
  await saveContentItem(current);
  const queued = await ensureAuditJob(current);
  current.currentVersion = 3;
  current.versions.push({ version: 3, createdAt: new Date().toISOString(), createdBy: "Director", summary: "changed", package: { caption: "changed" } });
  await saveContentItem(current);
  const blocked = await processAuditJob(queued, deps(current));
  assert.equal(blocked.status, "BLOCKED");
  assert.match(blocked.lastError, /stale/i);
});

test("transient Auditor failure is retried with bounded attempts", async () => {
  const current = item();
  await saveContentItem(current);
  let calls = 0;
  const injected = { ...deps(current), runAuditor: async () => { calls += 1; if (calls === 1) throw new Error("temporary network timeout"); return { verdict: "PASS", summary: "recovered", findings: [] }; } };
  let job = await processAuditJob(await ensureAuditJob(current), injected);
  assert.equal(job.status, "RETRY_WAIT");
  job.nextAttemptAt = new Date(0).toISOString();
  await saveAuditJob(job);
  job = await processAuditJob(await loadAuditJobForVersion(current.itemId, 2), injected);
  assert.equal(job.status, "COMPLETED");
  assert.equal(job.attempt, 2);
});

test("Publisher audit-required content blocks when receipt authentication is unavailable", async () => {
  const current = item();
  await saveContentItem(current);
  const secret = process.env.AUDITOR_RECEIPT_HMAC_SECRET;
  delete process.env.AUDITOR_RECEIPT_HMAC_SECRET;
  const blocked = await processAuditJob(await ensureAuditJob(current), deps(current));
  process.env.AUDITOR_RECEIPT_HMAC_SECRET = secret;
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.result.publisherReceiptStatus, "BLOCKED_MISSING_AUTH");
});

test("unrelated historical published records are not modified", async () => {
  const historical = item({ itemId: `HISTORICAL-${++sequence}`, status: "APPROVED", currentVersion: 1, versions: [{ version: 1, createdAt: new Date().toISOString(), createdBy: "legacy", summary: "published", package: { platform_media_id: "123" } }] });
  await saveContentItem(historical);
  const before = JSON.stringify(await loadContentItem(historical.itemId));
  const current = item();
  await saveContentItem(current);
  await processAuditJob(await ensureAuditJob(current), deps(current));
  assert.equal(JSON.stringify(await loadContentItem(historical.itemId)), before);
});
