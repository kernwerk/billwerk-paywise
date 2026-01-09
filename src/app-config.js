import dotenv from "dotenv";

dotenv.config();

function parseTriggerDays(value, defaultValue) {
  const fallback =
    defaultValue === undefined || defaultValue === null
      ? []
      : [Number(defaultValue)];
  const raw =
    value !== undefined && value !== null && String(value).trim() !== ""
      ? String(value)
      : null;
  if (!raw) {
    return fallback.filter((entry) => Number.isFinite(entry));
  }
  const days = raw
    .split(/[\s,]+/)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry))
    .map((entry) => Math.trunc(entry));
  if (days.length === 0) {
    return fallback.filter((entry) => Number.isFinite(entry));
  }
  return Array.from(new Set(days));
}

const config = {
  port: Number(process.env.PORT || 3000),
  billwerkBaseUrl: process.env.BILLWERK_BASE_URL || "https://app.billwerk.com",
  billwerkClientId: process.env.BILLWERK_CLIENT_ID,
  billwerkClientSecret: process.env.BILLWERK_CLIENT_SECRET,
  billwerkOauthUrl: `${(
    process.env.BILLWERK_BASE_URL || "https://app.billwerk.com"
  ).replace(/\/$/, "")}/oauth/token/`,
  paywiseBaseUrl: process.env.PAYWISE_BASE_URL || "https://api.paywise.de",
  paywiseToken: process.env.PAYWISE_TOKEN,
  webhookSharedSecret: process.env.WEBHOOK_SHARED_SECRET,
  billwerkTriggerDays: parseTriggerDays(process.env.BILLWERK_TRIGGER_DAYS, 30),
  billwerkDunningTriggerDays: parseTriggerDays(
    process.env.BILLWERK_DUNNING_TRIGGER_DAYS,
    22,
  ),
  billwerkDunningTemplateId: process.env.BILLWERK_DUNNING_TEMPLATE_ID || null,
  billwerkDunningTake: Number(process.env.BILLWERK_DUNNING_TAKE || 25),
  paywiseStartingApproach:
    process.env.PAYWISE_STARTING_APPROACH || "extrajudicial",
  paywiseDefaultCurrency: process.env.PAYWISE_DEFAULT_CURRENCY || "EUR",
  letterxpressBaseUrl:
    process.env.LETTERXPRESS_BASE_URL || "https://api.letterxpress.de",
  letterxpressUsername: process.env.LETTERXPRESS_USERNAME,
  letterxpressApiKey: process.env.LETTERXPRESS_API_KEY,
  letterxpressMode: process.env.LETTERXPRESS_MODE || "test",
  letterxpressColor: process.env.LETTERXPRESS_COLOR || "1",
  letterxpressPrintMode: process.env.LETTERXPRESS_PRINT_MODE || "simplex",
  letterxpressShipping: process.env.LETTERXPRESS_SHIPPING || "national",
  letterxpressC4: Number(process.env.LETTERXPRESS_C4 || 0),
};

export { config, parseTriggerDays };
