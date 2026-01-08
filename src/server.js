const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

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
  paywiseStartingApproach:
    process.env.PAYWISE_STARTING_APPROACH || "extrajudicial",
  paywiseDefaultCurrency: process.env.PAYWISE_DEFAULT_CURRENCY || "EUR",
};

const billwerk = axios.create({
  baseURL: config.billwerkBaseUrl,
  headers: { "Content-Type": "application/json" },
  timeout: 20000,
});

const paywise = axios.create({
  baseURL: config.paywiseBaseUrl,
  headers: {
    Authorization: config.paywiseToken
      ? `Bearer ${config.paywiseToken}`
      : undefined,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

const app = express();
app.use(express.json({ limit: "1mb" }));

const billwerkAuth = {
  accessToken: null,
  expiresAt: 0,
  inFlight: null,
};

billwerk.interceptors.request.use(async (request) => {
  const authorization = await getBillwerkAuthorization();
  if (authorization) {
    request.headers.Authorization = authorization;
  }
  return request;
});

billwerk.interceptors.response.use(
  (response) => response,
  (error) => {
    logAxiosError("billwerk", error);
    return Promise.reject(error);
  },
);

paywise.interceptors.response.use(
  (response) => response,
  (error) => {
    logAxiosError("paywise", error);
    return Promise.reject(error);
  },
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/webhooks/billwerk/payment-escalated", async (req, res) => {
  try {
    if (config.webhookSharedSecret) {
      const sharedSecret = req.get("x-webhook-secret");
      if (!sharedSecret || sharedSecret !== config.webhookSharedSecret) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const event = req.body || {};
    if (event.Event !== "PaymentEscalated") {
      return res.status(202).json({ status: "ignored" });
    }

    if (!hasBillwerkCredentials() || !config.paywiseToken) {
      return res.status(500).json({ error: "Missing API credentials" });
    }

    const contractId = event.ContractId;
    const customerId = event.CustomerId;
    if (!contractId || !customerId) {
      return res
        .status(422)
        .json({ error: "Missing ContractId or CustomerId" });
    }

    const dueDate = toDateOnly(event.DueDate);

    const [contract, customer, ledgerEntries] = await Promise.all([
      getContract(contractId),
      getCustomer(customerId),
      getLedgerEntries(contractId),
    ]);

    const receivableEntry = pickReceivableEntry(ledgerEntries, dueDate);
    const invoice = await resolveInvoice({
      contractId,
      customerId,
      dueDate,
      receivableEntry,
    });

    const debtorId = await ensureDebtor(customer, invoice);

    const documentReference =
      invoice?.InvoiceNumber || invoice?.Id || contractId;
    const claimReference = `billwerk:${documentReference}`;
    const existingClaim = await findExistingClaim(
      documentReference,
      claimReference,
    );
    if (existingClaim) {
      return res
        .status(200)
        .json({ status: "exists", claimId: existingClaim.id });
    }

    const openAmount = pickOpenAmount(contract, receivableEntry, invoice);
    const claimPayload = buildClaimPayload({
      debtorId,
      contract,
      customer,
      invoice,
      event,
      dueDate,
      openAmount,
      documentReference,
      claimReference,
    });

    const createdClaim = await paywise.post("/v1/claims/", claimPayload);
    const claimId = createdClaim.data?.id;
    if (!claimId) {
      throw new Error("Missing claim id after Paywise creation");
    }

    const targetDocumentAmount = normalizeAmount(
      openAmount ?? invoice?.TotalGross,
    );
    if (targetDocumentAmount) {
      await uploadClaimDocumentsFromBillwerk({
        claimId,
        contractId,
        customerId,
        targetAmount: targetDocumentAmount,
      });
    } else {
      console.warn("[paywise] skipping document upload, missing amount");
    }

    await releasePaywiseClaim(claimId);

    const paywiseCaseReference = claimId || claimReference || documentReference;
    const billwerkPaymentAmount = pickBillwerkPaymentAmount(
      openAmount,
      invoice,
    );
    const billwerkPaymentCurrency = invoice?.Currency || contract?.Currency;
    if (!billwerkPaymentAmount || !billwerkPaymentCurrency) {
      throw new Error("Missing Billwerk payment amount or currency");
    }
    await bookBillwerkPayment({
      contractId,
      amount: billwerkPaymentAmount,
      currency: billwerkPaymentCurrency,
      description: `Übergabe an Paywise. AZ: ${paywiseCaseReference}`,
      bookingDate: toDateOnly(new Date()),
    });
    return res
      .status(201)
      .json({ status: "created", claimId: createdClaim.data.id });
  } catch (error) {
    const message = error.response?.data || error.message || "Unknown error";
    const status = error.response?.status || 500;
    return res.status(status).json({ error: message });
  }
});

function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function hasBillwerkCredentials() {
  return Boolean(config.billwerkClientId && config.billwerkClientSecret);
}

async function getBillwerkAuthorization() {
  if (!(config.billwerkClientId && config.billwerkClientSecret)) {
    return null;
  }
  const token = await getBillwerkAccessToken();
  return token ? `Bearer ${token}` : null;
}

async function getBillwerkAccessToken() {
  const now = Date.now();
  if (billwerkAuth.accessToken && now < billwerkAuth.expiresAt) {
    return billwerkAuth.accessToken;
  }
  if (billwerkAuth.inFlight) {
    return billwerkAuth.inFlight;
  }

  billwerkAuth.inFlight = fetchBillwerkAccessToken()
    .then((token) => {
      billwerkAuth.accessToken = token.accessToken;
      billwerkAuth.expiresAt = token.expiresAt;
      return token.accessToken;
    })
    .finally(() => {
      billwerkAuth.inFlight = null;
    });

  return billwerkAuth.inFlight;
}

async function fetchBillwerkAccessToken() {
  const payload = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.billwerkClientId,
    client_secret: config.billwerkClientSecret,
  });

  try {
    const response = await axios.post(
      config.billwerkOauthUrl,
      payload.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 20000,
      },
    );

    const accessToken = response.data?.access_token;
    if (!accessToken) {
      throw new Error("Missing Billwerk access token");
    }

    const expiresIn = Number(response.data?.expires_in || 0);
    const ttlSeconds = expiresIn > 120 ? expiresIn - 60 : 300;
    const expiresAt = Date.now() + ttlSeconds * 1000;

    return { accessToken, expiresAt };
  } catch (error) {
    const response = error?.response;
    console.error("[billwerk] oauth token request failed", {
      status: response?.status,
      url: config.billwerkOauthUrl,
      data: response?.data,
    });
    throw error;
  }
}

function formatAmount(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num.toFixed(2);
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
  return lowered;
}

function pickReceivableEntry(entries, dueDate) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const receivables = entries.filter((entry) => entry.Type === "Receivable");
  if (receivables.length === 0) return null;

  const dueDateOnly = toDateOnly(dueDate);
  if (dueDateOnly) {
    const match = receivables.find(
      (entry) => entry.InvoiceId && toDateOnly(entry.DueDate) === dueDateOnly,
    );
    if (match) return match;
  }

  const withInvoice = receivables.filter((entry) => entry.InvoiceId);
  const sorted = (withInvoice.length ? withInvoice : receivables)
    .slice()
    .sort((a, b) => {
      const aDate = new Date(a.DueDate || 0).getTime();
      const bDate = new Date(b.DueDate || 0).getTime();
      return bDate - aDate;
    });
  return sorted[0] || null;
}

async function getContract(contractId) {
  const response = await billwerk.get(`/api/v1/contracts/${contractId}`);
  return response.data;
}

async function getCustomer(customerId) {
  const response = await billwerk.get(`/api/v1/customers/${customerId}`);
  return response.data;
}

async function getLedgerEntries(contractId) {
  const response = await billwerk.get(
    `/api/v1/contracts/${contractId}/ledgerentries`,
    {
      params: { take: 500 },
    },
  );
  return response.data;
}

async function uploadClaimDocumentsFromBillwerk({
  claimId,
  contractId,
  customerId,
  targetAmount,
}) {
  const invoiceList = await listInvoices(customerId);
  const contractInvoices = invoiceList
    .filter((entry) => entry.ContractId === contractId)
    .sort((a, b) => getDocumentSortTime(b) - getDocumentSortTime(a))
    .slice(0, 6);

  if (contractInvoices.length === 0) {
    console.warn("[paywise] no invoices found for document upload", {
      contractId,
    });
    return;
  }

  const selection = findMatchingDocumentCombination(
    contractInvoices,
    targetAmount,
  );

  if (!selection) {
    console.warn(
      "[paywise] no document combination matches open amount, skipping",
      {
        targetAmount,
        invoiceIds: contractInvoices.map((entry) => entry.Id),
      },
    );
    return;
  }

  for (const billwerkInvoice of selection) {
    if (!billwerkInvoice?.Id) continue;
    const pdf = await downloadInvoicePdf(billwerkInvoice.Id);
    const filename = buildInvoiceFilename(billwerkInvoice);
    await uploadPaywiseClaimDocument(claimId, pdf, filename);
  }
}

async function downloadInvoicePdf(invoiceId) {
  const linkResponse = await billwerk.post(
    `/api/v1/invoices/${invoiceId}/downloadlink`,
  );
  const rawUrl = linkResponse.data?.Url;
  if (!rawUrl) {
    throw new Error(`Missing invoice download link for ${invoiceId}`);
  }
  const downloadUrl = new URL(rawUrl, config.billwerkBaseUrl).toString();
  const response = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
    timeout: 20000,
  });
  return Buffer.from(response.data);
}

async function uploadPaywiseClaimDocument(claimId, fileBuffer, filename) {
  if (typeof FormData === "undefined" || typeof Blob === "undefined") {
    throw new Error("FormData/Blob not available in this Node.js runtime");
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([fileBuffer], { type: "application/pdf" }),
    filename,
  );

  const url = `${config.paywiseBaseUrl.replace(
    /\/$/,
    "",
  )}/v1/claims/${claimId}/documents/`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.paywiseToken}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[paywise] document upload failed", {
      status: response.status,
      url,
      body: errorBody,
    });
    throw new Error(`Paywise document upload failed (${response.status})`);
  }
}

function buildInvoiceFilename(invoice) {
  const base = invoice?.InvoiceNumber || invoice?.Id || "invoice";
  const safeBase = String(base).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safeBase}.pdf`;
}

function findMatchingDocumentCombination(documents, targetAmount) {
  const target = normalizeAmount(targetAmount);
  if (!target) return null;

  const selected = [];
  const tolerance = 0.01;

  function dfs(index, sum) {
    if (selected.length > 0 && Math.abs(sum - target) <= tolerance) {
      return true;
    }
    if (index >= documents.length) {
      return false;
    }

    const amount = getDocumentAmount(documents[index]);
    if (amount !== null) {
      selected.push(documents[index]);
      if (dfs(index + 1, sum + amount)) {
        return true;
      }
      selected.pop();
    }

    return dfs(index + 1, sum);
  }

  return dfs(0, 0) ? selected : null;
}

function getDocumentAmount(document) {
  if (!document) return null;
  const raw = Number(document.TotalGross);
  if (!Number.isFinite(raw)) return null;
  if (document.IsInvoice === false && raw > 0) {
    return -raw;
  }
  return raw;
}

function getDocumentSortTime(document) {
  const value =
    document?.DocumentDate ||
    document?.SentAt ||
    document?.Created ||
    document?.DueDate ||
    0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function normalizeAmount(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

async function bookBillwerkPayment({
  contractId,
  amount,
  currency,
  description,
  bookingDate,
}) {
  const payload = {
    Amount: amount,
    Currency: currency,
    Description: description,
  };

  if (bookingDate) {
    payload.BookingDate = bookingDate;
  }

  await billwerk.post(`/api/v1/contracts/${contractId}/payment`, payload);
}

async function releasePaywiseClaim(claimId) {
  await paywise.patch(`/v1/claims/${claimId}/`, {
    submission_state: "released",
    send_order_confirmation: true,
  });
}

async function resolveInvoice({
  contractId,
  customerId,
  dueDate,
  receivableEntry,
}) {
  if (receivableEntry?.InvoiceId) {
    return getInvoice(receivableEntry.InvoiceId);
  }

  const invoiceList = await listInvoices(customerId);
  const dueDateOnly = toDateOnly(dueDate);
  const filtered = invoiceList
    .filter((invoice) => invoice.ContractId === contractId && invoice.IsInvoice)
    .filter((invoice) => {
      if (!dueDateOnly) return true;
      return toDateOnly(invoice.DueDate) === dueDateOnly;
    })
    .sort((a, b) => new Date(b.DueDate || 0) - new Date(a.DueDate || 0));

  if (filtered.length === 0) {
    return null;
  }

  return getInvoice(filtered[0].Id);
}

async function listInvoices(customerId) {
  const response = await billwerk.get("/api/v1/invoices", {
    params: { customerId, take: 200 },
  });
  return response.data || [];
}

async function getInvoice(invoiceId) {
  const response = await billwerk.get(`/api/v1/invoices/${invoiceId}`);
  return response.data;
}

async function ensureDebtor(customer, invoice) {
  const reference = customer?.Id || customer?.CustomerId || null;
  if (!reference) {
    throw new Error("Missing customer id for debtor reference");
  }

  const existing = await paywise.get("/v1/debtors/", {
    params: { your_reference: reference, limit: 1 },
  });
  const existingDebtor = existing.data?.results?.[0];
  if (existingDebtor) {
    return existingDebtor.id;
  }

  const payload = buildDebtorPayload(customer, invoice, reference);
  const created = await paywise.post("/v1/debtors/", payload);
  return created.data.id;
}

function buildDebtorPayload(customer, invoice, reference) {
  const addressSource = customer?.Address || invoice?.RecipientAddress || null;
  const address = normalizeAddress(addressSource);
  if (!address) {
    throw new Error("Missing address data for debtor creation");
  }

  const isBusiness =
    Boolean(customer?.CompanyName) ||
    !(customer?.FirstName && customer?.LastName);
  const payload = {
    your_reference: reference,
    acting_as: isBusiness ? "business" : "consumer",
    addresses: [address],
  };

  if (isBusiness) {
    const orgName = customer?.CompanyName || customer?.CustomerName;
    if (!orgName) {
      throw new Error("Missing organization name for business debtor");
    }
    payload.organization = { name: orgName };
  } else {
    payload.person = {
      first_name: customer.FirstName,
      last_name: customer.LastName,
    };
  }

  if (customer?.EmailAddress) {
    payload.communication_channels = [
      {
        type: "email",
        value: customer.EmailAddress,
      },
    ];
  }

  return payload;
}

function normalizeAddress(source) {
  if (!source) return null;
  const streetParts = [source.Street, source.HouseNumber].filter(Boolean);
  const street = streetParts.join(" ").trim();
  const zip = source.PostalCode;
  const city = source.City;
  const country = source.Country;

  if (!street || !zip || !city || !country) {
    return null;
  }

  return {
    street,
    zip,
    city,
    country,
  };
}

async function findExistingClaim(documentReference, claimReference) {
  const params = { limit: 1 };
  if (documentReference) {
    params.document_reference = documentReference;
  } else if (claimReference) {
    params.your_reference = claimReference;
  } else {
    return null;
  }

  const response = await paywise.get("/v1/claims/", { params });
  return response.data?.results?.[0] || null;
}

function pickOpenAmount(contract, receivableEntry, invoice) {
  const candidates = [
    contract?.Balance,
    receivableEntry?.Amount,
    invoice?.TotalGross,
  ];
  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }
  return null;
}

function pickBillwerkPaymentAmount(openAmount, invoice) {
  const candidates = [openAmount, invoice?.TotalGross];
  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }
  return null;
}

function buildClaimPayload({
  debtorId,
  contract,
  customer,
  invoice,
  event,
  dueDate,
  openAmount,
  documentReference,
  claimReference,
}) {
  const currency =
    invoice?.Currency || contract?.Currency || config.paywiseDefaultCurrency;
  const documentDate = toDateOnly(
    invoice?.DocumentDate || invoice?.Created || dueDate,
  );
  const occurenceDate = toDateOnly(
    invoice?.DocumentDate || contract?.StartDate || dueDate,
  );
  const dueDateValue = toDateOnly(dueDate || invoice?.DueDate);
  const reminderDate = dueDateValue || documentDate;
  const delayDate = dueDateValue || documentDate;

  const mainClaimValue = formatAmount(invoice?.TotalGross ?? openAmount);
  const totalClaimValue = formatAmount(openAmount ?? invoice?.TotalGross);

  if (
    !debtorId ||
    !documentReference ||
    !documentDate ||
    !occurenceDate ||
    !dueDateValue
  ) {
    throw new Error("Missing required data to create claim");
  }

  if (!mainClaimValue || !totalClaimValue) {
    throw new Error("Missing claim amount data");
  }

  const subjectMatter = buildSubjectMatter(
    invoice,
    contract,
    documentReference,
  );

  const payload = {
    debtor: debtorId,
    your_reference: claimReference,
    subject_matter: subjectMatter,
    occurence_date: occurenceDate,
    document_reference: documentReference,
    document_date: documentDate,
    due_date: dueDateValue,
    reminder_date: reminderDate,
    delay_date: delayDate,
    total_claim_amount: {
      value: totalClaimValue,
      currency,
    },
    main_claim_amount: {
      value: mainClaimValue,
      currency,
    },
    starting_approach: config.paywiseStartingApproach,
    claim_disputed: false,
    obligation_fulfilled: true,
  };

  const items = buildClaimItems(invoice, currency);
  if (items.length > 0) {
    payload.items = items;
  }

  const metadata = buildClaimMetadata({
    invoice,
    contract,
    customer,
    event,
    documentReference,
  });
  if (metadata.length > 0) {
    payload.metadata = metadata;
  }

  return payload;
}

function buildSubjectMatter(invoice, contract, documentReference) {
  if (invoice?.ItemList?.length) {
    return `Overdue invoice ${documentReference}: ${invoice.ItemList[0].Description}`;
  }
  if (contract?.PlanId) {
    return `Overdue invoice ${documentReference} for plan ${contract.PlanId}`;
  }
  return `Overdue invoice ${documentReference}`;
}

function buildClaimItems(invoice, currency) {
  if (!invoice?.ItemList?.length) return [];

  return invoice.ItemList.map((item) => {
    const amountValue = formatAmount(
      item.TotalGross ?? item.PricePerUnit * item.Quantity,
    );
    if (!amountValue) return null;

    return {
      description:
        item.Description || item.ProductDescription || "Invoice item",
      quantity: item.Quantity || 1,
      amount: {
        value: amountValue,
        currency,
      },
    };
  }).filter(Boolean);
}

function buildClaimMetadata({ invoice, contract, event, documentReference }) {
  const metadata = [];
  if (documentReference) {
    metadata.push({
      type: "invoice:reference",
      value: String(documentReference),
    });
  }
  if (invoice?.DocumentDate) {
    metadata.push({
      type: "invoice:date",
      value: String(invoice.DocumentDate),
    });
  }
  if (contract?.Id) {
    metadata.push({ type: "contract:reference", value: String(contract.Id) });
  }
  if (event?.TriggerDays !== undefined && event?.TriggerDays !== null) {
    metadata.push({
      type: "subscription:overdue_period",
      value: String(event.TriggerDays),
    });
  }
  return metadata;
}

app.listen(config.port, () => {
  console.log(`Webhook listener running on port ${config.port}`);
});
