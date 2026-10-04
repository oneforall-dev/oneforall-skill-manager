import "dotenv/config";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { director } from "./director-api.js";
import { configureOAuth, requireOAuth } from "./oauth.js";

const allowedHosts = (
  process.env.MCP_ALLOWED_HOSTS ||
  "director.oneforall.ocloud.click,www.director.oneforall.ocloud.click,localhost,127.0.0.1"
)
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

const app = createMcpExpressApp({
  host: "0.0.0.0",
  allowedHosts,
});
const port = Number(process.env.PORT || 3000);
const wrappedOutputSchema = z.object({ data: z.unknown() });

configureOAuth(app);

function textResult(data: unknown) {
  return {
    structuredContent: { data },
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

function generatedImageResult(data: unknown) {
  const value = data as Record<string, unknown>;
  const imageBase64 = value.imageBase64;
  const mimeType = typeof value.mimeType === "string" ? value.mimeType : "image/png";
  if (typeof imageBase64 !== "string" || !imageBase64) throw new Error("Director API returned no generated image");
  const metadata = { ...value };
  delete metadata.imageBase64;
  return {
    structuredContent: { data: metadata },
    content: [
      { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
      { type: "image" as const, data: imageBase64, mimeType },
    ],
  };
}

function buildServer() {
  const server = new McpServer(
    {
      name: "oneforall-director",
      version: "1.0.0",
    },
    {
      instructions:
        "Tools for Oneforall Director creative ownership and video production. Manage persistent content items, versions, specialist calls, results and Auditor handoffs, plus create, inspect, analyze, plan, render and revise video projects. Preserve ITEM_ID and never claim another agent executed work without a recorded result. For every recurring character stored in the Character Vault, first resolve the character with search_characters and get_character, then generate through generate_character_image. That tool sends the approved FACE_LOCK and HERO_REFERENCE image bytes to the image model. Never use a host or general-purpose image generator, and never fall back to a text-only prompt, for a vaulted recurring character. If generate_character_image cannot load an approved FACE_LOCK, stop and report the error instead of generating a substitute person.",
    }
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List active Oneforall Director video projects.",
      inputSchema: z.object({}),
      outputSchema: wrappedOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return textResult(await director.listProjects());
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description:
        "Create a new Oneforall Director video project. sourceUrl is optional according to the existing OpenAPI schema.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Project name"),
        sourceUrl: z
          .string()
          .optional()
          .describe("Optional source video URL or source filename"),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, sourceUrl }) => {
      try {
        return textResult(
          await director.createProject({
            name,
            ...(sourceUrl ? { sourceUrl } : {}),
          })
        );
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description:
        "Get project details, metadata, transcript, edit plan, silences, versions, and feedback.",
      inputSchema: z.object({
        project_id: z.string().min(1),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      try {
        return textResult(await director.getProject(project_id));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "analyze_project",
    {
      title: "Analyze project",
      description:
        "Analyze a video project: extract audio, detect silences, transcribe speech, and return analysis metadata.",
      inputSchema: z.object({
        project_id: z.string().min(1),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      try {
        return textResult(await director.analyzeProject(project_id));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "generate_edit_plan",
    {
      title: "Generate edit plan",
      description:
        "Generate the Director edit plan for a project, including cuts, captions, visuals, and audio.",
      inputSchema: z.object({
        project_id: z.string().min(1),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      try {
        return textResult(await director.generateEditPlan(project_id));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "render_video_version",
    {
      title: "Render video version",
      description:
        "Render a new video version using the project's current edit plan.",
      inputSchema: z.object({
        project_id: z.string().min(1),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      try {
        return textResult(await director.renderVideoVersion(project_id));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "revise_video_version",
    {
      title: "Revise video version",
      description:
        "Ask Director to process the project's existing feedback notes and render an updated version. The supplied OpenAPI does not define a request body for this endpoint, so this tool intentionally only accepts project_id.",
      inputSchema: z.object({
        project_id: z.string().min(1),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      try {
        return textResult(await director.reviseVideoVersion(project_id));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "list_content_items",
    {
      title: "List content items",
      description: "List persistent Oneforall creative content items, optionally filtered by CLIENT_ID.",
      inputSchema: z.object({ client_id: z.string().min(1).optional() }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ client_id }) => {
      try { return textResult(await director.listContentItems(client_id)); } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "create_content_item",
    {
      title: "Create content item",
      description: "Create a persistent creative ITEM_ID for a Reel, carousel, Story, static post, ad, UGC, cinematic, music, lore, thumbnail, cover, graphic, or other format. Fails rather than duplicating an existing ITEM_ID.",
      inputSchema: z.object({
        item_id: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/),
        client_id: z.string().min(1).max(120),
        title: z.string().min(1).max(200),
        format: z.string().min(1).max(80),
        objective: z.string().max(4000).optional(),
        context: z.string().max(12000).optional(),
        locked_elements: z.array(z.string().min(1).max(500)).max(100).default([]),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ item_id, client_id, title, format, objective, context, locked_elements }) => {
      try {
        return textResult(await director.createContentItem({ itemId: item_id, clientId: client_id, title, format, objective, context, lockedElements: locked_elements }));
      } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "get_content_item",
    {
      title: "Get content item",
      description: "Get the verified persistent state of an ITEM_ID, including versions, locked elements, specialist calls and handoffs.",
      inputSchema: z.object({ item_id: z.string().min(1) }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ item_id }) => {
      try { return textResult(await director.getContentItem(item_id)); } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "update_content_item",
    {
      title: "Update content item",
      description: "Update mutable metadata or workflow status for an existing ITEM_ID without creating a duplicate.",
      inputSchema: z.object({
        item_id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        format: z.string().min(1).max(80).optional(),
        objective: z.string().max(4000).optional(),
        context: z.string().max(12000).optional(),
        status: z.enum(["DRAFT", "IN_PRODUCTION", "READY_FOR_AUDIT", "APPROVED", "CORRECTION_REQUIRED", "REJECTED", "FAILED", "SUPERSEDED", "DO_NOT_PUBLISH"]).optional(),
        locked_elements: z.array(z.string().min(1).max(500)).max(100).optional(),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ item_id, locked_elements, ...changes }) => {
      try {
        const input: Record<string, unknown> = { ...changes };
        if (locked_elements) input.lockedElements = locked_elements;
        return textResult(await director.updateContentItem(item_id, input));
      } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "create_content_version",
    {
      title: "Create content version",
      description: "Append an immutable, traceable creative version to an existing ITEM_ID and advance its workflow status.",
      inputSchema: z.object({
        item_id: z.string().min(1),
        summary: z.string().min(1).max(4000),
        package: z.record(z.string(), z.unknown()).describe("Structured creative package for this version"),
        created_by: z.string().min(1).max(120).default("Oneforall Director"),
        status: z.enum(["DRAFT", "IN_PRODUCTION", "READY_FOR_AUDIT", "APPROVED", "CORRECTION_REQUIRED", "REJECTED", "FAILED", "SUPERSEDED", "DO_NOT_PUBLISH"]).default("IN_PRODUCTION"),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ item_id, summary, package: creativePackage, created_by, status }) => {
      try { return textResult(await director.createContentVersion(item_id, { summary, package: creativePackage, createdBy: created_by, status })); } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "create_specialist_call",
    {
      title: "Create specialist call",
      description: "Record a specialist request without transferring creative ownership of the ITEM_ID. The result must return to Oneforall Director.",
      inputSchema: z.object({
        item_id: z.string().min(1),
        specialist: z.string().min(1).max(160),
        action: z.string().min(1).max(160),
        task: z.string().min(1).max(6000),
        context: z.string().max(12000).optional(),
        locked_elements: z.array(z.string().min(1).max(500)).max(100).default([]),
        expected_output: z.string().min(1).max(6000),
        content_version: z.number().int().positive().optional(),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ item_id, specialist, action, task, context, locked_elements, expected_output, content_version }) => {
      try { return textResult(await director.createSpecialistCall(item_id, { specialist, action, task, context, lockedElements: locked_elements, expectedOutput: expected_output, returnTo: "@Oneforall Director", contentVersion: content_version })); } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "submit_specialist_result",
    {
      title: "Submit specialist result",
      description: "Record the result of a specialist call and return it to the creative owner for integration.",
      inputSchema: z.object({ item_id: z.string().min(1), call_id: z.string().uuid(), result: z.record(z.string(), z.unknown()) }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ item_id, call_id, result }) => {
      try { return textResult(await director.submitSpecialistResult(item_id, { callId: call_id, result })); } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "handoff_content_item",
    {
      title: "Handoff content item",
      description: "Record an owner handoff for an exact ITEM_ID and CONTENT_VERSION. Handoffs to Auditor move the item to READY_FOR_AUDIT but never claim approval.",
      inputSchema: z.object({
        item_id: z.string().min(1),
        target_nick: z.string().min(1).max(160),
        target_plugin: z.string().min(1).max(200),
        action: z.string().min(1).max(160),
        context: z.string().max(12000),
        expected_output: z.string().min(1).max(6000),
        return_to: z.string().max(200).optional(),
        attempt: z.number().int().positive().default(1),
        approval_receipt: z.string().max(1000).optional(),
        dependencies: z.array(z.string().min(1).max(500)).max(100).default([]),
        content_version: z.number().int().positive().optional(),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ item_id, target_nick, target_plugin, action, context, expected_output, return_to, attempt, approval_receipt, dependencies, content_version }) => {
      try { return textResult(await director.handoffContentItem(item_id, { targetNick: target_nick, targetPlugin: target_plugin, action, context, expectedOutput: expected_output, returnTo: return_to, attempt, approvalReceipt: approval_receipt, dependencies, contentVersion: content_version })); } catch (e) { return errorResult(e); }
    }
  );

  const assetRoles = ["FACE_LOCK", "HERO_REFERENCE", "OUTFIT", "POSE", "EXPRESSION", "APPROVED_RENDER", "REJECTED", "OTHER"] as const;

  server.registerTool(
    "get_character_vault_scanner_status",
    {
      title: "Get Character Vault scanner status",
      description: "Check whether automatic Google Drive scanning is configured or running and inspect the last completed scan.",
      inputSchema: z.object({}),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => { try { return textResult(await director.getCharacterVaultScannerStatus()); } catch (e) { return errorResult(e); } }
  );

  server.registerTool(
    "scan_character_vault",
    {
      title: "Scan Character Vault now",
      description: "Manually scan 00_INBOX_UPLOADS/Clients/{CLIENT_ID}/{GROUP_OR_PROJECT}/Aidols/{PERSONA}, create missing DRAFT character records and attach new images as unapproved OTHER references. Idempotent; never approves Face Locks or creates canon versions.",
      inputSchema: z.object({}),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => { try { return textResult(await director.scanCharacterVault()); } catch (e) { return errorResult(e); } }
  );

  server.registerTool(
    "search_characters",
    {
      title: "Search character vault",
      description: "Search the persistent Oneforall Character Vault by CLIENT_ID, name, alias, CHARACTER_ID or exact tags. Use before creating content with recurring people, idols or characters.",
      inputSchema: z.object({ client_id: z.string().min(1).optional(), query: z.string().min(1).optional(), tags: z.array(z.string().min(1)).max(50).optional() }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ client_id, query, tags }) => {
      try { return textResult(await director.searchCharacters({ clientId: client_id, query, tags })); } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "create_character",
    {
      title: "Create character",
      description: "Create a persistent CHARACTER_ID and canonical character record. Reference photos can be attached afterward from Google Drive.",
      inputSchema: z.object({
        character_id: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/), client_id: z.string().min(1).max(120), name: z.string().min(1).max(200), aliases: z.array(z.string()).max(100).default([]), description: z.string().max(6000).optional(), identity_traits: z.record(z.string(), z.unknown()).default({}), locked_elements: z.array(z.string()).max(200).default([]), negative_constraints: z.array(z.string()).max(200).default([]), tags: z.array(z.string()).max(200).default([]), relationships: z.array(z.string()).max(200).default([]), drive_folder_id: z.string().max(300).optional(), drive_folder_url: z.string().url().optional(),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ character_id, client_id, name, aliases, description, identity_traits, locked_elements, negative_constraints, tags, relationships, drive_folder_id, drive_folder_url }) => {
      try { return textResult(await director.createCharacter({ characterId: character_id, clientId: client_id, name, aliases, description, identityTraits: identity_traits, lockedElements: locked_elements, negativeConstraints: negative_constraints, tags, relationships, driveFolderId: drive_folder_id, driveFolderUrl: drive_folder_url })); } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "get_character",
    {
      title: "Get character",
      description: "Retrieve canonical identity, Face Lock references, approved assets, constraints and version history for one CHARACTER_ID.",
      inputSchema: z.object({ character_id: z.string().min(1) }), outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ character_id }) => { try { return textResult(await director.getCharacter(character_id)); } catch (e) { return errorResult(e); } }
  );

  server.registerTool(
    "update_character",
    {
      title: "Update character",
      description: "Update a character draft without changing CHARACTER_ID. Create a canon version after material changes are reviewed.",
      inputSchema: z.object({ character_id: z.string().min(1), name: z.string().min(1).max(200).optional(), aliases: z.array(z.string()).max(100).optional(), status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(), description: z.string().max(6000).optional(), identity_traits: z.record(z.string(), z.unknown()).optional(), locked_elements: z.array(z.string()).max(200).optional(), negative_constraints: z.array(z.string()).max(200).optional(), tags: z.array(z.string()).max(200).optional(), relationships: z.array(z.string()).max(200).optional(), drive_folder_id: z.string().max(300).optional(), drive_folder_url: z.string().url().optional() }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ character_id, identity_traits, locked_elements, negative_constraints, drive_folder_id, drive_folder_url, ...changes }) => {
      try { const input: Record<string, unknown> = { ...changes }; if (identity_traits) input.identityTraits = identity_traits; if (locked_elements) input.lockedElements = locked_elements; if (negative_constraints) input.negativeConstraints = negative_constraints; if (drive_folder_id) input.driveFolderId = drive_folder_id; if (drive_folder_url) input.driveFolderUrl = drive_folder_url; return textResult(await director.updateCharacter(character_id, input)); } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "attach_character_asset",
    {
      title: "Attach character reference",
      description: "Attach and tag a Google Drive image or other reference to a CHARACTER_ID. The tool stores the Drive identity and analysis metadata, not the binary file.",
      inputSchema: z.object({ character_id: z.string().min(1), drive_file_id: z.string().min(1), drive_url: z.string().url(), name: z.string().min(1).max(300), mime_type: z.string().max(200).optional(), role: z.enum(assetRoles).default("OTHER"), tags: z.array(z.string()).max(200).default([]), notes: z.string().max(4000).optional(), approved: z.boolean().default(false) }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ character_id, drive_file_id, drive_url, name, mime_type, role, tags, notes, approved }) => {
      try { return textResult(await director.attachCharacterAsset(character_id, { driveFileId: drive_file_id, driveUrl: drive_url, name, mimeType: mime_type, role, tags, notes, approved })); } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "update_character_asset",
    {
      title: "Update character reference",
      description: "Approve, reject, retag or reclassify an attached character asset without changing its Drive identity.",
      inputSchema: z.object({ character_id: z.string().min(1), asset_id: z.string().uuid(), name: z.string().min(1).max(300).optional(), mime_type: z.string().max(200).optional(), role: z.enum(assetRoles).optional(), tags: z.array(z.string()).max(200).optional(), notes: z.string().max(4000).optional(), approved: z.boolean().optional() }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ character_id, asset_id, mime_type, ...changes }) => {
      try { const input: Record<string, unknown> = { ...changes }; if (mime_type) input.mimeType = mime_type; return textResult(await director.updateCharacterAsset(character_id, asset_id, input)); } catch (e) { return errorResult(e); }
    }
  );

  server.registerTool(
    "create_character_version",
    {
      title: "Create character canon version",
      description: "Freeze the current canonical character data and approved asset IDs as a traceable version, then mark the character ACTIVE.",
      inputSchema: z.object({ character_id: z.string().min(1), summary: z.string().min(1).max(4000), created_by: z.string().min(1).max(160).default("Oneforall Director") }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ character_id, summary, created_by }) => { try { return textResult(await director.createCharacterVersion(character_id, { summary, createdBy: created_by })); } catch (e) { return errorResult(e); } }
  );

  server.registerTool(
    "generate_character_image",
    {
      title: "Generate canon-locked character image",
      description: "Generate an image of a recurring character by downloading the approved FACE_LOCK and HERO_REFERENCE assets and sending the actual image bytes to OpenAI's image edit endpoint. This is the only permitted generation path for a vaulted recurring character. It fails closed when no approved FACE_LOCK can be loaded; never replace it with text-only generation.",
      inputSchema: z.object({
        character_id: z.string().min(1),
        prompt: z.string().min(1).max(12000),
        size: z.enum(["1024x1024", "1024x1536", "1536x1024"]).default("1024x1536"),
        quality: z.enum(["low", "medium", "high"]).default("high"),
      }),
      outputSchema: wrappedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ character_id, prompt, size, quality }) => {
      try { return generatedImageResult(await director.generateCharacterImage(character_id, { prompt, size, quality })); } catch (e) { return errorResult(e); }
    },
  );

  return server;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "oneforall-director-mcp",
  });
});

app.post("/mcp", requireOAuth, async (req, res) => {
  // Stateless Streamable HTTP is simplest for an API-style adapter.
  // One transport + one McpServer per request avoids request/session collisions.
  const server = buildServer();
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Oneforall Director MCP listening on port ${port}`);
  console.log(`Health: http://localhost:${port}/health`);
  console.log(`MCP:    http://localhost:${port}/mcp`);
});
