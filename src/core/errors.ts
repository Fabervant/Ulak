export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: string,
    public retryable: boolean = status >= 500 || status === 429,
    public extra: Record<string, unknown> = {},
    public headers: Record<string, string> = {},
  ) {
    super(detail);
  }

  body(): Record<string, unknown> {
    return { error: this.code, retryable: this.retryable, detail: this.detail, ...this.extra };
  }

  toResponse(): Response {
    return new Response(JSON.stringify(this.body()), {
      status: this.status,
      headers: { "content-type": "application/json; charset=utf-8", ...this.headers },
    });
  }
}

export const invalid = (field: string, detail: string): ApiError =>
  new ApiError(400, "invalid_request", detail, false, { field });
