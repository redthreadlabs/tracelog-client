/**
 * Minutes east of UTC right now (ISO-8601 sign: localWallClock = UTC + offset).
 * `Date.prototype.getTimezoneOffset()` returns minutes to ADD to local to get
 * UTC (so it's inverted, e.g. +300 for EST); negating gives the conventional
 * eastward offset (EST = -300, IST = +330). Captured at record time so a
 * buffered event reflects where/when it actually happened.
 */
export function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}
