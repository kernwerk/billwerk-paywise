function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function formatAmount(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num.toFixed(2);
}

function normalizeAmount(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function logAxiosError(service, error) {
  const response = error?.response;
  const request = response?.config;
  const status = response?.status;
  const url = request?.baseURL
    ? `${request.baseURL}${request.url || ""}`
    : request?.url;
  const method = request?.method;
  const safeHeaders = sanitizeHeaders(request?.headers);
  const data = response?.data;

  console.error(`[${service}] request failed`, {
    status,
    method,
    url,
    headers: safeHeaders,
    data,
  });
}

function sanitizeHeaders(headers) {
  if (!headers) return undefined;
  const lowered = {};
  for (const [key, value] of Object.entries(headers)) {
    lowered[key.toLowerCase()] = value;
  }
  if (lowered.authorization) {
    lowered.authorization = "[REDACTED]";
  }
  if (lowered.apikey) {
    lowered.apikey = "[REDACTED]";
  }
  return lowered;
}

export { toDateOnly, formatAmount, normalizeAmount, logAxiosError };
