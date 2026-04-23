export function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

export function withOptionalString<
  T extends Record<string, unknown>,
  K extends string,
>(target: T, key: K, value: string | null | undefined): T & Partial<Record<K, string>> {
  const normalizedValue = normalizeOptionalString(value);
  if (normalizedValue === undefined) {
    return target as T & Partial<Record<K, string>>;
  }
  return {
    ...target,
    [key]: normalizedValue,
  } as T & Partial<Record<K, string>>;
}

export function withOptionalValue<
  T extends Record<string, unknown>,
  K extends string,
  V,
>(target: T, key: K, value: V | undefined): T & Partial<Record<K, V>> {
  if (value === undefined) {
    return target as T & Partial<Record<K, V>>;
  }
  return {
    ...target,
    [key]: value,
  } as T & Partial<Record<K, V>>;
}
