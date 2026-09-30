import crypto from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

type TokenKind = "access" | "refresh" | "code" | "client";

type SignedPayload = {
  kind: TokenKind;
  exp: number;
  [key: string]: unknown;
};

const publicBaseUrl = (process.env.MCP_PUBLIC_BASE_URL || "https://director.oneforall.ocloud.click").replace(/\/+$/, "");
const resource = process.env.MCP_OAUTH_RESOURCE || publicBaseUrl;
const issuer = process.env.MCP_OAUTH_ISSUER || publicBaseUrl;
// MCP_BEARER_TOKEN is accepted as a migration fallback so an existing private
// deployment can switch to OAuth without briefly exposing or disabling auth.
// Set the two dedicated variables after migration to keep these roles separate.
const legacyMigrationSecret = process.env.MCP_BEARER_TOKEN || "";
const signingSecret = process.env.OAUTH_SIGNING_SECRET || legacyMigrationSecret;
const loginPassword = process.env.OAUTH_PASSWORD || legacyMigrationSecret;
const supportedScopes = ["director:read", "director:write"];
const requiredScope = supportedScopes.join(" ");
const usedCodes = new Set<string>();

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: SignedPayload) {
  const encoded = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", signingSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verify(token: string, expectedKind: TokenKind): SignedPayload | null {
  if (!signingSecret) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = crypto.createHmac("sha256", signingSecret).update(encoded).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SignedPayload;
    if (payload.kind !== expectedKind || typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeScope(requested: string) {
  const scopes = requested.split(/\s+/).filter(Boolean);
  if (scopes.length === 0) return requiredScope;
  return scopes.every((scope) => supportedScopes.includes(scope)) ? scopes.join(" ") : "";
}

function validateRedirectUri(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function redirectWithError(res: Response, redirectUri: string, state: string, error: string) {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (state) target.searchParams.set("state", state);
  res.redirect(302, target.toString());
}

function parseClient(clientId: string) {
  const payload = verify(clientId, "client");
  if (!payload || !Array.isArray(payload.redirect_uris)) return null;
  return payload as SignedPayload & { redirect_uris: string[] };
}

function renderAuthorizePage(params: Record<string, string>, error = "") {
  const hidden = Object.entries(params)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join("\n");
  const errorBlock = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar Oneforall Director</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0b;color:#f5f5f5;margin:0;display:grid;place-items:center;min-height:100vh}.card{width:min(420px,calc(100% - 40px));background:#181818;border:1px solid #333;border-radius:18px;padding:28px;box-shadow:0 20px 70px #0008}h1{font-size:24px;margin:0 0 8px}p{color:#bbb;line-height:1.45}.scope{background:#222;border-radius:10px;padding:12px;color:#ddd}.error{color:#ff9b9b}label{display:block;margin:18px 0 8px}input[type=password]{box-sizing:border-box;width:100%;padding:12px;border-radius:10px;border:1px solid #555;background:#101010;color:white}button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:999px;background:#fff;color:#111;font-weight:700;cursor:pointer}</style>
</head><body><main class="card"><h1>Oneforall Director</h1><p>ChatGPT solicita acceso para consultar y ejecutar las herramientas de tu Director.</p><div class="scope">Permisos: leer proyectos y ejecutar acciones de edición/render.</div>${errorBlock}<form method="post" action="/oauth/authorize">${hidden}<label for="password">Contraseña de conexión</label><input id="password" name="password" type="password" required autofocus autocomplete="current-password"><button type="submit">Autorizar ChatGPT</button></form></main></body></html>`;
}

function authorizeParams(source: Record<string, unknown>) {
  return {
    response_type: asString(source.response_type),
    client_id: asString(source.client_id),
    redirect_uri: asString(source.redirect_uri),
    scope: asString(source.scope),
    state: asString(source.state),
    code_challenge: asString(source.code_challenge),
    code_challenge_method: asString(source.code_challenge_method),
    resource: asString(source.resource),
  };
}

function validateAuthorize(params: ReturnType<typeof authorizeParams>) {
  const client = parseClient(params.client_id);
  if (!client) return "invalid_client";
  if (params.response_type !== "code") return "unsupported_response_type";
  if (!params.redirect_uri || !client.redirect_uris.includes(params.redirect_uri)) return "invalid_redirect_uri";
  if (!params.code_challenge || params.code_challenge_method !== "S256") return "invalid_request";
  if (params.resource && params.resource !== resource) return "invalid_target";
  if (!normalizeScope(params.scope)) return "invalid_scope";
  return "";
}

export function configureOAuth(app: Express) {
  if (!signingSecret || !loginPassword) {
    throw new Error("OAUTH_SIGNING_SECRET and OAUTH_PASSWORD are required for ChatGPT OAuth (MCP_BEARER_TOKEN is accepted during migration)");
  }

  app.use(express.urlencoded({ extended: false }));

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: supportedScopes,
      resource_documentation: `${publicBaseUrl}/health`,
    });
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({ resource, authorization_servers: [issuer], scopes_supported: supportedScopes });
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: supportedScopes,
    });
  });

  app.post("/oauth/register", express.json(), (req, res) => {
    const redirectUris = Array.isArray(req.body?.redirect_uris)
      ? req.body.redirect_uris.filter((uri: unknown): uri is string => typeof uri === "string" && validateRedirectUri(uri))
      : [];
    if (redirectUris.length === 0 || redirectUris.length !== req.body.redirect_uris.length) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }
    const clientId = sign({ kind: "client", exp: Date.now() + 365 * 24 * 60 * 60 * 1000, redirect_uris: redirectUris });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  app.get("/oauth/authorize", (req, res) => {
    const params = authorizeParams(req.query as Record<string, unknown>);
    const error = validateAuthorize(params);
    if (error) {
      if (params.redirect_uri && validateRedirectUri(params.redirect_uri) && error !== "invalid_redirect_uri" && error !== "invalid_client") {
        redirectWithError(res, params.redirect_uri, params.state, error);
      } else {
        res.status(400).send(`OAuth request rejected: ${escapeHtml(error)}`);
      }
      return;
    }
    res.type("html").send(renderAuthorizePage(params));
  });

  app.post("/oauth/authorize", (req, res) => {
    const params = authorizeParams(req.body || {});
    const error = validateAuthorize(params);
    if (error) {
      res.status(400).send(`OAuth request rejected: ${escapeHtml(error)}`);
      return;
    }
    if (!safeEqual(asString(req.body.password), loginPassword)) {
      res.status(401).type("html").send(renderAuthorizePage(params, "Contraseña incorrecta."));
      return;
    }
    const scope = normalizeScope(params.scope);
    const code = sign({
      kind: "code",
      exp: Date.now() + 5 * 60 * 1000,
      jti: crypto.randomUUID(),
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      scope,
      resource,
    });
    const target = new URL(params.redirect_uri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    res.redirect(302, target.toString());
  });

  app.post("/oauth/token", (req, res) => {
    const grantType = asString(req.body.grant_type);
    const requestedResource = asString(req.body.resource) || resource;
    if (requestedResource !== resource) {
      res.status(400).json({ error: "invalid_target" });
      return;
    }

    let scope = requiredScope;
    if (grantType === "authorization_code") {
      const code = verify(asString(req.body.code), "code");
      const clientId = asString(req.body.client_id);
      const redirectUri = asString(req.body.redirect_uri);
      const verifier = asString(req.body.code_verifier);
      const jti = asString(code?.jti);
      const challenge = verifier ? crypto.createHash("sha256").update(verifier).digest("base64url") : "";
      if (!code || !jti || usedCodes.has(jti) || code.client_id !== clientId || code.redirect_uri !== redirectUri || code.resource !== resource || code.code_challenge !== challenge) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      usedCodes.add(jti);
      scope = asString(code.scope) || requiredScope;
    } else if (grantType === "refresh_token") {
      const refresh = verify(asString(req.body.refresh_token), "refresh");
      if (!refresh || refresh.resource !== resource) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      scope = asString(refresh.scope) || requiredScope;
    } else {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    const accessToken = sign({ kind: "access", exp: Date.now() + 8 * 60 * 60 * 1000, resource, scope });
    const refreshToken = sign({ kind: "refresh", exp: Date.now() + 30 * 24 * 60 * 60 * 1000, resource, scope });
    res.set("Cache-Control", "no-store").json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 8 * 60 * 60,
      refresh_token: refreshToken,
      scope,
    });
  });
}

export function requireOAuth(req: Request, res: Response, next: NextFunction) {
  const authorization = req.header("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const payload = verify(token, "access");
  const scopes = asString(payload?.scope).split(/\s+/);
  if (!payload || payload.resource !== resource || !supportedScopes.every((scope) => scopes.includes(scope))) {
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource", scope="${requiredScope}"`)
      .json({ error: "unauthorized" });
    return;
  }
  next();
}
