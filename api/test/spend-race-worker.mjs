import { reserveSpend } from "../spend-store.mjs";

const [dir, mode, nonceOrPrefix, buyer, nowRaw, expRaw, countRaw, limitRaw] = process.argv.slice(2);
const nowMs = Number(nowRaw);
const exp = Number(expRaw);
const limit = limitRaw ? Number(limitRaw) : undefined;
try {
  if (mode === "once") {
    const result = await reserveSpend(dir, { buyer, nonce: nonceOrPrefix, nowMs, exp, ...(limit ? { limit } : {}) });
    process.stdout.write(result.ok ? "accept\n" : "reject\n");
  } else if (mode === "burst") {
    let accepted = 0;
    const count = Number(countRaw);
    for (let i = 0; i < count; i++) {
      const result = await reserveSpend(dir, { buyer, nonce: `${nonceOrPrefix}-${i}`, nowMs, exp });
      if (result.ok) accepted += 1;
    }
    process.stdout.write(String(accepted));
  } else {
    process.stderr.write("unknown mode\n");
    process.exit(2);
  }
} catch (error) {
  process.stdout.write(`error ${error.message}\n`);
  process.exitCode = 2;
}
