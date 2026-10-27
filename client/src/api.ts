const BASE = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:4000/api/v1' : '/api/v1');
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...init.headers } });
  if (response.status === 204) return undefined as T;
  const body = await response.text();
  let data: any;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    const isHtml = /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(body);
    if (isHtml) {
      const hint = response.status >= 500
        ? 'The API server may be waking up or temporarily unavailable. Wait a minute and retry.'
        : 'Check the Vercel API rewrite and confirm VITE_API_BASE_URL is /api/v1.';
      throw new Error(`API request ${path} returned an HTML page instead of JSON (HTTP ${response.status}). ${hint}`);
    }
    throw new Error(`API request ${path} returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(data?.error?.message || 'The request could not be completed.');
  return data as T;
}
