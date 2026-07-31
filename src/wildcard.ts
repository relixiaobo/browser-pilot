export function wildcardMatch(value: string, pattern: string): boolean {
  const input = value.toLowerCase();
  const expected = pattern.toLowerCase();
  let inputIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let starInputIndex = -1;

  while (inputIndex < input.length) {
    if (patternIndex < expected.length && expected[patternIndex] === input[inputIndex]) {
      inputIndex += 1;
      patternIndex += 1;
      continue;
    }
    if (patternIndex < expected.length && expected[patternIndex] === '*') {
      starIndex = patternIndex;
      starInputIndex = inputIndex;
      patternIndex += 1;
      continue;
    }
    if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starInputIndex += 1;
      inputIndex = starInputIndex;
      continue;
    }
    return false;
  }

  while (patternIndex < expected.length && expected[patternIndex] === '*') patternIndex += 1;
  return patternIndex === expected.length;
}
