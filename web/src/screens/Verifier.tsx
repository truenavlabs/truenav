import { useEffect, useState, type FormEvent } from "react";
import { receiptByTokenSeq } from "../data";
import { mockCheck, type Step, type VerifierResult } from "../mockVerify";

type Outcome = { steps: Step[]; verifier: VerifierResult; source: string };

async function run(paste: string, tokenId: string, seq: string): Promise<Outcome> {
  const text = paste.trim();
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      const checked = await mockCheck(parsed);
      return { ...checked, source: "pasted receipt JSON" };
    } catch {
      const checked = await mockCheck(null);
      return { ...checked, source: "pasted receipt JSON" };
    }
  }
  const found = receiptByTokenSeq(tokenId.trim(), seq.trim());
  if (!found) {
    const checked = await mockCheck(null);
    return {
      source: `token_id ${tokenId || "(empty)"} seq ${seq || "(empty)"}`,
      verifier: { attestation_status: "unavailable", reason_codes: ["evidence_unavailable"] },
      steps: checked.steps.map((step) => ({ ...step, detail: "no simulated receipt" })),
    };
  }
  const checked = await mockCheck(found);
  return { ...checked, source: `token_id ${tokenId} seq ${seq}` };
}

export function Verifier({ search }: { search: string }) {
  const params = new URLSearchParams(search);
  const initialToken = params.get("token_id") ?? "harbor-credit-fund";
  const initialSeq = params.get("seq") ?? "1";
  const [tokenId, setTokenId] = useState(initialToken);
  const [seq, setSeq] = useState(initialSeq);
  const [paste, setPaste] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    let live = true;
    void run("", initialToken, initialSeq).then((next) => {
      if (live) setOutcome(next);
    });
    return () => {
      live = false;
    };
  }, [initialToken, initialSeq]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void run(paste, tokenId, seq).then(setOutcome);
  }

  return (
    <div className="grey">
      <h1>Receipt verifier</h1>
      <p>Simulated checks. No network.</p>
      <form className="box" onSubmit={onSubmit}>
        <label htmlFor="paste">paste receipt JSON</label>
        <textarea id="paste" value={paste} placeholder="paste receipt JSON" onChange={(event) => setPaste(event.target.value)} />
        <div className="grid">
          <div>
            <label htmlFor="token_id">token_id</label>
            <input id="token_id" value={tokenId} placeholder="token_id" onChange={(event) => setTokenId(event.target.value)} />
          </div>
          <div>
            <label htmlFor="seq">seq</label>
            <input id="seq" value={seq} placeholder="seq" onChange={(event) => setSeq(event.target.value)} />
          </div>
        </div>
        <button type="submit">check</button>
      </form>
      <section className="box">
        <h2>steps</h2>
        <p>{outcome ? outcome.source : "simulated check"}</p>
        <div className="grid">
          {(outcome?.steps ?? []).map((step) => (
            <div className="box" key={step.name}>
              <div className="k">{step.name}</div>
              <div>{step.result}</div>
              <div>{step.detail}</div>
            </div>
          ))}
        </div>
      </section>
      <section className="box">
        <h2>verifier result</h2>
        <pre>{outcome ? JSON.stringify(outcome.verifier, null, 2) : "simulated check"}</pre>
      </section>
    </div>
  );
}
