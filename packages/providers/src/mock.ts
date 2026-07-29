import { ProviderError, type Provider, type ProviderRequest } from "./provider.js";

export function cloneAndFreeze<T>(value: T): T {
  return cloneValue(value, new Map<object, unknown>()) as T;
}

function cloneValue(value: unknown, clones: Map<object, unknown>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const existingClone = clones.get(value);
  if (existingClone !== undefined) {
    return existingClone;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    clones.set(value, clone);

    for (const item of value) {
      clone.push(cloneValue(item, clones));
    }

    return Object.freeze(clone);
  }

  const clone: Record<string, unknown> = {};
  clones.set(value, clone);

  for (const key of Object.keys(value)) {
    Object.defineProperty(clone, key, {
      value: cloneValue((value as Record<string, unknown>)[key], clones),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return Object.freeze(clone);
}

export class ScriptedMockProvider implements Provider {
  private readonly responses: readonly unknown[];
  private readonly recordedRequests: ProviderRequest[] = [];

  constructor(responses: readonly unknown[]) {
    this.responses = cloneAndFreeze(responses);
  }

  get requests(): readonly ProviderRequest[] {
    return cloneAndFreeze(this.recordedRequests);
  }

  async complete(request: ProviderRequest): Promise<unknown> {
    this.recordedRequests.push(cloneAndFreeze(request));
    const responseIndex = this.recordedRequests.length - 1;

    if (responseIndex >= this.responses.length) {
      throw new ProviderError("PROVIDER_SCRIPT_EXHAUSTED");
    }

    return cloneAndFreeze(this.responses[responseIndex]);
  }
}
