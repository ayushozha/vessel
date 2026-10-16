// Client-safe money formatting (src/lib/usage.ts bundles the price dataset and stays server-only).
/** "$0.0123" for small sums, "$1.23" otherwise. */
export const formatUsd = (usd: number) => `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
