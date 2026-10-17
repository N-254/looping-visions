export type SwipePoint = { x: number; y: number; time: number };
export function isDismissSwipe(start: SwipePoint, end: SwipePoint) {
  const dy = end.y - start.y;
  const dx = Math.abs(end.x - start.x);
  const elapsed = end.time - start.time;
  return dy >= 80 && dy > dx * 1.5 && elapsed >= 0 && elapsed <= 1500;
}
