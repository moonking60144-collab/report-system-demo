export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** 使用者輸入錯誤（400-level），不用驚動 console.error */
export class ValidationError extends HttpError {
  constructor(message: string, code = "INVALID_PAYLOAD") {
    super(400, message, code);
    this.name = "ValidationError";
  }
}

/** 上游（Ragic API）錯誤，502 回傳 */
export class UpstreamError extends HttpError {
  constructor(
    message: string,
    code = "UPSTREAM_ERROR",
    public readonly upstreamDetail?: unknown
  ) {
    super(502, message, code);
    this.name = "UpstreamError";
  }
}
