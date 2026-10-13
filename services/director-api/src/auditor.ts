import { createHmac, randomUUID } from "node:crypto";
import type { AuditFinding, AuditVerdict, ContentItem, ContentVersion } from "./types.js";
import type { PublisherContentItem } from "./publisher-client.js";

export type AuditorOutput = {
  verdict: AuditVerdict;
  summary: string;
  findings: AuditFinding[];
};

export type AuditPackage = {
  clientId: string;
  publisherClientId: string;
  itemId: string;
  directorContentVersion: number;
  publisherContentVersion: number;
  publisherContentHash: string;
  objective?: string;
  format: string;
  destination: { accountId: string; username?: string };
  orderedAssets: PublisherContentItem["assets"];
  caption: string;
  cta?: string;
  clientRules: string[];
  approvedStyle?: unknown;
  directorPackages: Array<Record<string, unknown>>;
};

function latestVersion(item: ContentItem): ContentVersion {
  const version = item.versions.find((candidate) => candidate.version === item.currentVersion);
  if (!version) throw new Error(`Director version ${item.currentVersion} is missing for ${item.itemId}`);
  return version;
}

function findString(packages: Array<Record<string, unknown>>, keys: string[]) {
  for (const creativePackage of [...packages].reverse()) {
    for (const key of keys) {
      const value = creativePackage[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return undefined;
}

export function buildAuditPackage(item: ContentItem, publisher: PublisherContentItem): AuditPackage {
  latestVersion(item);
  if (publisher.item_id !== item.itemId) throw new Error("Publisher ITEM_ID does not match Director");
  if (publisher.client_slug !== item.clientId) throw new Error("Publisher CLIENT_ID does not match Director");
  const ordered = [...publisher.assets].sort((a, b) => a.position - b.position);
  if (ordered.length === 0 || ordered.some((asset, index) => asset.id !== publisher.ordered_asset_ids[index])) {
    throw new Error("Publisher asset order is incomplete or inconsistent");
  }
  const packages = item.versions
    .filter((version) => version.version <= item.currentVersion)
    .map((version) => version.package);
  const expectedFilenames = packages.flatMap((creativePackage) =>
    Array.isArray(creativePackage.asset_filenames)
      ? creativePackage.asset_filenames.filter((value): value is string => typeof value === "string")
      : [],
  );
  if (expectedFilenames.length) {
    const labels = ordered.map((asset) => asset.label || "");
    if (JSON.stringify(labels) !== JSON.stringify(expectedFilenames)) {
      throw new Error(`Director/Publisher asset mismatch: expected ${expectedFilenames.join(", ")}; got ${labels.join(", ")}`);
    }
  }
  const directorCaption = findString(packages, ["caption", "copy"]);
  const publisherCaption = publisher.caption || "";
  if (directorCaption && directorCaption !== publisherCaption) throw new Error("Director/Publisher caption mismatch");
  return {
    clientId: item.clientId,
    publisherClientId: publisher.client_id,
    itemId: item.itemId,
    directorContentVersion: item.currentVersion,
    publisherContentVersion: publisher.content_version,
    publisherContentHash: publisher.content_hash,
    objective: item.objective,
    format: publisher.format,
    destination: { accountId: publisher.instagram_account_id, username: publisher.instagram_username },
    orderedAssets: ordered,
    caption: publisherCaption,
    cta: findString(packages, ["cta", "CTA"]),
    clientRules: item.lockedElements,
    approvedStyle: packages.map((creativePackage) => creativePackage.design).find(Boolean),
    directorPackages: packages,
  };
}

function extractResponseText(response: any) {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const output of response?.output || []) {
    for (const content of output?.content || []) {
      if (typeof content?.text === "string") return content.text;
    }
  }
  throw new Error("Auditor model returned no text output");
}

export async function executeAuditor(auditPackage: AuditPackage): Promise<AuditorOutput> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw Object.assign(new Error("OPENAI_API_KEY is required for real Auditor execution"), { permanent: true });
  const content: Array<Record<string, unknown>> = [{
    type: "input_text",
    text: [
      "You are Oneforall Auditor, independent from Director and Publisher.",
      "Inspect every supplied asset in exact order plus the complete copy and destination package.",
      "Check factual consistency, spelling, legibility, brand/client rules, format, CTA, asset order, obvious AI artifacts, safety, and whether the package matches its objective.",
      "Return PASS only when there are no blocking errors. Otherwise return CORRECTIONS with specific actionable findings.",
      "Do not publish, schedule, rewrite the package, or claim facts not visible in the evidence.",
      `PACKAGE_JSON=${JSON.stringify(auditPackage)}`,
    ].join("\n"),
  }];
  auditPackage.orderedAssets.forEach((asset) => content.push({ type: "input_image", image_url: asset.public_url, detail: "high" }));
  const requestBody: Record<string, unknown> = {
      model: process.env.AUDITOR_MODEL || "gpt-5.1",
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "oneforall_audit_result",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["verdict", "summary", "findings"],
            properties: {
              verdict: { type: "string", enum: ["PASS", "CORRECTIONS"] },
              summary: { type: "string" },
              findings: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["code", "severity", "message", "assetPosition"],
                  properties: {
                    code: { type: "string" },
                    severity: { type: "string", enum: ["INFO", "WARNING", "ERROR"] },
                    message: { type: "string" },
                    assetPosition: { type: ["integer", "null"] },
                  },
                },
              },
            },
          },
        },
      },
    };
  if (process.env.AUDITOR_WEB_SEARCH !== "false") requestBody.tools = [{ type: "web_search" }];
  const response = await fetch(process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(Number(process.env.AUDITOR_TIMEOUT_MS || 180_000)),
  });
  const raw = await response.text();
  if (!response.ok) {
    const error = new Error(`Auditor model ${response.status}: ${raw.slice(0, 500)}`);
    Object.assign(error, { permanent: response.status >= 400 && response.status < 500 && response.status !== 429 });
    throw error;
  }
  const parsed = JSON.parse(extractResponseText(JSON.parse(raw)));
  if (!(["PASS", "CORRECTIONS"] as string[]).includes(parsed.verdict) || !Array.isArray(parsed.findings)) {
    throw new Error("Auditor model returned an invalid result");
  }
  return {
    verdict: parsed.verdict,
    summary: String(parsed.summary || ""),
    findings: parsed.findings.map((finding: any) => ({
      code: String(finding.code || "UNSPECIFIED"),
      severity: finding.severity,
      message: String(finding.message || ""),
      ...(Number.isInteger(finding.assetPosition) ? { assetPosition: finding.assetPosition } : {}),
    })),
  };
}

export function createPublisherReceipt(auditPackage: AuditPackage, auditorIdentity: string, auditedAt: string) {
  const secret = process.env.AUDITOR_RECEIPT_HMAC_SECRET?.trim();
  if (!secret) throw Object.assign(new Error("AUDITOR_RECEIPT_HMAC_SECRET is not configured in Director; authenticated Publisher receipt cannot be registered"), { permanent: true, missingReceiptAuth: true });
  if (secret.length < 32) throw Object.assign(new Error("AUDITOR_RECEIPT_HMAC_SECRET is invalid"), { permanent: true, missingReceiptAuth: true });
  const receipt = {
    audit_id: `audit-${randomUUID()}`,
    issuer: process.env.AUDITOR_RECEIPT_ISSUER || "oneforall-auditor",
    auditor_identity: auditorIdentity,
    verdict: "PASS" as const,
    client_id: auditPackage.publisherClientId,
    item_id: auditPackage.itemId,
    content_version: auditPackage.publisherContentVersion,
    content_hash: auditPackage.publisherContentHash,
    audited_at: auditedAt,
  };
  return { receipt, secret };
}

export function signPublisherReceipt(receipt: Record<string, unknown>, secret: string) {
  const canonical = JSON.stringify({
    audit_id: receipt.audit_id,
    issuer: receipt.issuer,
    auditor_identity: receipt.auditor_identity,
    verdict: receipt.verdict,
    client_id: receipt.client_id,
    item_id: receipt.item_id,
    content_version: receipt.content_version,
    content_hash: receipt.content_hash,
    audited_at: receipt.audited_at,
  });
  return `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
}
