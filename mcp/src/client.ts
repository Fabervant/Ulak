export interface ListQuery {
  app?: string;
  status?: string;
  since?: string;
  limit?: number;
}

/** Thin client over the Ulak admin API. Throws with the API's error code on any non-2xx. */
export class UlakClient {
  private base: string;
  constructor(
    baseUrl: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...(init.headers as Record<string, string>) },
    });
    const text = await res.text();
    if (!res.ok) {
      let code = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: string; detail?: string };
        if (j.error) code = `${j.error}: ${j.detail ?? ""}`;
      } catch {
        // keep the HTTP code
      }
      throw new Error(`Ulak admin API ${code}`);
    }
    return JSON.parse(text) as T;
  }

  listMessages(q: ListQuery = {}): Promise<{ messages: unknown[] }> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    const qs = p.toString();
    return this.call(`/api/messages${qs ? `?${qs}` : ""}`);
  }
  getMessage(id: string): Promise<unknown> {
    return this.call(`/api/messages/${encodeURIComponent(id)}`);
  }
  reply(id: string, content: string): Promise<unknown> {
    return this.call(`/api/messages/${encodeURIComponent(id)}/replies`, { method: "POST", body: JSON.stringify({ content }) });
  }
  setStatus(id: string, status: string): Promise<unknown> {
    return this.call(`/api/messages/${encodeURIComponent(id)}/status`, { method: "POST", body: JSON.stringify({ status }) });
  }
  checks(): Promise<unknown> {
    return this.call("/api/checks");
  }
}
