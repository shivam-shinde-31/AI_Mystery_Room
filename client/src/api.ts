const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api/v1';
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...init.headers } });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'The request could not be completed.');
  return data as T;
}
