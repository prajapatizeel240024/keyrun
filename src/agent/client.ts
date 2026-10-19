import { assertLoopbackUrl } from '../config.ts';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Tiny JSON client for the control plane. Device calls use the device token; setup calls use the admin token. */
export class ServerClient {
  constructor(private baseUrl: string, private auth: { device?: { id: string; token: string }; adminToken?: string } = {}) {
    assertLoopbackUrl(baseUrl);
  }

  async req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.auth.device) headers.authorization = `Bearer ${this.auth.device.id}.${this.auth.device.token}`;
    if (this.auth.adminToken) headers['x-keyrun-admin'] = this.auth.adminToken;
    const res = await fetch(new URL(path, this.baseUrl), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json?.error ?? res.statusText);
    return json as T;
  }

  get<T = unknown>(path: string) {
    return this.req<T>('GET', path);
  }
  post<T = unknown>(path: string, body: unknown = {}) {
    return this.req<T>('POST', path, body);
  }
  put<T = unknown>(path: string, body: unknown) {
    return this.req<T>('PUT', path, body);
  }
}
