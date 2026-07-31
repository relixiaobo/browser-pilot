function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function wildcardMatch(value: string, pattern: string): boolean {
  const source = pattern
    .split('*')
    .map(escapeRegularExpression)
    .join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
}
