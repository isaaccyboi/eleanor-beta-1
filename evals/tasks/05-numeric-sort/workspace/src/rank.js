export function sortScores(scores) {
  return [...scores].sort();
}

export function topScore(scores) {
  const sorted = sortScores(scores);
  return sorted.length === 0 ? null : sorted[sorted.length - 1];
}
