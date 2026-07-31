export const DEFAULT_STRUCTURAL_TEXT_LENGTH = 1_024;

export function serializeStructuralText(
  value: unknown,
  maxLength = DEFAULT_STRUCTURAL_TEXT_LENGTH,
): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new Error('Structural text length must be a positive integer');
  }

  let output = '';
  let pendingSpace = false;
  for (const character of String(value ?? '')) {
    let escaped = JSON.stringify(character).slice(1, -1)
      .replaceAll('\u2028', '\\u2028')
      .replaceAll('\u2029', '\\u2029');
    if (/^\s+$/u.test(escaped)) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) escaped = ` ${escaped}`;
    pendingSpace = false;
    if (output.length + escaped.length > maxLength) break;
    output += escaped;
  }
  return output;
}
