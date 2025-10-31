export function msToHumanShort(ms: number): string {
  const units = [
    { label: "d", ms: 86400000 },
    { label: "h", ms: 3600000 },
    { label: "min", ms: 60000 },
    { label: "s", ms: 1000 },
    { label: "ms", ms: 1 },
  ];

  const parts: string[] = [];

  for (const { label, ms: unitMs } of units) {
    if (ms >= unitMs) {
      const count = Math.floor(ms / unitMs);
      ms %= unitMs;
      parts.push(`${count}${label}`);
      if (parts.length === 3) break; // Limit to three components
    }
  }

  return parts.join(", ") || "0ms";
}

