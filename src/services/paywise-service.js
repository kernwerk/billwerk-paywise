import { config } from "../app-config.js";
import { paywise } from "../clients/paywise-client.js";
import { formatAmount, normalizeAmount, toDateOnly } from "../shared-utils.js";
import { downloadInvoicePdf, listInvoices } from "./billwerk-service.js";

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

async function releasePaywiseClaim(claimId) {
  await paywise.patch(`/v1/claims/${claimId}/`, {
    submission_state: "released",
    send_order_confirmation: true,
  });
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

export {
  buildClaimPayload,
  ensureDebtor,
  findExistingClaim,
  pickBillwerkPaymentAmount,
  pickOpenAmount,
  releasePaywiseClaim,
  uploadClaimDocumentsFromBillwerk,
};
