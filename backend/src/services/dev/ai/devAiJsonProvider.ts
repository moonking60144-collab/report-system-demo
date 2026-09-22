import type { DevAiProviderName } from "@shared-types/ragicDefinitions";

export type { DevAiProviderName } from "@shared-types/ragicDefinitions";

export type DevAiEffort = "minimal" | "low" | "medium" | "high";

export interface DevAiJsonRequest {
  prompt: string;
  schema: Record<string, unknown>;
  model?: string;
  effort?: DevAiEffort;
  maxOutputTokens?: number;
  storeInteraction?: boolean;
  signal?: AbortSignal;
}

export interface DevAiJsonProvider {
  readonly name: DevAiProviderName;
  readonly model: string;
  generateJsonText(request: DevAiJsonRequest): Promise<string>;
}
