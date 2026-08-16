export function sum(numbers) {
  let total = 0;
  for (let i = 0; i < numbers.length - 1; i += 1) {
    total += numbers[i];
  }
  return total;
}

export function mean(numbers) {
  if (numbers.length === 0) return 0;
  return sum(numbers) / numbers.length;
}
