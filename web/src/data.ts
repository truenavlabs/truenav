import harborScore from "./fixtures/harbor-score.json";
import meridianScore from "./fixtures/meridian-score.json";
import harborReport from "./fixtures/harbor-report.json";
import meridianReport from "./fixtures/meridian-report.json";
import harborBuy from "./fixtures/harbor-buy.json";
import meridianBuy from "./fixtures/meridian-buy.json";

export type Score = typeof harborScore | typeof meridianScore;
export type Report = typeof harborReport | typeof meridianReport;
export type Buy = typeof harborBuy;

export const scores: Score[] = [harborScore, meridianScore];
export const reports: Report[] = [harborReport, meridianReport];
export const buys: Record<string, Buy> = {
  "harbor-credit-fund": harborBuy,
  "meridian-yield-fund": meridianBuy,
};

export function scoreById(tokenId: string): Score | undefined {
  return scores.find((row) => row.token_id === tokenId);
}

export function reportById(tokenId: string): Report | undefined {
  return reports.find((row) => row.token_id === tokenId);
}

export function receiptByTokenSeq(tokenId: string, seq: string) {
  const report = reports.find((row) => row.token_id === tokenId && row.receipt.seq === seq);
  return report ? report.receipt : undefined;
}
