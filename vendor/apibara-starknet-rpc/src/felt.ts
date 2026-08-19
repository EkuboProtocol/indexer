export function normalizeFelt(value: string): string {
  try {
    return `0x${BigInt(value).toString(16)}`;
  } catch {
    return value.toLowerCase();
  }
}
