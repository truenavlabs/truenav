// Repro scenarios for the fix block on db8139f (holes 1 to 12, I1, I2).
// Each scenario takes an engine module and returns plain metrics, so the same code can run against
// an older engine to print a before/after table.
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync(new URL("../../spec/nav/fixtures.json", import.meta.url), "utf8"));
export const model = { pd: fixtures.pd, lgd: fixtures.lgd };
export const NOW = fixtures.valuation_time;
const NOW_MS = Date.parse(NOW);
export const STORE = fixtures.cert_store;
export const ago = (h) => new Date(NOW_MS - h * 3600 * 1000).toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));
export const harbor = () => clone(fixtures.funds.find((f) => f.fund_id === "harbor-credit-fund"));
export const signed = (f, signer) => {
  f.certificate.signer = signer;
  delete f.certificate.manager_id;
  return f;
};
export const loan = (id, over = {}) => ({
  id, asset: "real_estate", principal: 1000000, accrued: 0, repaid: 0, bucket: "current",
  nft: true, nft_id: `nft-${id}`, anomaly: false, servicer_asof: ago(12), ...over,
});
export const unverified = (id, over = {}) => loan(id, { nft: false, nft_id: undefined, ...over });
export function fund(id, signer, loans, headline, over = {}) {
  return {
    fund_id: id, name: id, headline_nav: headline, cash: 0, liabilities: 0, nav_report_date: ago(12),
    certificate: { signed_at: ago(12), data_asof: ago(12), signer, history: [{ fund_id: id, signed_at: ago(24 * 8) }] },
    policy_markdown: {}, blocked_attempts: [], loans, ...over,
  };
}
const r2 = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const brief = (r) => ({ status: r.status, raw: r2(r.raw), score: r.score, band: r.band });
const one = (E, f, opts = {}) => E.scoreFund(model, f, { now: NOW, certStore: STORE, ...opts });
const many = (E, fs, opts = {}) => E.scorePortfolio(model, fs, { now: NOW, certStore: STORE, ...opts });
const safe = (fn) => {
  try {
    return fn();
  } catch (e) {
    return { threw: `${e.name}: ${e.message}` };
  }
};
const perfect = (id, signer) => fund(id, signer, [loan(`${id}-1`)], 1000000);

export const scenarios = {
  "1 nft_id verified in two funds": (E) =>
    ["AB", "BA"].map((order) => {
      const A = fund("A", "mgr-a1", [loan("A-1", { principal: 100, nft_id: "NFT-shared" })], 100);
      const B = fund("B", "mgr-b1", [loan("B-1", { principal: 100, nft_id: "NFT-shared" })], 100);
      const rs = many(E, order === "AB" ? [A, B] : [B, A]);
      return rs.map((r) => ({ fund: r.fundId, ...brief(r), verified: r.counts.verified, share: r2(r.unverified.shareRaw), flag: r.flags.includes("nft_id listed by several funds") }));
    }),

  "2 over-marked verified loan in the 50% test": (E) => {
    const base = (mark, headline) =>
      fund("M", "mgr-m", [loan("V", { principal: 4000000, ...(mark ? { reported_value: mark } : {}) }), unverified("U", { principal: 6000000 })], headline);
    const gem = fund("G", "mgr-g", [loan("V", { principal: 10000, reported_value: 1e9 }), unverified("U", { principal: 10000000 })], 9938);
    return {
      honest: { ...brief(one(E, base(null, 10000000))), share: r2(one(E, base(null, 10000000)).unverified.shareRaw) },
      mark40M: { ...brief(one(E, base(40000000, 10000000))), share: r2(one(E, base(40000000, 10000000)).unverified.shareRaw) },
      mark20M_h3_9M: { ...brief(one(E, base(20000000, 3900000))), share: r2(one(E, base(20000000, 3900000)).unverified.shareRaw) },
      mark1B: { ...brief(one(E, gem)), share: r2(one(E, gem).unverified.shareRaw) },
    };
  },

  "3 bucket names on Object.prototype": (E) =>
    Object.fromEntries(
      ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"].map((b) => [
        b,
        safe(() => {
          const bad = fund("BAD", "mgr-bad", [loan("X-1", { bucket: b, dpd: 0 })], 1000000);
          const [h, x] = many(E, [harbor(), bad]);
          const nodpd = one(E, fund("BAD2", "mgr-bad", [loan("X-2", { bucket: b })], 1000000));
          return { harborRaw: r2(h.raw), badReason: x.exclusions[0] && x.exclusions[0].reason, noDpdReasons: nodpd.exclusions[0] && nodpd.exclusions[0].reasons };
        }),
      ]),
    ),

  "4 equal-age attempts": (E) => {
    const run = (ages, ids = ["a1", "a2"], reverse = false) => {
      let atts = ages.map((age, k) => ({ action_id: ids[k], age_days: age }));
      if (reverse) atts = atts.reverse();
      const P = fund("P", "mgr-p", [loan("P-1")], 1000000, { blocked_attempts: atts });
      const S = perfect("S", "mgr-p");
      const [p, s] = many(E, [P, S]);
      const wide = p.penaltyDetail.ownAttemptsManagerWide
        ? p.penaltyDetail.ownAttemptsManagerWide.filter((a) => a.managerWide).map((a) => a.action_id).sort()
        : null;
      return { sibling: { ...brief(s), penalty: r2(s.pillars.penalty), capped: s.noGreenCapApplied }, managerWide: wide };
    };
    return { "60,60": run([60, 60]), "60,60 reversed": run([60, 60], undefined, true), "90,60": run([90, 60]), "0,0": run([0, 0]), "0,0 reversed": run([0, 0], undefined, true) };
  },

  "5 payload-chosen fund_id (documented limit)": (E) => {
    const H = (id) => {
      const f = perfect(id, "mgr-h");
      f.certificate.history = [];
      delete f.headline_nav;
      return f;
    };
    const store = { H: [{ fund_id: "H", signed_at: ago(24 * 8) }] };
    const asH = one(E, H("H"), { certStore: store });
    const asNew = one(E, H("H-new"), { certStore: store });
    const Q = (id) => fund(id, "mgr-h", [loan(`${id}-1`)], 1000000, { blocked_attempts: [{ action_id: "q1", age_days: 60 }] });
    const log = { Q: { q1: { attempting_open_loans: 0, manager_id: "mgr-h" } } };
    const [hq] = many(E, [perfect("H2", "mgr-h"), Q("Q")], { attemptLog: log });
    const [hn] = many(E, [perfect("H2", "mgr-h"), Q("Q-new")], { attemptLog: log });
    return {
      noHeadline_asH: { status: asH.status, rank: asH.statusRank, color: asH.color },
      noHeadline_renamed: { status: asNew.status, rank: asNew.statusRank, color: asNew.color },
      shell_asQ: { ...brief(hq), reasons: hq.penaltyDetail.managerWideReasons },
      shell_renamed: { ...brief(hn), managerWide: hn.penaltyDetail.managerWide },
    };
  },

  "6 expired but claimed cash attestation": (E) => {
    const C = (claimed) =>
      fund("C", "mgr-c", [loan("C-1")], 1100000, {
        cash: 100000, ...(claimed ? { cash_attested: true, cash_asof: ago(744) } : {}),
        blocked_attempts: [{ action_id: "c1", age_days: 60 }],
      });
    const [c1, s1] = many(E, [C(true), perfect("S", "mgr-c")]);
    const [c0, s0] = many(E, [C(false), perfect("S", "mgr-c")]);
    return {
      claimed: { ...brief(c1), freshness: r2(c1.pillars.freshness), sibling: brief(s1) },
      notClaimed: { ...brief(c0), sibling: brief(s0) },
    };
  },

  "7 float error at exactly 50%": (E) => {
    const loans = Array.from({ length: 10 }, (_, k) => (k < 5 ? loan(`L${k}`, { principal: 0.1 }) : unverified(`L${k}`, { principal: 0.1 })));
    const g4 = one(E, fund("G4", "mgr-g4", loans, 0.9, { liabilities: 0.1 }));
    // Cent-exact 50%: verified 23.14 against unverified 5.29 + 8.70 + 9.15 = 23.14, headline 46.28.
    const cent = one(E, fund("C50", "mgr-c50", [loan("V", { principal: 23.14 }), unverified("U1", { principal: 5.29 }), unverified("U2", { principal: 8.7 }), unverified("U3", { principal: 9.15 })], 46.28));
    return { g4: { ...brief(g4), share: g4.unverified.shareRaw }, centExact: { ...brief(cent), share: cent.unverified.shareRaw } };
  },

  "8 retry age inside one fund": (E) =>
    Object.fromEntries(
      [[60, 0], [0, 60]].map((ages) => {
        const X = fund("X", "mgr-x", [unverified("X-1")], 1000000, { blocked_attempts: ages.map((a) => ({ action_id: "x", age_days: a })) });
        const [x, s] = many(E, [X, perfect("S", "mgr-x")]);
        return [ages.join(","), { effectiveAge: x.penaltyDetail.attempts[0].age_days, xStatus: x.status, sibling: { ...brief(s), capped: s.noGreenCapApplied } }];
      }),
    ),

  "9 false manager_id spoof on no-cert funds": (E) => {
    const U = (payload) => {
      const u = fund("U", "unused", [loan("U-1")], 1000000, { manager_id: payload, blocked_attempts: [{ action_id: "u1", age_days: 5 }] });
      delete u.certificate;
      return u;
    };
    const log = { U: { u1: { manager_id: "M" } } };
    const [m] = many(E, [U("M")], { attemptLog: log });
    const [z] = many(E, [U("Z")], { attemptLog: log });
    return {
      matching: { spoof: m.spoofFlags.managerId, flag: m.flags.includes("manager_id spoof"), managerId: m.managerId },
      mismatch: { spoof: z.spoofFlags.managerId, flag: z.flags.includes("manager_id spoof"), managerId: z.managerId },
    };
  },

  "10 missing repaid hides concentration": (E) => {
    const book = (dropRepaid) => {
      const big = unverified("BIG", { principal: 4000, reported_value: 0 });
      if (dropRepaid) delete big.repaid;
      return fund("K", "mgr-k", [big, ...Array.from({ length: 10 }, (_, k) => loan(`S${k}`, { principal: 1000 }))], 14000);
    };
    const c = (r) => ({ largest: r2(r.concentration.largestShare), topFive: r2(r.concentration.topFiveShare), breaches: [r.concentration.largestBreach, r.concentration.topFiveBreach] });
    return { complete: c(one(E, book(false))), missingRepaid: c(one(E, book(true))) };
  },

  "11 generated id collides with supplied id": (E) => {
    const loans = Array.from({ length: 10 }, (_, k) => loan(`N${k}`, { principal: 1000 }));
    delete loans[1].id; // generated "#1"
    loans[2].id = "#1"; // supplied "#1"
    const r = one(E, fund("I", "mgr-i", loans, 10000));
    return { largest: r2(r.concentration.largestShare), topFive: r2(r.concentration.topFiveShare), breaches: [r.concentration.largestBreach, r.concentration.topFiveBreach] };
  },

  "12 overflow at principal 1e155": (E) => {
    const A = fund("A", "mgr-o", [loan("A-1", { principal: 1e155, bucket: "dpd_over_90" })], 1e155, { blocked_attempts: [{ action_id: "o1", age_days: 0 }] });
    const [a, b] = many(E, [A, perfect("B", "mgr-o")]);
    return { A: { status: a.status, raw: r2(a.raw), floorBind: a.floorBind }, B: { ...brief(b), managerWide: b.penaltyDetail.managerWide } };
  },

  "I1 warning on every listing fund": (E) =>
    Object.fromEntries(
      ["HF", "FH"].map((order) => {
        const H = signed(harbor(), "mgr-d");
        H.blocked_attempts = [{ action_id: "x", age_days: 5 }];
        const F = fund("Fbig", "mgr-d", [loan("F-1", { principal: 5000000 })], 5000000, { blocked_attempts: [{ action_id: "x", age_days: 3000 }] });
        const rs = many(E, order === "HF" ? [H, F] : [F, H]);
        const h = rs.find((r) => r.fundId === "harbor-credit-fund");
        const f = rs.find((r) => r.fundId === "Fbig");
        return [order, { harborWarn: h.managerWarning, fbigWarn: f.managerWarning, harborRaw: r2(h.raw), fbigRaw: r2(f.raw) }];
      }),
    ),

  "I2 siblingAttempts.from is one fund_id": (E) => {
    const D = fund("D", "mgr-d", [loan("D-1")], 2500000, { blocked_attempts: [{ action_id: "x", age_days: 5 }] });
    const F = fund("Fbig", "mgr-d", [loan("F-1", { principal: 5000000 })], 5000000, { blocked_attempts: [{ action_id: "x", age_days: 3000 }] });
    const [h] = many(E, [signed(harbor(), "mgr-d"), F, D]);
    const sa = h.penaltyDetail.siblingAttempts[0];
    return { from: sa.from, listedBy: sa.listedBy ?? null };
  },
};
