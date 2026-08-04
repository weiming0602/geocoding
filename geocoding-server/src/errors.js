class ValidationError extends Error {}
class NotFoundError extends Error {}
class OutOfRangeError extends Error {}
class QuotaExceededError extends Error {}
class PaymentError extends Error {}
class UnauthorizedError extends Error {}

module.exports = {
  ValidationError,
  NotFoundError,
  OutOfRangeError,
  QuotaExceededError,
  PaymentError,
  UnauthorizedError,
};
