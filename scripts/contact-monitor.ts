#!/usr/bin/env npx tsx
/**
 * HubSpot contact monitor — polls for new waitlist signups (6h lookback).
 * Logs contact details, alerts CRO on VIB-7 if agency indicators found.
 *
 * Usage: npx tsx scripts/contact-monitor.ts
 * Env:   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HUBSPOT_API = "https://api.hubapi.com";
const LOOKBACK_MS = 6 * 60 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const VIB_7_ID = "881f2c94-b720-4a5a-b37f-89bc2a7f7272";

const CONTACT_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "company",
  "jobtitle",
  "hs_analytics_source",
  "lifecyclestage",
  "createdate",
  "phone",
  "website",
  "num_employees",
];

const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com",
  "yahoo.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "protonmail.com", "proton.me", "live.com", "msn.com",
  "ymail.com", "zoho.com", "mail.com", "gmx.com", "inbox.com",
]);

const AGENCY_COMPANY_TERMS = /\b(agency|agencies|consulting|consultancy|digital\s+marketing|media\s+group|creative\s+studio|partners|solutions|advisors|strateg)/i;
const AGENCY_TITLE_TERMS = /\b(agency|founder|co-?founder|ceo|cmo|coo|managing\s+director|vp|vice\s+president|partner|consultant|strategist|account\s+(manager|director|executive))\b/i;

// ---------------------------------------------------------------------------
// HubSpot auth (mirrors src/hubspot/api.ts pattern)
// ---------------------------------------------------------------------------

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

function loadPak(): string {
  const configPath = join(homedir(), ".vibespot", "config.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(`Cannot read vibeSpot config at ${configPath}`);
  }

  const accounts = raw.hubspotAccounts as Array<Record<string, string>> | undefined;
  if (!accounts?.length) throw new Error("No HubSpot accounts configured in ~/.vibespot/config.json");

  const activeId = raw.activeHubSpotAccount as string | undefined;
  const acct = activeId
    ? accounts.find((a) => a.portalId === activeId) ?? accounts[0]
    : accounts[0];

  return acct.personalAccessKey;
}

async function getAccessToken(pak: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return cachedToken.accessToken;
  }

  const resp = await fetch(`${HUBSPOT_API}/localdevauth/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encodedOAuthRefreshToken: pak }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HubSpot token exchange failed (${resp.status}): ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as Record<string, unknown>;
  cachedToken = {
    accessToken: data.oauthAccessToken as string,
    expiresAt: data.expiresAtMillis as number,
  };
  return cachedToken.accessToken;
}

// ---------------------------------------------------------------------------
// HubSpot CRM Contacts search
// ---------------------------------------------------------------------------

interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
}

interface SearchResponse {
  total: number;
  results: HubSpotContact[];
  paging?: { next?: { after: string } };
}

async function searchRecentContacts(pak: string): Promise<HubSpotContact[]> {
  const token = await getAccessToken(pak);
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const all: HubSpotContact[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "createdate",
              operator: "GTE",
              value: cutoff,
            },
          ],
        },
      ],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      properties: CONTACT_PROPERTIES,
      limit: 100,
    };
    if (after) body.after = after;

    const resp = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`Contacts search failed (${resp.status}): ${errText.slice(0, 300)}`);
    }

    const data = (await resp.json()) as SearchResponse;
    all.push(...data.results);
    after = data.paging?.next?.after;
  } while (after);

  return all;
}

// ---------------------------------------------------------------------------
// Agency detection
// ---------------------------------------------------------------------------

interface AgencySignal {
  contact: HubSpotContact;
  reasons: string[];
}

function detectAgencySignals(contacts: HubSpotContact[]): AgencySignal[] {
  const signals: AgencySignal[] = [];

  for (const c of contacts) {
    const reasons: string[] = [];
    const email = c.properties.email ?? "";
    const company = c.properties.company ?? "";
    const title = c.properties.jobtitle ?? "";
    const domain = email.split("@")[1]?.toLowerCase();

    if (domain && !GENERIC_DOMAINS.has(domain)) {
      reasons.push(`business email (${domain})`);
    }
    if (company && AGENCY_COMPANY_TERMS.test(company)) {
      reasons.push(`company name: "${company}"`);
    }
    if (title && AGENCY_TITLE_TERMS.test(title)) {
      reasons.push(`title: "${title}"`);
    }

    if (reasons.length > 0) {
      signals.push({ contact: c, reasons });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Paperclip alert
// ---------------------------------------------------------------------------

async function alertOnVib7(signals: AgencySignal[]): Promise<void> {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;

  if (!apiUrl || !apiKey || !companyId) {
    console.warn("Paperclip env vars not set, skipping VIB-7 alert");
    return;
  }

  const lines = signals.map((s) => {
    const p = s.contact.properties;
    const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || "(no name)";
    return `- **${name}** <${p.email ?? "?"}> | ${p.company ?? "?"} | ${s.reasons.join(", ")}`;
  });

  const body = [
    `## Agency-indicator contacts detected (${signals.length})`,
    "",
    `Lookback: last 6 hours (as of ${new Date().toISOString()})`,
    "",
    ...lines,
    "",
    "CRO: review these contacts for outreach prioritization.",
  ].join("\n");

  const resp = await fetch(`${apiUrl}/api/issues/${VIB_7_ID}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      body,
      agentId: process.env.PAPERCLIP_AGENT_ID,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(`Failed to post VIB-7 comment (${resp.status}): ${text.slice(0, 300)}`);
  } else {
    console.log(`Posted agency alert to VIB-7 (${signals.length} contacts)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[contact-monitor] Starting at ${new Date().toISOString()}`);
  console.log(`[contact-monitor] Lookback: 6 hours`);

  const pak = loadPak();
  console.log(`[contact-monitor] Using HubSpot PAK: ${pak.slice(0, 7)}...${pak.slice(-4)}`);

  const contacts = await searchRecentContacts(pak);
  console.log(`[contact-monitor] Found ${contacts.length} contacts created in last 6h`);

  if (contacts.length === 0) {
    console.log("[contact-monitor] No new contacts. Done.");
    return;
  }

  for (const c of contacts) {
    const p = c.properties;
    const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || "(no name)";
    console.log(`  ${name} | ${p.email ?? "?"} | ${p.company ?? "-"} | ${p.jobtitle ?? "-"} | created: ${p.createdate}`);
  }

  const agencySignals = detectAgencySignals(contacts);
  console.log(`[contact-monitor] Agency indicators: ${agencySignals.length} contacts`);

  if (agencySignals.length > 0) {
    for (const s of agencySignals) {
      const p = s.contact.properties;
      console.log(`  AGENCY: ${p.email} — ${s.reasons.join("; ")}`);
    }
    await alertOnVib7(agencySignals);
  }

  console.log("[contact-monitor] Done.");
}

main().catch((err) => {
  console.error("[contact-monitor] Fatal:", err);
  process.exit(1);
});
