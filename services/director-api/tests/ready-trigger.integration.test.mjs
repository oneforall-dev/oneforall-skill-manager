import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(url, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      last = await response.json();
      if (response.ok && predicate(last)) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${JSON.stringify(last)}`);
}

test("READY_FOR_AUDIT dispatches a real HTTP Auditor execution and returns PASS/CORRECTIONS", async () => {
  const dataDir = await mkdtemp(path.join(process.cwd(), ".audit-integration-"));
  const receiptCalls = [];
  const publisher = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const args = rpc.params.arguments;
    let payload;
    if (rpc.params.name === "get_content_item") {
      payload = {
        client_id: "11111111-1111-4111-8111-111111111111",
        client_slug: "wilson-mkt",
        item_id: args.item_id,
        content_version: 1,
        content_hash: "b068fd3ac2126b869089d546beffb56c2bb6b5f4d6daa8a4ef8375a1d6a08fc7",
        caption: "Final copy",
        format: "carousel",
        instagram_account_id: "22222222-2222-4222-8222-222222222222",
        instagram_username: "wilson.mkt",
        ordered_asset_ids: ["33333333-3333-4333-8333-333333333331"],
        assets: [{ id: "33333333-3333-4333-8333-333333333331", position: 0, kind: "image", public_url: "https://example.test/carousel_01.jpg", label: "carousel_01.jpg" }],
        audit_required: true,
      };
    } else if (rpc.params.name === "register_audit_receipt") {
      receiptCalls.push(args);
      payload = { verified: true };
    } else {
      res.writeHead(400).end(); return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `🚀 PUBLISH · SOCIAL PUBLISHER\n\nDONE\n${JSON.stringify(payload)}` }] } }));
  });
  const publisherPort = await listen(publisher);

  const auditor = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const corrections = body.includes("ITEM-CORRECTION");
    const output = corrections
      ? { verdict: "CORRECTIONS", summary: "Correction required", findings: [{ code: "COPY", severity: "ERROR", message: "Fix copy", assetPosition: null }] }
      : { verdict: "PASS", summary: "Exact package passed", findings: [] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ output_text: JSON.stringify(output) }));
  });
  const auditorPort = await listen(auditor);

  const managerTransitions = [];
  const manager = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let payload;
    if (rpc.params.name === "list_content_items") {
      payload = [
        { id: "44444444-4444-4444-8444-444444444441", metadata: { item_id: "ITEM-PASS", canonical_manager_record: true } },
        { id: "44444444-4444-4444-8444-444444444442", metadata: { item_id: "ITEM-CORRECTION", canonical_manager_record: true } },
      ];
    } else if (rpc.params.name === "transition_content_item") {
      managerTransitions.push(rpc.params.arguments);
      payload = { ok: true };
    } else { res.writeHead(400).end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }));
  });
  const managerPort = await listen(manager);

  const apiPort = 29000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(apiPort),
      DATA_DIR: dataDir,
      OPENAI_API_KEY: "test-key",
      OPENAI_RESPONSES_URL: `http://127.0.0.1:${auditorPort}/v1/responses`,
      PUBLISHER_MCP_URL: `http://127.0.0.1:${publisherPort}/mcp`,
      SOCIAL_MANAGER_MCP_URL: `http://127.0.0.1:${managerPort}/mcp`,
      AUDITOR_RECEIPT_HMAC_SECRET: "test-only-secret-with-at-least-32-characters",
      AUDITOR_WEB_SEARCH: "false",
      CHARACTER_VAULT_SCAN_ENABLED: "false",
      AUDITOR_WORKER_INTERVAL_MS: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  try {
    await waitFor(`http://127.0.0.1:${apiPort}/health`, (body) => body.ok === true);
    for (const itemId of ["ITEM-PASS", "ITEM-CORRECTION"]) {
      let response = await fetch(`http://127.0.0.1:${apiPort}/api/content-items`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, clientId: "wilson-mkt", title: itemId, format: "carousel", lockedElements: [] }),
      });
      assert.equal(response.status, 201);
      response = await fetch(`http://127.0.0.1:${apiPort}/api/content-items/${itemId}/versions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: "final", package: { caption: "Final copy", asset_filenames: ["carousel_01.jpg"] }, status: "READY_FOR_AUDIT" }),
      });
      assert.equal(response.status, 201);
    }
    const passed = await waitFor(`http://127.0.0.1:${apiPort}/api/content-items/ITEM-PASS/audits/1`, (body) => body.status === "COMPLETED");
    assert.equal(passed.result.verdict, "PASS");
    assert.equal(passed.result.publisherReceiptStatus, "REGISTERED");
    const correction = await waitFor(`http://127.0.0.1:${apiPort}/api/content-items/ITEM-CORRECTION/audits/1`, (body) => body.status === "COMPLETED");
    assert.equal(correction.result.verdict, "CORRECTIONS");
    const correctedItem = await fetch(`http://127.0.0.1:${apiPort}/api/content-items/ITEM-CORRECTION`).then((response) => response.json());
    assert.equal(correctedItem.status, "CORRECTION_REQUIRED");
    assert.equal(receiptCalls.length, 1);
    assert.equal(managerTransitions.length, 2);
    assert.deepEqual(managerTransitions.map((entry) => entry.status).sort(), ["audit", "needs_revision"]);
  } catch (error) {
    throw new Error(`${error.message}\nDirector logs:\n${logs}`);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
    await close(publisher);
    await close(auditor);
    await close(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
});
