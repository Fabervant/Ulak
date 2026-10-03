/** D1 refuses a statement that binds more than 100 parameters. The local database does not, so a
 *  list of unbounded length is bound in slices of at most this many, never whole. */
export const D1_MAX_PARAMS = 100;

/** The `?,?,?` list for an `IN (...)` of n values. */
export const placeholders = (n: number): string => Array(n).fill("?").join(",");

/** The list cut into consecutive slices of at most `size`. */
export const slices = <T>(xs: T[], size = D1_MAX_PARAMS): T[][] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));
