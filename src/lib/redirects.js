/**
 * Centralized dynamic URL and Redirect configuration
 * Reads all redirect endpoints from environment variables (.env)
 */

export function getFrontendUrl() {
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL.replace(/\/$/, "");
  }
  if (process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== "*") {
    return process.env.CORS_ORIGIN.split(",")[0].trim().replace(/\/$/, "");
  }
  return "http://localhost:3000";
}

export function getPaymentSuccessUrl(params = {}) {
  const base = process.env.PAYMENT_SUCCESS_URL || `${getFrontendUrl()}/payment-success`;
  try {
    const url = new URL(base);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    });
    return url.toString();
  } catch {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
    ).toString();
    return query ? `${base}?${query}` : base;
  }
}

export function getPaymentFailureUrl(params = {}) {
  const base = process.env.PAYMENT_FAILURE_URL || `${getFrontendUrl()}/payment-failure`;
  try {
    const url = new URL(base);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    });
    return url.toString();
  } catch {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
    ).toString();
    return query ? `${base}?${query}` : base;
  }
}

export function getPaymentCallbackUrl() {
  return (
    process.env.PAYMENT_CALLBACK_URL ||
    `${process.env.BACKEND_URL || "http://localhost:3001"}/api/payments/response`
  );
}
