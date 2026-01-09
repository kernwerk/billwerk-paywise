import { config } from "../app-config.js";
import {
  bookBillwerkPayment,
  downloadLatestDunningPdf,
  getContract,
  getCustomer,
  getLedgerEntries,
  pickReceivableEntry,
  resolveInvoice,
} from "../services/billwerk-service.js";
import {
  buildClaimPayload,
  ensureDebtor,
  findExistingClaim,
  pickBillwerkPaymentAmount,
  pickOpenAmount,
  releasePaywiseClaim,
  uploadClaimDocumentsFromBillwerk,
} from "../services/paywise-service.js";
import { sendLetterxpressPrintJob } from "../services/letterxpress-service.js";
import { normalizeAmount, toDateOnly } from "../shared-utils.js";
import { paywise } from "../clients/paywise-client.js";

async function handlePaymentEscalated(req, res) {
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

    const triggerDays = normalizeTriggerDays(event.TriggerDays);
    const isDunningTrigger = isTriggerDayAllowed(
      triggerDays,
      config.billwerkDunningTriggerDays,
    );
    const isPaywiseTrigger = isTriggerDayAllowed(
      triggerDays,
      config.billwerkTriggerDays,
    );

    if (!isDunningTrigger && !isPaywiseTrigger) {
      return res.status(202).json({
        status: "ignored",
        reason: "trigger_days_not_allowed",
        triggerDays,
        allowedTriggerDays: config.billwerkTriggerDays,
        dunningTriggerDays: config.billwerkDunningTriggerDays,
      });
    }

    const contractId = event.ContractId;
    const customerId = event.CustomerId;
    if (!contractId || !customerId) {
      return res
        .status(422)
        .json({ error: "Missing ContractId or CustomerId" });
    }

    if (isDunningTrigger) {
      return await handleDunningFlow({ customerId, triggerDays }, res);
    }

    return await handlePaywiseFlow(
      { contractId, customerId, event, triggerDays },
      res,
    );
  } catch (error) {
    const message = error.response?.data || error.message || "Unknown error";
    const status = error.response?.status || 500;
    return res.status(status).json({ error: message });
  }
}

async function handleDunningFlow({ customerId, triggerDays }, res) {
  if (!hasBillwerkCredentials() || !hasLetterxpressCredentials()) {
    return res.status(500).json({ error: "Missing API credentials" });
  }

  const dunningResult = await downloadLatestDunningPdf({
    customerId,
    templateId: config.billwerkDunningTemplateId,
    take: config.billwerkDunningTake,
  });

  if (!dunningResult) {
    return res.status(422).json({
      error: "No dunning available for LetterXpress send",
      triggerDays,
    });
  }

  const filename = buildDunningFilename(dunningResult.dunning);
  const printJob = await sendLetterxpressPrintJob({
    pdfBuffer: dunningResult.pdf,
    filename,
  });

  return res.status(201).json({
    status: "dunning_sent",
    dunningId: dunningResult.dunning.Id,
    letterxpressJobId: printJob?.data?.id ?? printJob?.id ?? null,
  });
}

async function handlePaywiseFlow(
  { contractId, customerId, event, triggerDays },
  res,
) {
  if (!hasBillwerkCredentials() || !config.paywiseToken) {
    return res.status(500).json({ error: "Missing API credentials" });
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

  const documentReference = invoice?.InvoiceNumber || invoice?.Id || contractId;
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

  const createdClaim = await createPaywiseClaim(claimPayload);
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
  const billwerkPaymentAmount = pickBillwerkPaymentAmount(openAmount, invoice);
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
    .json({ status: "created", claimId: createdClaim.data.id, triggerDays });
}

async function createPaywiseClaim(payload) {
  return paywise.post("/v1/claims/", payload);
}

function normalizeTriggerDays(value) {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.trunc(num);
}

function isTriggerDayAllowed(triggerDays, allowedDays) {
  if (!allowedDays?.length) return true;
  if (triggerDays === null) return false;
  return allowedDays.includes(triggerDays);
}

function hasBillwerkCredentials() {
  return Boolean(config.billwerkClientId && config.billwerkClientSecret);
}

function hasLetterxpressCredentials() {
  return Boolean(config.letterxpressUsername && config.letterxpressApiKey);
}

function buildDunningFilename(dunning) {
  const base = dunning?.DunningNumber || dunning?.Id || "dunning";
  const safeBase = String(base).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safeBase}.pdf`;
}

export { handlePaymentEscalated };
