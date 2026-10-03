import type { TransformFnParams } from 'class-transformer';

// Read the raw body: implicit conversion has already turned the string "false"
// into true by the time a property transform receives `value`.
export function strictDriverBoolean({ obj, key }: TransformFnParams): unknown {
  const value: unknown = obj[key];
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value; // @IsBoolean rejects everything else (except optional null/undefined).
}
