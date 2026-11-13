// FAQ. Every answer comes from the repository docs; the source is in `src`.
import { FAQ as RAW } from "./faq-data.mjs";

export type Faq = { id: string; q: string; a: string; src: string; group: "Investors" | "Fund managers" | "Technical" };

export const FAQ: readonly Faq[] = RAW as readonly Faq[];
