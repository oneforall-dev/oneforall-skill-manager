import type { ContentItem } from "./types.js";

export function markAuditorNotExecuted(item: ContentItem, recordedAt = new Date().toISOString()) {
  if (item.currentVersion < 1) {
    throw Object.assign(new Error("READY_FOR_AUDIT requires a persisted content version"), { statusCode: 409 });
  }
  const state = {
    directorContentVersion: item.currentVersion,
    status: "AUDITOR_NOT_EXECUTED" as const,
    reason: "AUTOMATIC_AUDITOR_DISABLED" as const,
    recordedAt,
    executionMode: "EXTERNAL_OR_ACTIVE_ORCHESTRATION" as const,
  };
  item.auditExecutionStates = [
    ...(item.auditExecutionStates || []).filter((candidate) => candidate.directorContentVersion !== item.currentVersion),
    state,
  ];
  return state;
}

export function getAuditExecutionState(item: ContentItem, version: number) {
  const result = (item.auditResults || []).find((candidate) => candidate.directorContentVersion === version);
  if (result) {
    return {
      directorContentVersion: version,
      status: result.verdict,
      reason: "AUDITOR_RESULT_RECORDED",
      recordedAt: result.auditedAt,
      executionMode: "EXTERNAL_OR_ACTIVE_ORCHESTRATION",
      auditResult: result,
    };
  }
  return (item.auditExecutionStates || []).find((candidate) => candidate.directorContentVersion === version) || {
    directorContentVersion: version,
    status: "AUDITOR_NOT_EXECUTED",
    reason: "NO_AUDITOR_EXECUTION_RECORDED",
    recordedAt: null,
    executionMode: "EXTERNAL_OR_ACTIVE_ORCHESTRATION",
  };
}
