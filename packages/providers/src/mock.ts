import { ProviderError, type Provider, type ProviderRequest } from "./provider.js";

export function cloneAndFreeze<T>(value: T): T {
  return cloneValue(value, new Map<object, unknown>()) as T;
}

function cloneValue(value: unknown, clones: Map<object, unknown>): unknown {
  if (typeof value === "function") {
    return rejectUnsafeSnapshot();
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const existingClone = clones.get(value);
  if (existingClone !== undefined) {
    return existingClone;
  }

  if (Array.isArray(value)) {
    return cloneArray(value, clones);
  }

  return cloneObject(value, clones);
}

function cloneArray(value: unknown[], clones: Map<object, unknown>): readonly unknown[] {
  if (getPrototype(value) !== Array.prototype) {
    return rejectUnsafeSnapshot();
  }

  const descriptors = getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!isDataProperty(lengthDescriptor) || !isValidArrayLength(lengthDescriptor.value)) {
    return rejectUnsafeSnapshot();
  }

  const clone: unknown[] = new Array(lengthDescriptor.value);
  clones.set(value, clone);

  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") {
      continue;
    }

    if (typeof key !== "string") {
      return rejectUnsafeSnapshot();
    }

    const index = toArrayIndex(key);
    const descriptor = descriptors[key];
    if (
      index === undefined ||
      index >= lengthDescriptor.value ||
      !isEnumerableDataProperty(descriptor)
    ) {
      return rejectUnsafeSnapshot();
    }

    Object.defineProperty(clone, key, {
      value: cloneValue(descriptor.value, clones),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return Object.freeze(clone);
}

function cloneObject(value: object, clones: Map<object, unknown>): object {
  const prototype = getPrototype(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return rejectUnsafeSnapshot();
  }

  const descriptors = getOwnPropertyDescriptors(value);
  const clone = Object.create(prototype) as Record<string, unknown>;
  clones.set(value, clone);

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      return rejectUnsafeSnapshot();
    }

    const descriptor = descriptors[key];
    if (!isEnumerableDataProperty(descriptor)) {
      return rejectUnsafeSnapshot();
    }

    Object.defineProperty(clone, key, {
      value: cloneValue(descriptor.value, clones),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return Object.freeze(clone);
}

function getPrototype(value: object): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    return rejectUnsafeSnapshot();
  }
}

function getOwnPropertyDescriptors(value: object): PropertyDescriptorMap {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return rejectUnsafeSnapshot();
  }
}

function isDataProperty(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

function isEnumerableDataProperty(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return isDataProperty(descriptor) && descriptor.enumerable === true;
}

function isValidArrayLength(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2 ** 32 - 1
  );
}

function toArrayIndex(key: string): number | undefined {
  const index = Number(key);
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= 2 ** 32 - 1 ||
    String(index) !== key
  ) {
    return undefined;
  }

  return index;
}

function rejectUnsafeSnapshot(): never {
  throw new ProviderError("PROVIDER_INVALID_RESPONSE");
}

export class ScriptedMockProvider implements Provider {
  readonly #responses: readonly unknown[];
  readonly #recordedRequests: ProviderRequest[] = [];
  #nextResponseIndex = 0;

  constructor(responses: readonly unknown[]) {
    this.#responses = cloneAndFreeze(responses);
  }

  get requests(): readonly ProviderRequest[] {
    return cloneAndFreeze(this.#recordedRequests);
  }

  async complete(request: ProviderRequest): Promise<unknown> {
    this.#recordedRequests.push(cloneAndFreeze(request));
    const responseIndex = this.#nextResponseIndex;
    this.#nextResponseIndex += 1;

    if (responseIndex >= this.#responses.length) {
      throw new ProviderError("PROVIDER_SCRIPT_EXHAUSTED");
    }

    return cloneAndFreeze(this.#responses[responseIndex]);
  }
}
