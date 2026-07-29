function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#xD;/g, "\r")
    .replace(/&amp;/g, "&");
}

export interface SoapResult {
  success: boolean;
  output: string;
  /**
   * True when the request never reached the worldserver (or timed out), so
   * the command's effect is unknown. A SOAP fault leaves this unset: the
   * server was reached and definitively rejected the command.
   */
  unreachable?: boolean;
}

import { getRealmConfigById } from "./realm";

/**
 * Run a worldserver console command over the SOAP API.
 * Requires SOAP_USER/SOAP_PASS to be a gmlevel-3 account.
 */
export async function soapCommand(
  command: string,
  realmId?: number
): Promise<SoapResult> {
  let url = process.env.SOAP_URL || "http://ac-worldserver:7878";
  if (realmId) {
    const realmConfig = await getRealmConfigById(realmId).catch(() => null);
    if (realmConfig?.soapUrl) {
      url = realmConfig.soapUrl;
    }
  }

  const user = process.env.SOAP_USER || "";
  const pass = process.env.SOAP_PASS || "";
  if (!user || !pass) {
    return {
      success: false,
      output:
        "SOAP credentials not configured. Set SOAP_USER and SOAP_PASS in .env and restart ac-webapp.",
    };
  }

  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:AC">` +
    `<SOAP-ENV:Body><ns1:executeCommand><command>${escapeXml(command)}</command></ns1:executeCommand></SOAP-ENV:Body>` +
    `</SOAP-ENV:Envelope>`;

  let text: string;
  let ok: boolean;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml;charset=UTF-8",
        Authorization:
          "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
      },
      body: envelope,
      signal: AbortSignal.timeout(15000),
    });
    ok = res.ok;
    text = await res.text();
  } catch (err) {
    return {
      success: false,
      unreachable: true,
      output: `Could not reach worldserver SOAP (${(err as Error).message}). Is the worldserver running?`,
    };
  }

  const result = text.match(/<result>([\s\S]*?)<\/result>/);
  if (result) return { success: true, output: unescapeXml(result[1]).trim() };

  const fault = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
  if (fault) return { success: false, output: unescapeXml(fault[1]).trim() };

  return {
    success: ok,
    output: ok ? "(no output)" : `SOAP request failed: ${text.slice(0, 300)}`,
  };
}
