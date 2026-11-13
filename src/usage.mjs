/**
 * Account usage for BB's Usage panel (provider/usage).
 * Reads the local `cmd` login and the same /alpha/* endpoints `cmd /usage`
 * uses, mapped onto the SDK ProviderUsageResult shape.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const API_BASE = "https://api.commandcode.ai";

async function readAuthKey() {
  try {
    const auth = JSON.parse(await readFile(join(homedir(), ".commandcode", "auth.json"), "utf8"));
    return typeof auth?.apiKey === "string" && auth.apiKey ? auth.apiKey : null;
  } catch {
    return null;
  }
}

async function getJson(apiKey, path) {
  const res = await fetch(API_BASE + path, { headers: { authorization: `Bearer ${apiKey}` } });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, json };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0);
const percent = (used, total) => (total > 0 ? Math.min(100, (used / total) * 100) : 0);
const iso = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

function limitWindow(label, limit) {
  if (!limit || typeof limit.used !== "number" || typeof limit.cap !== "number") return null;
  return { label, usedPercent: percent(limit.used, limit.cap), resetsAt: iso(limit.resetAt) };
}

export function mapUsage({ whoami, credits, subscription, summary }) {
  const windows = [];
  const fiveHour = limitWindow("5-hour limit", credits?.windowLimits?.fiveHour);
  if (fiveHour) windows.push(fiveHour);
  const weekly = limitWindow("Weekly limit", credits?.windowLimits?.weekly);
  if (weekly) windows.push(weekly);
  const sub = subscription?.data ?? null;
  if (credits?.credits) {
    const c = credits.credits;
    const remaining = num(c.monthlyCredits) + num(c.purchasedCredits) + num(c.freeCredits);
    const used = num(summary?.totalCost);
    windows.push({
      label: "Credits",
      usedPercent: percent(used, remaining + used),
      resetsAt: typeof sub?.currentPeriodEnd === "string" ? sub.currentPeriodEnd : null,
    });
  }
  const planId = typeof sub?.planId === "string" && sub.planId ? sub.planId : null;
  return {
    status: "ok",
    accountEmail: typeof whoami?.user?.email === "string" ? whoami.user.email : null,
    planLabel: planId ? planId.split(/[_-]/)[0].replace(/^\w/, (ch) => ch.toUpperCase()) : null,
    windows,
  };
}

const usageError = (message) => ({
  supported: true,
  usage: { status: "error", message, accountEmail: null, planLabel: null },
});

export async function readUsage(io = { readAuthKey, getJson }) {
  const apiKey = await io.readAuthKey();
  if (!apiKey) return { supported: true, usage: { status: "unauthenticated" } };
  try {
    const who = await io.getJson(apiKey, "/alpha/whoami?limits=1");
    if (who.status === 401) return { supported: true, usage: { status: "expired" } };
    if (!who.ok || !who.json?.user) return usageError(`Command Code usage request failed (HTTP ${who.status}).`);
    const orgId = typeof who.json.org?.id === "string" ? who.json.org.id : null;
    const orgQuery = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    const subs = await io.getJson(apiKey, `/alpha/billing/subscriptions${orgQuery}`);
    if (subs.status === 401) return { supported: true, usage: { status: "expired" } };
    const since = typeof subs.json?.data?.currentPeriodStart === "string" ? subs.json.data.currentPeriodStart : null;
    const summaryParams = new URLSearchParams();
    if (orgId) summaryParams.set("orgId", orgId);
    if (since) summaryParams.set("since", since);
    const summaryQuery = summaryParams.size ? `?${summaryParams}` : "";
    const [credits, summary] = await Promise.all([
      io.getJson(apiKey, `/alpha/billing/credits${orgQuery}`),
      io.getJson(apiKey, `/alpha/usage/summary${summaryQuery}`),
    ]);
    if (credits.status === 401 || summary.status === 401) return { supported: true, usage: { status: "expired" } };
    if (!credits.ok) return usageError(`Command Code usage request failed (HTTP ${credits.status}).`);
    if (!credits.json?.credits && !credits.json?.windowLimits) return usageError("Command Code usage response was malformed.");
    return {
      supported: true,
      usage: mapUsage({
        whoami: who.json,
        credits: credits.json,
        subscription: subs.ok ? subs.json : null,
        summary: summary.ok ? summary.json : null,
      }),
    };
  } catch (err) {
    return usageError(err instanceof Error ? err.message : "Unknown error");
  }
}

export async function readAccount() {
  // Local-only so health checks never hit the network; email comes from
  // whoami inside readUsage.
  return (await readAuthKey()) ? { email: null } : null;
}