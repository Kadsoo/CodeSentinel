export type ProviderRole = "system" | "user" | "assistant";

export type ProviderMessage = Readonly<{
  role: ProviderRole;
  content: string;
}>;

export type ProviderRequest = Readonly<{
  messages: readonly ProviderMessage[];
}>;

export interface Provider {
  complete(request: ProviderRequest): Promise<unknown>;
}

export type ProviderErrorCode =
  | "PROVIDER_INVALID_ENDPOINT"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_INVALID_RESPONSE"
  | "PROVIDER_SCRIPT_EXHAUSTED";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode) {
    super(code);
    this.name = "ProviderError";
    this.code = code;
    Object.freeze(this);
  }
}

const providerProbeMessage: ProviderMessage = Object.freeze({
  role: "user",
  content:
    'Return exactly this JSON finish response with no surrounding prose: {"kind":"finish","outcome":"completed","summary":"provider connectivity check"}',
});

const providerProbeMessages: readonly ProviderMessage[] = Object.freeze([providerProbeMessage]);

export const PROVIDER_PROBE_REQUEST: ProviderRequest = Object.freeze({
  messages: providerProbeMessages,
});

export async function probeProvider(provider: Provider): Promise<void> {
  await provider.complete(PROVIDER_PROBE_REQUEST);
}
