interface Point {
  x: number;
  y: number;
}

export function ellipseBetween(origin: Point, destination: Point) {
  const dx = destination.x - origin.x;
  const dy = destination.y - origin.y;
  const chord = Math.hypot(dx, dy);
  if (!(chord > 0)) {
    throw new RangeError('Transfer endpoints must have distinct planar coordinates');
  }
  const ex = dx / chord;
  const ey = dy / chord;
  const projection = ((origin.x + destination.x) * ex + (origin.y + destination.y) * ey) / 2;
  const a = (Math.hypot(origin.x, origin.y) + Math.hypot(destination.x, destination.y)) / 2;
  const b = Math.sqrt(a ** 2 - projection ** 2);
  if (!(b > 0)) {
    throw new RangeError('Transfer ellipse is degenerate');
  }
  const height = Math.abs(-ey * origin.x + ex * origin.y);
  const angle = Math.atan2(height / b, chord / (2 * a));
  // The short arc is symmetric. Simpson quadrature integrates half of it.
  const intervals = 128;
  const step = (Math.PI / 2 - angle) / intervals;
  const derivative = (theta: number) => Math.hypot(a * Math.sin(theta), b * Math.cos(theta));
  let sum = derivative(angle) + derivative(Math.PI / 2);
  for (let i = 1; i < intervals; i++) {
    sum += (i % 2 === 0 ? 2 : 4) * derivative(angle + i * step);
  }
  return { a, b, length: (2 * step * sum) / 3 };
}
