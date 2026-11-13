// Builds a prefilled GitHub Issues URL. Data layer only; no layout.
// Never includes chat history, keys, or anything other than the page path
// and, when opted in, a wallet account id.

export const ISSUES_URL = "https://github.com/truenavlabs/truenav/issues";
export const ISSUES_NEW_URL = "https://github.com/truenavlabs/truenav/issues/new";
export const ISSUE_TITLE = "Support request";
export const MAX_ISSUE_URL_CHARS = 6000;

const ACCOUNT_RE = /^[a-z0-9._-]{2,64}$/;
const MAX_PATH_CHARS = 200;

const PATH_RE = /^\/[A-Za-z0-9_./-]*$/;

/**
 * Keep a plain site path only: query and hash dropped, then anything outside [A-Za-z0-9_./-]
 * becomes "/", so no Markdown, spaces or encoded text reach the issue. Account pages become
 * /account/:id so the wallet id never rides along without the opt-in.
 */
export function sanitizePath(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "/";
  let s = raw.trim().split(/[?#]/)[0];
  if (!s.startsWith("/")) s = `/${s}`;
  s = s.replace(/^\/+/, "/");
  if (s.length > MAX_PATH_CHARS || !PATH_RE.test(s)) return "/";
  if (/^\/account\/.+/.test(s)) return "/account/:id";
  return s;
}

/** Accept a NEAR account id only. Reject keys and anything else. */
export function sanitizeAccount(raw) {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  if (/ed25519:|secp256k1:/i.test(s)) return "";
  return ACCOUNT_RE.test(s) ? s : "";
}

function formatBody(page, accountId) {
  let body = `Page: ${page}\n\nWhat happened:\n\n\nWhat you expected:\n`;
  if (accountId) body += `\n\nWallet account (included by opt-in): ${accountId}\n`;
  return body;
}

function encode(title, body) {
  return `${ISSUES_NEW_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/**
 * Prefill title and body for github.com/truenavlabs/truenav/issues/new.
 * The wallet account id is included only when includeAccount is true and the
 * id is a valid account. includeAccount defaults to false.
 */
export function buildIssueUrl(input = {}) {
  const title = ISSUE_TITLE;
  const page = sanitizePath(input.page);
  const accountId = input.includeAccount === true ? sanitizeAccount(input.accountId) : "";
  let url = encode(title, formatBody(page, accountId));
  if (url.length <= MAX_ISSUE_URL_CHARS) return url;

  if (accountId) {
    url = encode(title, formatBody(page, ""));
    if (url.length <= MAX_ISSUE_URL_CHARS) return url;
  }

  let lo = 1;
  let hi = page.length;
  let best = encode(title, formatBody("/", ""));
  while (lo <= hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const clipped = mid < page.length ? `${page.slice(0, mid)}...` : page;
    const candidate = encode(title, formatBody(clipped, ""));
    if (candidate.length <= MAX_ISSUE_URL_CHARS) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
