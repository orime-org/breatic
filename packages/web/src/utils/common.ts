/**
 * Convert an unknown value into a human-readable string for display purposes.
 *
 * This utility is designed for safely rendering dynamic or unknown data
 * (e.g. API responses, debug values, table cells, logs) in the UI.
 *
 * Conversion rules:
 * - `null` or `undefined` → empty string ("")
 * - `string` or `number` → string representation
 * - `object` → pretty-printed JSON (2-space indentation)
 * - other types (boolean, symbol, bigint, etc.) → String(value)
 *
 * Notes:
 * - Objects are wrapped in a try/catch to prevent runtime errors
 *   caused by circular references.
 * - This function is intended for display only, not for serialization.
 *
 * @param value - Any value of unknown type
 * @returns A safe string representation suitable for UI display
 *
 * @example
 * ```ts
 * formatDisplayValue("Hello");
 * // → "Hello"
 *
 * formatDisplayValue(123);
 * // → "123"
 *
 * formatDisplayValue({ a: 1, b: 2 });
 * // → "{\n  \"a\": 1,\n  \"b\": 2\n}"
 *
 * formatDisplayValue(null);
 * // → ""
 * ```
 *
 * @example
 * ```ts
 * // Usage inside a React component
 * <pre>{formatDisplayValue(response.data)}</pre>
 * ```
 */
export const formatDisplayValue = (value: unknown): string => {
  if (value == null) return '';

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '[Object]';
    }
  }

  return String(value);
};


