import crypto from "crypto";
import { config } from "../app-config.js";
import { letterxpress } from "../clients/letterxpress-client.js";

function buildLetterxpressPayload({ pdfBase64, filename }) {
  const checksum = crypto.createHash("md5").update(pdfBase64).digest("hex");

  return {
    auth: {
      username: config.letterxpressUsername,
      apikey: config.letterxpressApiKey,
      mode: config.letterxpressMode,
    },
    letter: {
      base64_file: pdfBase64,
      base64_file_checksum: checksum,
      specification: {
        color: config.letterxpressColor,
        mode: config.letterxpressPrintMode,
        shipping: config.letterxpressShipping,
        c4: config.letterxpressC4,
      },
      filename_original: filename,
    },
  };
}

async function sendLetterxpressPrintJob({ pdfBuffer, filename }) {
  const pdfBase64 = Buffer.from(pdfBuffer).toString("base64");
  const payload = buildLetterxpressPayload({ pdfBase64, filename });
  const response = await letterxpress.post("/v3/printjobs", payload);
  return response.data;
}

export { sendLetterxpressPrintJob };
