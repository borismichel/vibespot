/**
 * HubSpot CMS Source Code API v3 client.
 * Direct HTTP calls — no HubSpot CLI dependency.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HubSpotApiError {
  status: number;
  message: string;
  category?: string;
  detail?: string;
}

export interface UploadResult {
  success: boolean;
  path: string;
  error?: HubSpotApiError;
}

export interface FileMetadata {
  id: string;
  name: string;
  folder: boolean;
  path: string;
  createdAt?: number;
  updatedAt?: number;
  children?: (FileMetadata | string)[];
}

export interface AccountInfo {
  portalId: string;
  portalName: string;
  dataCenter: "na1" | "eu1";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** HubSpot API base URL — same for all regions. Cloudflare routes by token. */
const BASE_URL = "https://api.hubapi.com";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
/** Refresh access token 5 minutes before expiry. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_TOKEN_CACHE_ENTRIES = 25;

// ---------------------------------------------------------------------------
// Token exchange — PAKs are exchanged for short-lived access tokens
// ---------------------------------------------------------------------------

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  hubId: number;
  hubName: string;
}

const tokenCache = new Map<string, CachedToken>();

function tokenCacheKey(pak: string): string {
  return createHash("sha256").update(pak).digest("hex");
}

function evictExpiredCachedTokens(now = Date.now()): void {
  for (const [key, token] of tokenCache) {
    if (token.expiresAt - now <= TOKEN_REFRESH_BUFFER_MS) {
      tokenCache.delete(key);
    }
  }
}

function evictOldestCachedTokens(): void {
  while (tokenCache.size > MAX_TOKEN_CACHE_ENTRIES) {
    const oldestKey = tokenCache.keys().next().value;
    if (!oldestKey) return;
    tokenCache.delete(oldestKey);
  }
}

export function clearHubSpotTokenCacheForTest(): void {
  if (process.env.NODE_ENV === "test") tokenCache.clear();
}

export function getHubSpotTokenCacheKeysForTest(): string[] {
  return process.env.NODE_ENV === "test" ? [...tokenCache.keys()] : [];
}

/** Exchange a PAK for a short-lived OAuth access token via HubSpot's localdevauth endpoint. */
async function exchangePakForToken(pak: string): Promise<CachedToken> {
  evictExpiredCachedTokens();
  const cacheKey = tokenCacheKey(pak);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return cached;
  }

  const resp = await fetch(`${BASE_URL}/localdevauth/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encodedOAuthRefreshToken: pak }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      resp.status === 401 || resp.status === 403
        ? "Invalid or expired Personal Access Key"
        : `Token exchange failed (${resp.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = await resp.json() as Record<string, unknown>;
  if (
    typeof data.oauthAccessToken !== "string" ||
    !data.oauthAccessToken ||
    typeof data.expiresAtMillis !== "number" ||
    !Number.isFinite(data.expiresAtMillis) ||
    data.expiresAtMillis <= Date.now()
  ) {
    throw new Error("Token exchange returned an invalid token payload");
  }

  const token: CachedToken = {
    accessToken: data.oauthAccessToken,
    expiresAt: data.expiresAtMillis,
    hubId: typeof data.hubId === "number" ? data.hubId : Number(data.hubId || 0),
    hubName: typeof data.hubName === "string" ? data.hubName : "",
  };

  tokenCache.set(cacheKey, token);
  evictOldestCachedTokens();
  return token;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authHeaders(pak: string): Promise<Record<string, string>> {
  const { accessToken } = await exchangePakForToken(pak);
  return {
    Authorization: `Bearer ${accessToken}`,
  };
}

/** Encode a remote path for use in HubSpot API URLs — encode each segment but keep slashes. */
function encodePath(remotePath: string): string {
  return remotePath.replace(/^\/+/, "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** Detect data center from PAK prefix. */
export function detectDataCenterFromPak(pak: string): "na1" | "eu1" {
  // Modern PAK format: pat-eu1-... or pat-na1-...
  if (pak.startsWith("pat-eu1-")) return "eu1";
  if (pak.startsWith("pat-na1-")) return "na1";
  // Legacy base64 prefix check
  if (pak.startsWith("CiRldTE")) return "eu1";
  return "na1";
}

/** Sleep helper for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse error response body into HubSpotApiError. */
async function parseErrorResponse(resp: Response, fallbackPath?: string): Promise<HubSpotApiError> {
  let message = `HTTP ${resp.status}`;
  let category: string | undefined;
  let detail: string | undefined;

  try {
    const body = await resp.json() as Record<string, unknown>;
    if (body.message && typeof body.message === "string") message = body.message;
    if (body.category && typeof body.category === "string") category = body.category;
    if (body.errors && Array.isArray(body.errors) && body.errors.length > 0) {
      const firstError = body.errors[0] as Record<string, unknown>;
      detail = firstError.message as string || JSON.stringify(firstError);
    }
  } catch {
    try {
      const text = await resp.text();
      if (text) message = text.slice(0, 500);
    } catch { /* ignore */ }
  }

  return {
    status: resp.status,
    message: fallbackPath ? `${message} (${fallbackPath})` : message,
    category,
    detail,
  };
}

/** Make a fetch request with retry logic for rate limits and transient errors. */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, options);

    if (resp.status === 429 || (resp.status >= 500 && attempt < retries)) {
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
      continue;
    }

    return resp;
  }

  // Should never reach here, but TypeScript needs it
  return fetch(url, options);
}

// ---------------------------------------------------------------------------
// API Functions
// ---------------------------------------------------------------------------

/**
 * Validate a Personal Access Key by fetching account info.
 * Returns portal ID, name, and data center.
 */
export async function validatePak(pak: string): Promise<AccountInfo> {
  // Exchange PAK for access token — this validates the key
  const token = await exchangePakForToken(pak);

  // Use the access token to get account details
  const url = `${BASE_URL}/account-info/v3/details`;
  const resp = await fetchWithRetry(url, { headers: await authHeaders(pak) });

  if (!resp.ok) {
    const err = await parseErrorResponse(resp);
    throw new Error(`Failed to get account info: ${err.message}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  const portalId = String(data.portalId || token.hubId || "");
  const portalName = token.hubName || (data.uiDomain as string) || portalId;

  return {
    portalId,
    portalName,
    dataCenter: detectDataCenterFromPak(pak),
  };
}

/**
 * Upload a single file to the HubSpot CMS Design Manager.
 * Uses PUT /cms/v3/source-code/{env}/content/{path} with multipart form-data.
 */
export async function uploadFile(
  pak: string,
  remotePath: string,
  localFilePath: string,
): Promise<UploadResult> {
  const fileContent = readFileSync(localFilePath);
  const fileName = basename(localFilePath);

  // Build multipart form data
  const formData = new FormData();
  const blob = new Blob([fileContent]);
  formData.append("file", blob, fileName);

  const url = `${BASE_URL}/cms/v3/source-code/published/content/${encodePath(remotePath)}`;

  const resp = await fetchWithRetry(url, {
    method: "PUT",
    headers: await authHeaders(pak),
    body: formData,
  });

  if (!resp.ok) {
    const error = await parseErrorResponse(resp, remotePath);
    return { success: false, path: remotePath, error };
  }

  return { success: true, path: remotePath };
}

/**
 * Delete a file or directory from the HubSpot CMS Design Manager.
 */
export async function deleteFile(pak: string, remotePath: string): Promise<void> {
  const url = `${BASE_URL}/cms/v3/source-code/published/content/${encodePath(remotePath)}`;

  const resp = await fetchWithRetry(url, {
    method: "DELETE",
    headers: await authHeaders(pak),
  });

  if (!resp.ok && resp.status !== 404) {
    const error = await parseErrorResponse(resp, remotePath);
    throw new Error(`Failed to delete ${remotePath}: ${error.message}`);
  }
}

/**
 * Download a file from the HubSpot CMS Design Manager.
 */
export async function downloadFile(pak: string, remotePath: string): Promise<Buffer> {
  const url = `${BASE_URL}/cms/v3/source-code/published/content/${encodePath(remotePath)}`;

  const resp = await fetchWithRetry(url, {
    method: "GET",
    headers: await authHeaders(pak),
  });

  if (!resp.ok) {
    const error = await parseErrorResponse(resp, remotePath);
    throw new Error(`Failed to download ${remotePath}: ${error.message}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Get metadata for a file or directory in the HubSpot CMS Design Manager.
 * Returns null if the path doesn't exist (404).
 */
export async function getMetadata(pak: string, remotePath: string): Promise<FileMetadata | null> {
  const url = `${BASE_URL}/cms/v3/source-code/published/metadata/${encodePath(remotePath)}`;

  const resp = await fetchWithRetry(url, {
    method: "GET",
    headers: await authHeaders(pak),
  });

  if (resp.status === 404) return null;

  if (!resp.ok) {
    const error = await parseErrorResponse(resp, remotePath);
    throw new Error(`Failed to get metadata for ${remotePath}: ${error.message}`);
  }

  return (await resp.json()) as FileMetadata;
}

/**
 * List children of a directory in the HubSpot CMS Design Manager.
 * Returns empty array if the directory doesn't exist.
 */
export async function listDirectory(pak: string, remotePath: string): Promise<FileMetadata[]> {
  const meta = await getMetadata(pak, remotePath);
  if (!meta) return [];
  if (!meta.folder) return [meta];
  // HubSpot may return children as bare name strings or full metadata objects;
  // keep only the full objects so the FileMetadata[] contract holds.
  return (meta.children || []).filter(
    (child): child is FileMetadata => typeof child !== "string"
  );
}

/**
 * List root-level folders in the HubSpot CMS Design Manager.
 * Tries multiple API approaches since the metadata endpoint doesn't support root listing.
 */
export async function listRootFolders(pak: string): Promise<FileMetadata[]> {
  const headers = await authHeaders(pak);

  // Try different URL patterns for root metadata
  const urlVariants = [
    `${BASE_URL}/cms/v3/source-code/published/metadata`,       // no trailing slash
    `${BASE_URL}/cms/v3/source-code/published/metadata/`,      // trailing slash
    `${BASE_URL}/designmanager/v1/portals/content/listing`, // Design Manager API
  ];

  for (const url of urlVariants) {
    try {
      const resp = await fetch(url, { method: "GET", headers });
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        // Could be { children: [...] } or { objects: [...] } or direct array
        const children = (data.children || data.objects || (Array.isArray(data) ? data : null)) as FileMetadata[] | null;
        if (children && children.length > 0) {
          return children.filter((c: FileMetadata) => c.folder);
        }
      }
    } catch { /* try next */ }
  }

  return [];
}
