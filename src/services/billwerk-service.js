import axios from "axios";
import { billwerk } from "../clients/billwerk-client.js";
import { config } from "../app-config.js";
import { toDateOnly } from "../shared-utils.js";

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

async function listDunnings({
  customerId,
  templateId,
  drafts = false,
  take = 25,
}) {
  const params = {
    customerId,
    drafts,
    search: "",
    from: "",
    skip: 0,
    take,
  };
  if (templateId) {
    params.templateId = templateId;
  }
  const response = await billwerk.get("/api/v1/dunnings", { params });
  return response.data || [];
}

function pickLatestDunning(dunnings) {
  if (!Array.isArray(dunnings) || dunnings.length === 0) return null;
  const sorted = dunnings
    .slice()
    .sort((a, b) => getDunningSortTime(b) - getDunningSortTime(a));
  return sorted[0] || null;
}

function getDunningSortTime(dunning) {
  const value = dunning?.SentAt || dunning?.CreationTime || dunning?.DocumentDate;
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

async function getDunning(dunningId) {
  const response = await billwerk.get(`/api/v1/dunnings/${dunningId}`);
  return response.data;
}

async function downloadDunningPdf(dunningId) {
  try {
    const linkResponse = await billwerk.post(
      `/api/v1/dunnings/${dunningId}/downloadlink`,
    );
    const rawUrl =
      linkResponse.data?.Url ||
      linkResponse.data?.url ||
      linkResponse.data?.URL;
    if (rawUrl) {
      const downloadUrl = new URL(rawUrl, config.billwerkBaseUrl).toString();
      const response = await axios.get(downloadUrl, {
        responseType: "arraybuffer",
        timeout: 20000,
      });
      return Buffer.from(response.data);
    }
  } catch (error) {
    const status = error?.response?.status;
    if (status !== 404 && status !== 405) {
      throw error;
    }
  }

  const response = await billwerk.get(`/api/v1/dunnings/${dunningId}/download`, {
    responseType: "arraybuffer",
  });
  return Buffer.from(response.data);
}

async function downloadLatestDunningPdf({ customerId, templateId, take }) {
  const dunnings = await listDunnings({ customerId, templateId, take });
  const latest = pickLatestDunning(dunnings);
  if (!latest?.Id) {
    return null;
  }
  const pdf = await downloadDunningPdf(latest.Id);
  return { dunning: latest, pdf };
}

export {
  bookBillwerkPayment,
  downloadInvoicePdf,
  downloadLatestDunningPdf,
  getContract,
  getCustomer,
  getDunning,
  getLedgerEntries,
  listInvoices,
  pickReceivableEntry,
  resolveInvoice,
};
