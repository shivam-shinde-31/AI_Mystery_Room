const BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:4000/api/v1' : '/api/v1')).replace(/\/$/, '');
let rateLimitedUntil = 0;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  if (Date.now() < rateLimitedUntil) {
    const seconds = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    throw new ApiError(`Too many requests. Please wait ${seconds} seconds, then try again.`, 429);
  }
  const response = await fetch(`${BASE}${path}`, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...init.headers } });
  if (response.status === 204) return undefined as T;
  const body = await response.text();
  let data: any;
  const isHtml = /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(body);
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    const retryAfterSeconds = Number(retryAfter);
    const retryAt = retryAfter && Number.isFinite(retryAfterSeconds)
      ? Date.now() + Math.max(1, retryAfterSeconds) * 1000
      : retryAfter && Number.isNaN(retryAfterSeconds) && !Number.isNaN(Date.parse(retryAfter))
        ? Date.parse(retryAfter)
        : Date.now() + 60_000;
    rateLimitedUntil = Math.max(rateLimitedUntil, retryAt);
  }
  if (body) {
    try {
      data = JSON.parse(body);
    } catch {
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? `${retryAfter} seconds` : 'about a minute';
        throw new ApiError(`Too many requests. Please wait ${wait}, then try again.`, 429);
      }
      if (isHtml) {
        const hint = response.status >= 500
          ? 'The API server may be waking up or temporarily unavailable. Wait a minute and retry.'
          : 'The API proxy did not reach the backend. Check the Vercel rewrite and VITE_API_BASE_URL.';
        throw new ApiError(`The API returned an HTML page instead of JSON (HTTP ${response.status}). ${hint}`, response.status);
      }
      const message = body.trim().slice(0, 180);
      throw new ApiError(response.ok
        ? `The API returned a non-JSON response (HTTP ${response.status}).`
        : `API request failed (HTTP ${response.status}): ${message || response.statusText}`, response.status);
    }
  } else {
    data = {};
  }
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? `${retryAfter} seconds` : 'about a minute';
      throw new ApiError(`Too many requests. Please wait ${wait}, then try again.`, 429);
    }
    throw new ApiError(data?.error?.message || 'The request could not be completed.', response.status);
  }
  return data as T;
}
