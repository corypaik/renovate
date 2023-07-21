import is from '@sindresorhus/is';

/**
 * Assigns non-nullish values from `right` to `left` for the given `keys`.
 */
export function assignKeys<
  Left extends { [key in K]?: Right[key] },
  Right extends { [key in K]?: any },
  K extends keyof Right
>(left: Left, right: Right, keys: K[]): Left {
  for (const key of keys) {
    const val = right[key];
    if (!is.nullOrUndefined(val)) {
      left[key] = val;
    }
  }
  return left;
}
