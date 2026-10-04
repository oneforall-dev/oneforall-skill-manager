type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const baseUrl = (process.env.DIRECTOR_API_BASE_URL || "").replace(/\/+$/, "");
const pinggyHeaderValue = process.env.DIRECTOR_PINGGY_HEADER_VALUE || "";
const requestTimeoutMs = Number(process.env.DIRECTOR_API_TIMEOUT_MS || 900000);

if (!baseUrl) {
  throw new Error("DIRECTOR_API_BASE_URL is required");
}

async function request(path: string, init: RequestInit = {}): Promise<Json> {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // The uploaded OpenAPI declares this header as its security scheme.
  if (pinggyHeaderValue) {
    headers.set("X-Pinggy-No-Screen", pinggyHeaderValue);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: init.signal || AbortSignal.timeout(requestTimeoutMs),
  });

  const raw = await response.text();
  let body: Json;

  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }

  if (!response.ok) {
    throw new Error(
      `Director API ${response.status} ${response.statusText}: ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`
    );
  }

  return body;
}

export const director = {
  listProjects: () => request("/projects"),

  createProject: (input: { name: string; sourceUrl?: string }) =>
    request("/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getProject: (id: string) =>
    request(`/projects/${encodeURIComponent(id)}`),

  analyzeProject: (id: string) =>
    request(`/projects/${encodeURIComponent(id)}/analyze`, {
      method: "POST",
    }),

  generateEditPlan: (id: string) =>
    request(`/projects/${encodeURIComponent(id)}/plan`, {
      method: "POST",
    }),

  renderVideoVersion: (id: string) =>
    request(`/projects/${encodeURIComponent(id)}/render`, {
      method: "POST",
    }),

  reviseVideoVersion: (id: string) =>
    request(`/projects/${encodeURIComponent(id)}/revise`, {
      method: "POST",
    }),

  listContentItems: (clientId?: string) =>
    request(`/content-items${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`),

  createContentItem: (input: Record<string, unknown>) =>
    request("/content-items", { method: "POST", body: JSON.stringify(input) }),

  getContentItem: (itemId: string) =>
    request(`/content-items/${encodeURIComponent(itemId)}`),

  updateContentItem: (itemId: string, input: Record<string, unknown>) =>
    request(`/content-items/${encodeURIComponent(itemId)}`, { method: "PATCH", body: JSON.stringify(input) }),

  createContentVersion: (itemId: string, input: Record<string, unknown>) =>
    request(`/content-items/${encodeURIComponent(itemId)}/versions`, { method: "POST", body: JSON.stringify(input) }),

  createSpecialistCall: (itemId: string, input: Record<string, unknown>) =>
    request(`/content-items/${encodeURIComponent(itemId)}/specialist-calls`, { method: "POST", body: JSON.stringify(input) }),

  submitSpecialistResult: (itemId: string, input: Record<string, unknown>) =>
    request(`/content-items/${encodeURIComponent(itemId)}/specialist-results`, { method: "POST", body: JSON.stringify(input) }),

  handoffContentItem: (itemId: string, input: Record<string, unknown>) =>
    request(`/content-items/${encodeURIComponent(itemId)}/handoffs`, { method: "POST", body: JSON.stringify(input) }),

  searchCharacters: (filters: { clientId?: string; query?: string; tags?: string[] }) => {
    const params = new URLSearchParams();
    if (filters.clientId) params.set("clientId", filters.clientId);
    if (filters.query) params.set("query", filters.query);
    if (filters.tags?.length) params.set("tags", filters.tags.join(","));
    const suffix = params.size ? `?${params.toString()}` : "";
    return request(`/characters${suffix}`);
  },
  createCharacter: (input: Record<string, unknown>) =>
    request("/characters", { method: "POST", body: JSON.stringify(input) }),
  getCharacter: (characterId: string) =>
    request(`/characters/${encodeURIComponent(characterId)}`),
  updateCharacter: (characterId: string, input: Record<string, unknown>) =>
    request(`/characters/${encodeURIComponent(characterId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  attachCharacterAsset: (characterId: string, input: Record<string, unknown>) =>
    request(`/characters/${encodeURIComponent(characterId)}/assets`, { method: "POST", body: JSON.stringify(input) }),
  updateCharacterAsset: (characterId: string, assetId: string, input: Record<string, unknown>) =>
    request(`/characters/${encodeURIComponent(characterId)}/assets/${encodeURIComponent(assetId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  createCharacterVersion: (characterId: string, input: Record<string, unknown>) =>
    request(`/characters/${encodeURIComponent(characterId)}/versions`, { method: "POST", body: JSON.stringify(input) }),
  loadCharacterReferences: (characterId: string) =>
    request(`/characters/${encodeURIComponent(characterId)}/reference-images`),
  getCharacterVaultScannerStatus: () => request("/character-vault/scanner"),
  scanCharacterVault: () => request("/character-vault/scan", { method: "POST" }),
};
