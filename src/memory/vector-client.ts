export const EMBEDDING_DIMENSION = 384;
export const MAX_EMBED_BATCH = 32;

export function localHttpUrl(value: string, label: string, allowQuery = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a valid loopback HTTP URL`); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== "http:" || !local || url.username || url.password || !allowQuery && url.search || url.hash) {
    throw new Error(`${label} must use unauthenticated loopback HTTP`);
  }
  return url;
}

export function serviceUrls() {
  return {
    qdrant: localHttpUrl(process.env.PI_MEMORY_QDRANT_URL ?? "http://127.0.0.1:6333", "Qdrant URL").toString().replace(/\/$/, ""),
    embedder: localHttpUrl(process.env.PI_MEMORY_EMBEDDER_URL ?? "http://127.0.0.1:6335", "Embedder URL").toString().replace(/\/$/, ""),
  };
}

export async function requestJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  localHttpUrl(url, "Local service URL", true);
  if (init.signal?.aborted) throw new Error("Local memory service request was cancelled");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Local memory service request timed out")), timeoutMs);
  const external = init.signal;
  const abort = () => controller.abort(external?.reason);
  external?.addEventListener("abort", abort, { once: true });
  if (external?.aborted) abort();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: "error", headers: { "content-type": "application/json", ...init.headers } });
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 8 * 1024 * 1024) {
      try { await response.body?.cancel(); } catch {}
      throw new Error("Local memory service response exceeded size limit");
    }
    let body = "";
    if (response.body) {
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 8 * 1024 * 1024) throw new Error("Local memory service response exceeded size limit");
          parts.push(value);
        }
      } catch (error) {
        try { await reader.cancel(); } catch {}
        throw error;
      } finally { reader.releaseLock(); }
      body = new TextDecoder().decode(Buffer.concat(parts));
    }
    let parsed: any;
    try { parsed = body ? JSON.parse(body) : {}; } catch { throw new Error("Local memory service returned invalid JSON"); }
    if (!response.ok) throw new Error(`Local memory service HTTP ${response.status}`);
    return parsed as T;
  } catch (error: any) {
    if (error?.name === "AbortError") throw new Error("Local memory service request timed out or was cancelled");
    throw error;
  } finally {
    clearTimeout(timeout);
    external?.removeEventListener("abort", abort);
  }
}

export interface ModelIdentity { model: string; revision: string; dimension: number; max_tokens: number; }
export async function embedTexts(base: string, texts: string[], inputType: "query" | "passage", signal?: AbortSignal) {
  if (!texts.length || texts.length > MAX_EMBED_BATCH || texts.some(text => !text.length || text.length > 8000)) throw new Error("Embedding batch must contain 1–32 nonempty texts of at most 8000 characters");
  const response = await requestJson<any>(`${base}/embed`, { method: "POST", body: JSON.stringify({ texts, input_type: inputType }), signal });
  if (!response || !Array.isArray(response.vectors) || response.vectors.length !== texts.length || !Number.isInteger(response.dimension) || response.dimension !== EMBEDDING_DIMENSION || typeof response.model !== "string" || typeof response.revision !== "string" || !response.revision) throw new Error("Embedder returned invalid model identity or vector count/dimension");
  for (const vector of response.vectors) {
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSION || vector.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n))) throw new Error("Embedder returned a non-finite or incorrectly dimensioned vector");
  }
  return { identity: { model: response.model, revision: response.revision, dimension: response.dimension } as ModelIdentity, vectors: response.vectors as number[][] };
}

export async function health(base: string, signal?: AbortSignal): Promise<ModelIdentity> {
  const value = await requestJson<any>(`${base}/health`, { signal });
  if (!value || value.status !== "ok" || typeof value.model !== "string" || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/i.test(value.revision) || value.dimension !== EMBEDDING_DIMENSION || value.max_tokens !== 512) throw new Error("Embedder health response does not match the local memory contract");
  return { model: value.model, revision: value.revision, dimension: value.dimension, max_tokens: value.max_tokens };
}
