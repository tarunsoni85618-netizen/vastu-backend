import crypto from "node:crypto";

export function isPayUConfigured() {
  return Boolean(process.env.PAYU_KEY && process.env.PAYU_SALT);
}

export function getPayUEndpoint(req) {
  const env = (process.env.PAYU_ENV || "test").toLowerCase();
  if (env === "production") {
    return "https://secure.payu.in/_payment";
  }
  if (env === "test_payu" || process.env.PAYU_FORCE_REMOTE_TEST === "true") {
    return "https://test.payu.in/_payment";
  }

  // High-availability sandbox gateway simulator for test environment
  if (process.env.PAYU_GATEWAY_URL) {
    return process.env.PAYU_GATEWAY_URL;
  }
  if (process.env.PAYU_SUCCESS_URL) {
    try {
      const u = new URL(process.env.PAYU_SUCCESS_URL);
      return `${u.origin}/api/payments/payu/gateway`;
    } catch {}
  }
  if (req && req.get) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.get("host") || "localhost:3001";
    return `${proto}://${host}/api/payments/payu/gateway`;
  }
  return "https://vastu-backend-sczw.onrender.com/api/payments/payu/gateway";
}

/**
 * Generate PayU checkout hash
 * sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
 */
export function generatePayUHash({
  txnid,
  amount,
  productinfo,
  firstname,
  email,
  udf1 = "",
  udf2 = "",
  udf3 = "",
  udf4 = "",
  udf5 = "",
}) {
  const key = process.env.PAYU_KEY || "TEST_KEY";
  const salt = process.env.PAYU_SALT || "TEST_SALT";

  const formattedAmount = Number(amount).toFixed(2);
  const hashString = `${key}|${txnid}|${formattedAmount}|${productinfo}|${firstname}|${email}|${udf1}|${udf2}|${udf3}|${udf4}|${udf5}||||||${salt}`;

  return crypto.createHash("sha512").update(hashString).digest("hex");
}

/**
 * Verify PayU payment response hash
 * sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 * Or with additionalCharges:
 * sha512(additionalCharges|SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 */
export function verifyPayUResponse(data) {
  const salt = process.env.PAYU_SALT || "TEST_SALT";
  const key = process.env.PAYU_KEY || "TEST_KEY";

  if (!data) return false;

  // In test simulator mode
  if (data.isSimulator) {
    return data.status === "success";
  }

  const {
    txnid,
    amount,
    productinfo,
    firstname,
    email,
    status,
    hash,
    udf1 = "",
    udf2 = "",
    udf3 = "",
    udf4 = "",
    udf5 = "",
    additionalCharges,
  } = data;

  const formattedAmount = Number(amount).toFixed(2);

  let hashSequence = `${salt}|${status}||||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${formattedAmount}|${txnid}|${key}`;

  if (additionalCharges) {
    hashSequence = `${additionalCharges}|${hashSequence}`;
  }

  const calculatedHash = crypto
    .createHash("sha512")
    .update(hashSequence)
    .digest("hex");

  return calculatedHash.toLowerCase() === (hash || "").toLowerCase();
}
