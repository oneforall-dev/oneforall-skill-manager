type JsonObject = Record<string, unknown>;

export type PublisherAsset = {
  id: string;
  position: number;
  kind: "image" | "video";
  public_url: string;
  mime_type?: string;
  label?: string;
};

export type PublisherContentItem = {
  client_id: string;
  client_slug: string;
  item_id: string;
  content_version: number;
  content_hash: string;
  caption?: string | null;
  format: string;
  instagram_account_id: string;
  instagram_username?: string;
  ordered_asset_ids: string[];
  assets: PublisherAsset[];
  audit_required: boolean;
  audit_receipt?: unknown;
};

function endpoint() {
  return (process.env.PUBLISHER_MCP_URL || "https://social.ocloud.click/mcp").replace(/\/+$/, "");
}

function parseMcpResponse(raw: string): any {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (!data.length) throw new Error("Publisher returned an unsupported MCP response");
  return JSON.parse(data.at(-1)!.slice(5).trim());
}

async function callPublisherTool(name: string, args: JsonObject): Promise<any> {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(Number(process.env.PUBLISHER_TIMEOUT_MS || 30_000)),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Publisher MCP ${response.status}: ${raw.slice(0, 500)}`);
  const envelope = parseMcpResponse(raw);
  if (envelope.error) throw new Error(`Publisher MCP error: ${JSON.stringify(envelope.error)}`);
  const result = envelope.result;
  if (result?.isError) throw new Error(String(result.content?.[0]?.text || "Publisher tool failed"));
  const text = result?.content?.find?.((entry: any) => entry?.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Publisher tool returned no text result");
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) throw new Error("Publisher result did not contain JSON");
  return JSON.parse(text.slice(jsonStart));
}

export async function getPublisherContentItem(clientSlug: string, itemId: string): Promise<PublisherContentItem> {
  return callPublisherTool("get_content_item", { client_slug: clientSlug, item_id: itemId });
}

export async function registerPublisherAuditReceipt(receipt: JsonObject, signature: string) {
  return callPublisherTool("register_audit_receipt", { receipt, signature });
}
