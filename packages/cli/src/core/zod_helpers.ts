import { QuayError } from "./errors.ts";

interface SafeParseSchema<T> {
  safeParse: (
    v: unknown,
  ) =>
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: { path: (string | number)[]; message: string }[] };
      };
}

export function parseOrThrow<T>(
  schema: SafeParseSchema<T>,
  raw: unknown,
  label: string,
): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const summary = result.error.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  throw new QuayError("validation_error", `${label} input invalid: ${summary}`, {
    issues: result.error.issues,
  });
}
