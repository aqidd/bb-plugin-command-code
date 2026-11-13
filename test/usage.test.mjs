import test from "node:test";
import assert from "node:assert/strict";
import { mapUsage, readUsage } from "../src/usage.mjs";

const whoami = { user: { email: "dev@example.com" }, org: { id: "org1" } };
const credits = {
  credits: { monthlyCredits: 9.8, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    fiveHour: { used: 0.5, cap: 3, exceeded: false, resetAt: 1794624608432 },
    weekly: { used: 1, cap: 6, exceeded: false, resetAt: 1795189269187 },
  },
};
const subscription = {
  data: {
    planId: "pro_monthly",
    status: "active",
    currentPeriodStart: "2026-11-01T00:00:00.000Z",
    currentPeriodEnd: "2026-12-01T00:00:00.000Z",
  },
};
const summary = { totalCost: 0.2 };

function fakeIo(routes, key = "k") {
  const calls = [];
  return {
    calls,
    readAuthKey: async () => key,
    getJson: async (_key, path) => {
      calls.push(path);
      for (const [match, res] of routes) if (path.includes(match)) return res;
      return { ok: true, status: 200, json: {} };
    },
  };
}
const ok = (json) => ({ ok: true, status: 200, json });

test("mapUsage maps windows, credits, plan, email", () => {
  const u = mapUsage({ whoami, credits, subscription, summary });
  assert.equal(u.status, "ok");
  assert.equal(u.accountEmail, "dev@example.com");
  assert.equal(u.planLabel, "Pro");
  assert.deepEqual(u.windows.map((w) => w.label), ["5-hour limit", "Weekly limit", "Credits"]);
  assert.deepEqual(u.windows.map((w) => w.kind), ["five-hour", "weekly", "custom"]);
  assert.deepEqual(u.windows.map((w) => w.id), ["0:5-hour limit", "1:Weekly limit", "2:Credits"]);
  assert.ok(Math.abs(u.windows[0].usedPercent - (0.5 / 3) * 100) < 1e-9);
  assert.equal(u.windows[0].resetsAt, new Date(1794624608432).toISOString());
  assert.ok(Math.abs(u.windows[2].usedPercent - (0.2 / 10) * 100) < 1e-9);
  assert.equal(u.windows[2].resetsAt, "2026-12-01T00:00:00.000Z");
});

test("mapUsage edge cases: cap 0, missing limits, missing credits", () => {
  const u = mapUsage({
    whoami,
    credits: { credits: credits.credits, windowLimits: { fiveHour: { used: 1, cap: 0 } } },
    subscription: null,
    summary: null,
  });
  assert.equal(u.windows[0].usedPercent, 0);
  assert.equal(u.windows[0].resetsAt, null);
  assert.equal(u.planLabel, null);
  assert.equal(u.windows.length, 2); // fiveHour + Credits, no weekly
  const bare = mapUsage({ whoami, credits: null, subscription: null, summary: null });
  assert.deepEqual(bare.windows, []);
});

test("readUsage: no auth key -> unauthenticated", async () => {
  const r = await readUsage(fakeIo([], null));
  assert.deepEqual(r, { supported: true, usage: { status: "unauthenticated" } });
});

test("readUsage: 401 on whoami or credits -> expired", async () => {
  const who401 = await readUsage(fakeIo([["whoami", { ok: false, status: 401, json: null }]]));
  assert.equal(who401.usage.status, "expired");
  const credits401 = await readUsage(
    fakeIo([["whoami", ok(whoami)], ["credits", { ok: false, status: 401, json: null }]]),
  );
  assert.equal(credits401.usage.status, "expired");
});

test("readUsage: HTTP 500 / malformed / throw -> error", async () => {
  const http = await readUsage(fakeIo([["whoami", { ok: false, status: 500, json: null }]]));
  assert.equal(http.usage.status, "error");
  assert.match(http.usage.message, /HTTP 500/);
  const malformed = await readUsage(fakeIo([["whoami", ok({})]]));
  assert.equal(malformed.usage.status, "error");
  const boom = await readUsage({
    readAuthKey: async () => "k",
    getJson: async () => { throw new Error("socket hang up"); },
  });
  assert.equal(boom.usage.status, "error");
  assert.match(boom.usage.message, /socket hang up/);
});

test("readUsage: ok, passes orgId and since, degrades subs/summary", async () => {
  const io = fakeIo([
    ["whoami", ok(whoami)],
    ["subscriptions", ok(subscription)],
    ["credits", ok(credits)],
    ["summary", ok(summary)],
  ]);
  const r = await readUsage(io);
  assert.equal(r.usage.status, "ok");
  assert.equal(r.usage.windows.length, 3);
  assert.ok(io.calls.some((p) => p.includes("orgId=org1")));
  assert.ok(io.calls.some((p) => p.includes("since=2026-11-01")));
  const degraded = await readUsage(
    fakeIo([["whoami", ok(whoami)], ["credits", ok(credits)], ["subscriptions", { ok: false, status: 500, json: null }], ["summary", { ok: false, status: 500, json: null }]]),
  );
  assert.equal(degraded.usage.status, "ok");
  assert.equal(degraded.usage.planLabel, null);
});