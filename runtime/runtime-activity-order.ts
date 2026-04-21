export function pickRecentPartIndexes(partsLength: number, maxActivities: number): number[] {
  if (!Number.isInteger(partsLength) || partsLength <= 0) {
    return [];
  }

  if (!Number.isInteger(maxActivities) || maxActivities <= 0) {
    return [];
  }

  const startIndex = Math.max(0, partsLength - maxActivities);
  return Array.from({ length: partsLength - startIndex }, (_, offset) => startIndex + offset);
}
