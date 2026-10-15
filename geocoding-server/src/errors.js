class ValidationError extends Error {}
class NotFoundError extends Error {}
class OutOfRangeError extends Error {}
class QuotaExceededError extends Error {}
class PaymentError extends Error {}
class UnauthorizedError extends Error {}
// A third-party service Meridian depends on (currently just the public
// Overpass API -- see placesSearch.js) failed, timed out, or rate-limited
// us -- not a bug in this app, not the caller's fault either. Maps to
// HTTP 502, distinct from a plain 500 so it's clear from the outside
// that retrying later is the right move.
class UpstreamError extends Error {}
// An unauthenticated caller has exceeded the per-IP rate limit on
// /geocode or /reverse-geocode (see geocodeRateLimit.js). Maps to HTTP
// 429, same status QuotaExceededError already uses for the analogous
// authenticated-but-over-quota case.
class RateLimitError extends Error {}

module.exports = {
  ValidationError,
  NotFoundError,
  OutOfRangeError,
  QuotaExceededError,
  PaymentError,
  UnauthorizedError,
  UpstreamError,
  RateLimitError,
};
