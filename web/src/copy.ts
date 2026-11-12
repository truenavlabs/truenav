// Product copy. TrueNav informs only. Every TrueVal, TrueRange and score label carries its explainer.
export const NAMES: Record<string, string> = {
  "harbor-credit-fund": "Harbor",
  "meridian-yield-fund": "Meridian",
};

export const SLUGS: Record<string, string> = {
  harbor: "harbor-credit-fund",
  meridian: "meridian-yield-fund",
};

export const TOOLTIPS = {
  score: "how far you can trust the fund's reported NAV, 0 to 100.",
  trueVal: "what the fund's loans are worth after expected losses. model estimate, not fair value.",
  trueRange: "where TrueVal likely falls, assuming loans default independently. demo estimate.",
  bands: "green 85+, yellow 60 to 84, red below 60.",
} as const;

export const INFORMS =
  "TrueNav informs, like a credit rating. It does not hold or move funds. A red score is information, like a junk rating.";
