import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { getAuditExecutionState, markAuditorNotExecuted } = await import("../dist/audit-execution-state.js");

function contentItem() {
  return {
    itemId: "ITEM-NO-AUTO-AUDIT",
    clientId: "wilson-mkt",
    title: "No automatic audit",
    format: "carousel",
    status: "READY_FOR_AUDIT",
    createdAt: "2026-10-13T12:00:00.000Z",
    updatedAt: "2026-10-13T12:00:00.000Z",
    currentVersion: 1,
    lockedElements: [],
    versions: [{ version: 1, createdAt: "2026-10-13T12:00:00.000Z", createdBy: "Director", summary: "final", package: { caption: "copy", asset_ids: ["asset-1"] } }],
    specialistCalls: [],
    handoffs: [],
  };
}

test("READY_FOR_AUDIT persists an explicit AUDITOR_NOT_EXECUTED state", () => {
  process.env.OPENAI_API_KEY = "present-but-must-not-be-used";
  const item = contentItem();
  const recorded = markAuditorNotExecuted(item, "2026-10-13T12:01:00.000Z");
  assert.equal(recorded.status, "AUDITOR_NOT_EXECUTED");
  assert.equal(recorded.reason, "AUTOMATIC_AUDITOR_DISABLED");
  assert.deepEqual(getAuditExecutionState(item, 1), recorded);
});

test("the Director publication flow has no automatic Auditor worker or dispatch call", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /startAuditWorker|ensureAuditJob|processAuditJob/);
  assert.match(source, /AUTOMATIC_AUDITOR_DISABLED/);
  assert.match(source, /publicationAuthorization:\s*\["AUDITOR_PASS",\s*"OWNER_OVERRIDE"\]/);
  assert.match(source, /status\(410\)/);
});

test("a real external audit result takes precedence over AUDITOR_NOT_EXECUTED", () => {
  const item = contentItem();
  markAuditorNotExecuted(item);
  item.auditResults = [{
    auditId: "audit-1",
    auditorIdentity: "Oneforall Auditor",
    directorContentVersion: 1,
    publisherContentVersion: 1,
    publisherContentHash: "a".repeat(64),
    verdict: "PASS",
    summary: "verified",
    findings: [],
    auditedAt: "2026-10-13T12:05:00.000Z",
    publisherReceiptStatus: "REGISTERED",
  }];
  const state = getAuditExecutionState(item, 1);
  assert.equal(state.status, "PASS");
  assert.equal(state.reason, "AUDITOR_RESULT_RECORDED");
});
