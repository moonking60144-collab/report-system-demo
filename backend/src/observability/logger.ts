import pino from "pino";
import { env } from "../config/env";

// 開發模式下輸出人讀，production 輸出 JSON 行方便 log aggregation
const isProd = env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  base: { service: "ragic-report-backend" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.apiKey", "*.RAGIC_API_KEY"],
    remove: true,
  },
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino/file",
          options: { destination: 1 },
        },
      }),
});

// 子 logger 工廠：讓各模組帶自己的 context（例：module name）
export function createLogger(module: string) {
  return logger.child({ module });
}
