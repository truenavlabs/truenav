// Create a fresh spend store. Refuses to replace an existing state.json.
//   node api/spend-init.mjs <dir>
//   TRUENAV_SPEND_STORE=<dir> node api/spend-init.mjs
import { initSpendStore } from "./spend-store.mjs";

const dir = process.argv[2] || process.env.TRUENAV_SPEND_STORE;
if (!dir) {
  console.error("usage: node api/spend-init.mjs <dir>");
  process.exit(2);
}
try {
  await initSpendStore(dir, { create: true });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
console.log(`initialized spend store ${dir}`);
