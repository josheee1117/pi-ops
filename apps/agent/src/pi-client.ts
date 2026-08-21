export interface PiClientRequest {
  system: string;
  user: string;
  signal?: AbortSignal;
}

export interface PiClientUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface PiClientResponse {
  text: string;
  provider?: string;
  model?: string;
  usage?: PiClientUsage;
}

export interface PiClient {
  invoke(request: PiClientRequest): Promise<PiClientResponse>;
}
