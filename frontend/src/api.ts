const API_BASE = import.meta.env.VITE_API_URL ?? "";
function tokenKey(): string {
  return window.location.pathname.startsWith("/platform")
    ? "medical-erp-platform-access-token"
    : "medical-erp-access-token";
}

export function getToken(): string | null {
  return sessionStorage.getItem(tokenKey());
}

export function saveToken(token: string | null): void {
  if (token) sessionStorage.setItem(tokenKey(), token);
  else sessionStorage.removeItem(tokenKey());
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const detail =
      typeof payload === "object" && payload !== null && "detail" in payload
        ? String(payload.detail)
        : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function post<T>(path: string, data: unknown, headers?: HeadersInit): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(data), headers });
}

export function patch<T>(path: string, data: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
}
