import type { AuditResult } from "./types.js";

function endpoint() {
  return (process.env.SOCIAL_MANAGER_MCP_URL || "https://social-manager.ocloud.click/mcp").replace(/\/+$/, "");
}

function parseEnvelope(raw: string): any {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const lines = trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (!lines.length) throw new Error("Social Manager returned an unsupported MCP response");
  return JSON.parse(lines.at(-1)!.slice(5).trim());
}

async function call(name: string, args: Record<string, unknown>) {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(Number(process.env.SOCIAL_MANAGER_TIMEOUT_MS || 30_000)),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Social Manager MCP ${response.status}: ${raw.slice(0, 500)}`);
  const envelope = parseEnvelope(raw);
  if (envelope.error) throw new Error(`Social Manager MCP error: ${JSON.stringify(envelope.error)}`);
  const result = envelope.result;
  if (result?.isError) throw new Error(String(result.content?.[0]?.text || "Social Manager tool failed"));
  const text = result?.content?.find?.((entry: any) => entry?.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Social Manager returned no text result");
  const starts = [text.indexOf("["), text.indexOf("{")].filter((index) => index >= 0);
  if (!starts.length) throw new Error("Social Manager result did not contain JSON");
  return JSON.parse(text.slice(Math.min(...starts)));
}

export async function syncSocialManagerAudit(clientSlug: string, itemId: string, result: AuditResult) {
  const items = await call("list_content_items", { client_slug: clientSlug, limit: 100 });
  const matches = (Array.isArray(items) ? items : items.items || []).filter((item: any) => item?.metadata?.item_id === itemId);
  const record = matches.find((item: any) => item?.metadata?.canonical_manager_record === true) || matches[0];
  if (!record?.id) throw Object.assign(new Error(`Social Manager record not found for ${itemId}`), { permanent: true });
  const pass = result.verdict === "PASS";
  return call("transition_content_item", {
    content_id: record.id,
    status: pass ? "audit" : "needs_revision",
    actor: "Oneforall Director automatic Auditor",
    approval_receipt: pass ? {
      audit_id: result.auditId,
      auditor_identity: result.auditorIdentity,
      verdict: result.verdict,
      director_content_version: result.directorContentVersion,
      publisher_content_version: result.publisherContentVersion,
      publisher_content_hash: result.publisherContentHash,
      audited_at: result.auditedAt,
      publisher_receipt_status: result.publisherReceiptStatus,
    } : undefined,
    metadata: {
      item_id: itemId,
      audit_status: result.verdict,
      audit_summary: result.summary,
      audit_findings: result.findings,
      director_content_version: result.directorContentVersion,
      publisher_content_version: result.publisherContentVersion,
      publisher_content_hash: result.publisherContentHash,
      next_gate: pass ? "USER_APPROVAL_REQUIRED" : "DIRECTOR_CORRECTION_REQUIRED",
    },
  });
}
