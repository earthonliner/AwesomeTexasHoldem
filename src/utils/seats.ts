/**
 * Compute elliptical seat positions around the table. Seat 0 (hero) is anchored
 * at the bottom-center; remaining seats spread clockwise around the ring.
 * Returns percentages relative to the table container.
 */
export function seatPositions(count: number): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];
  // Start angle at bottom (90deg) and go clockwise.
  const startAngle = Math.PI / 2;
  for (let i = 0; i < count; i++) {
    const angle = startAngle + (i / count) * Math.PI * 2;
    const x = 50 + Math.cos(angle) * 42;
    const y = 50 + Math.sin(angle) * 40;
    positions.push({ x, y });
  }
  return positions;
}
