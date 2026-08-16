export function subtotal(items) {
  return items.reduce((total, item) => total + item.price, 0);
}

export function applyDiscount(amount, percentOff) {
  if (percentOff <= 0) return amount;
  if (percentOff >= 100) return 0;
  return Math.round(amount * (1 - percentOff / 100) * 100) / 100;
}
