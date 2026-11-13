// URL builder for the help-bubble "open a ticket" link. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ISSUES_NEW_URL,
  ISSUE_TITLE,
  MAX_ISSUE_URL_CHARS,
  buildIssueUrl,
  sanitizeAccount,
  sanitizePath,
} from "../src/lib/ticket.mjs";

function parsed(url) {
  const u = new URL(url);
  return { href: url, title: u.searchParams.get("title"), body: u.searchParams.get("body") || "" };
}

test("wallet account is excluded by default even when an account id is passed", () => {
  const a = parsed(buildIssueUrl({ page: "/support", accountId: "alice.testnet" }));
  const b = parsed(buildIssueUrl({ page: "/support", accountId: "alice.testnet", includeAccount: false }));
  assert.equal(a.href.startsWith(`${ISSUES_NEW_URL}?`), true);
  assert.equal(a.title, ISSUE_TITLE);
  assert.match(a.body, /^Page: \/support\n/);
  assert.match(a.body, /What happened:/);
  assert.match(a.body, /What you expected:/);
  assert.equal(a.body.includes("alice.testnet"), false);
  assert.equal(a.body.includes("Wallet account"), false);
  assert.equal(b.body.includes("alice.testnet"), false);
});

test("wallet account is included only when signed in and opted in", () => {
  const included = parsed(buildIssueUrl({ page: "/faq", accountId: "alice.testnet", includeAccount: true }));
  assert.match(included.body, /Page: \/faq/);
  assert.match(included.body, /Wallet account \(included by opt-in\): alice\.testnet/);
  const noId = parsed(buildIssueUrl({ page: "/faq", includeAccount: true }));
  assert.equal(noId.body.includes("Wallet account"), false);
  const empty = parsed(buildIssueUrl({ page: "/faq", accountId: "", includeAccount: true }));
  assert.equal(empty.body.includes("Wallet account"), false);
});

test("title and body are encoded as URL params", () => {
  const url = buildIssueUrl({ page: "/funds/a&b c", accountId: "alice.testnet", includeAccount: true });
  assert.equal(url.includes(" "), false);
  assert.equal(url.includes("\n"), false);
  assert.match(url, /title=Support%20request/);
  assert.match(url, /body=Page%3A%20/);
  const { body, title } = parsed(url);
  assert.equal(title, "Support request");
  assert.match(body, /Page: \/funds\/a&b c/);
  assert.match(body, /alice\.testnet/);
});

test("URL length is capped at about 6000 characters", () => {
  const longPath = `/${"n".repeat(8000)}`;
  const url = buildIssueUrl({ page: longPath, accountId: "alice.testnet", includeAccount: true });
  assert.equal(url.length <= MAX_ISSUE_URL_CHARS, true, `url length ${url.length}`);
  assert.equal(url.length > 80, true);
  const { body } = parsed(url);
  assert.match(body, /^Page: \//);
  assert.match(body, /What happened:/);
  assert.equal(body.includes("alice.testnet"), false);
});

test("sanitizePath keeps a path only and sanitizeAccount rejects keys", () => {
  assert.equal(sanitizePath("/funds/meridian-yield-fund?tab=exposure#x"), "/funds/meridian-yield-fund");
  assert.equal(sanitizePath(""), "/");
  assert.equal(sanitizePath("support"), "/support");
  assert.equal(sanitizeAccount("alice.testnet"), "alice.testnet");
  assert.equal(sanitizeAccount("ed25519:FakeKeyMaterial"), "");
  assert.equal(sanitizeAccount("secp256k1:FakeKeyMaterial"), "");
  assert.equal(sanitizeAccount("not a wallet"), "");
});

test("builder never accepts chat history or leftover secrets", () => {
  const url = buildIssueUrl({
    page: "/overview",
    accountId: "alice.testnet",
    includeAccount: false,
    history: [{ role: "user", content: "secret chat" }],
    chat: "secret chat",
    apiKey: "NEARAI_API_KEY",
    key: "sk-test",
  });
  const { body } = parsed(url);
  assert.equal(body.includes("secret chat"), false);
  assert.equal(body.includes("NEARAI_API_KEY"), false);
  assert.equal(body.includes("sk-test"), false);
  assert.equal(body.includes("alice.testnet"), false);
});
