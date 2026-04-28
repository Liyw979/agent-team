import JSON5 from "json5";

export function parseJson5<T = unknown>(input: string): T {
  return JSON5.parse(input) as T;
}
