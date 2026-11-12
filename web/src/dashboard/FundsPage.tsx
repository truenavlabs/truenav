import { EXAMPLE_ROWS, listFunds, type ExampleRow, type FundRow } from "../api/client";
import { TOOLTIPS } from "../copy";
import { human, millions, usdMv } from "../format";
import { FlowLines } from "../components/Motif";
import { A } from "../ui";
import { BANDKEY, BANDWORD, Chip, Explain, MiniRange, bandVar, rangeIn, type BandKey } from "./parts";
import { DashShell } from "./Shell";

type Row = {
  key: string; name: string; sub: string; score: number | null; band: BandKey; word: string; tv: number;
  range: ReturnType<typeof rangeIn>; loans: string; attempts: number; rcpt: string; href?: string; ex: boolean;
};

function fromFund(f: FundRow): Row {
  const d = f.receipt, band = BANDKEY[d.band] ?? "y";
  return {
    key: f.token_id, name: f.name, sub: f.token_id, score: d.score, band, word: BANDWORD[d.band] ?? d.band, tv: millions(d.trueval),
    range: rangeIn(d, band), loans: human(d.loans_checked), attempts: d.blocked_attempts === "zero" ? 0 : 1,
    rcpt: `seq ${d.seq}`, href: `/fund/${f.token_id}`, ex: false,
  };
}
function fromExample(e: ExampleRow): Row {
  const band = BANDKEY[e.band];
  return {
    key: e.id, name: e.name, sub: "example row · not a fixture", score: e.score, band, word: "example", tv: millions(e.trueval),
    range: rangeIn(e, band), loans: human(e.loans), attempts: e.attempts, rcpt: "seq 1", ex: true,
  };
}

function TableRow({ r }: { r: Row }) {
  const body = (
    <>
      <div><div className="fn">{r.name}</div><div className="fid">{r.sub}</div></div>
      <div className="mini">
        <span className="n">{r.score ?? "n/a"}</span>
        {r.ex ? <Chip tone="ex">example</Chip> : <Chip tone={r.band}>{r.word}</Chip>}
      </div>
      <div className="vv">{usdMv(r.tv)}<small>trueval</small></div>
      <div className="c-rng"><MiniRange r={r.range} /></div>
      <div>
        {r.range.inside ? <Chip tone="g" dot>inside</Chip> : <Chip tone="r" dot>{r.range.over ? "above range" : "below range"}</Chip>}
      </div>
      <div>
        {r.attempts ? <Chip tone="y" dot>clear · {r.attempts} attempt</Chip> : <Chip tone="g" dot>clear</Chip>}
        <div className="fid" style={{ marginTop: 6 }}>loans {r.loans}</div>
      </div>
      <div className="vv sm">{r.rcpt}<small>{r.ex ? "example" : "unattested"}</small></div>
    </>
  );
  const cls = `trow${r.ex ? " exr" : ""}`;
  const style = { ["--bandc" as string]: bandVar(r.band) };
  return r.href ? (
    <A href={r.href} className={cls} style={style}>{body}</A>
  ) : (
    <div className={cls} style={style} title="example row, illustrative only">{body}</div>
  );
}

export function FundsPage() {
  const funds = listFunds();
  const rows = [...funds.map(fromFund), ...EXAMPLE_ROWS.map(fromExample)];
  const inside = funds.filter((f) => f.receipt.nav_result === "inside").length;
  const ranked = [...funds].sort((a, b) => (b.receipt.score ?? 0) - (a.receipt.score ?? 0));
  const hi = ranked[0], lo = ranked[ranked.length - 1];
  const methods = [...new Set(funds.map((f) => f.receipt.method_version.replace("truenav-", "")))].join(", ");
  return (
    <DashShell route="funds" crumb={<b>funds</b>}>
      <div className="card lsum">
        <FlowLines seed={7} fade={0.35} />
        <div className="tt"><div className="lbl idxl">[1] scores</div><h1>Funds</h1></div>
        <div className="kpis">
          <div className="kgrid">
            <div className="kg"><div className="v">{funds.length} fixtures</div><div className="s">+ {EXAMPLE_ROWS.length} example rows</div></div>
            <div className="kg">
              <div className="v"><span style={{ color: "var(--green)" }}>{inside}</span> inside · <span style={{ color: "var(--red)" }}>{funds.length - inside}</span> outside</div>
              <div className="s">reported NAV vs range, fixtures</div>
            </div>
            <div className="kg"><div className="v">{funds.length} · seq 1</div><div className="s">receipts · unattested</div></div>
            <div className="kg"><div className="v">{methods}</div><div className="s">method</div></div>
          </div>
          <div className="kside">
            <div><div className="v" style={{ color: "var(--green)" }}>{hi.name}</div><div className="s">highest score · fixture</div></div>
            <div><div className="v" style={{ color: "#b9292e" }}>{lo.name}</div><div className="s">lowest score · fixture</div></div>
          </div>
        </div>
      </div>
      <div className="card table" role="table" aria-label="Funds">
        <div className="thead">
          <span className="lbl">fund</span>
          <Explain term="score">score</Explain>
          <Explain term="trueVal">trueval</Explain>
          <span><Explain term="trueRange" inline>truerange</Explain><span className="lbl"> · reported nav</span></span>
          <span className="lbl">nav result</span>
          <span className="lbl">pledged once</span>
          <span className="lbl">receipt</span>
        </div>
        {rows.map((r) => <TableRow key={r.key} r={r} />)}
      </div>
      <div className="lcards">
        <div className="card"><span className="lbl">trueval</span><h3>A dollar figure.</h3><p>TrueVal: {TOOLTIPS.trueVal}</p><FlowLines seed={21} n={11} fade={0} amp={14} op={0.45} className="lines side-lines" /></div>
        <div className="card"><span className="lbl">truerange</span><h3>A band around it.</h3><p>TrueRange: {TOOLTIPS.trueRange}</p><FlowLines seed={22} n={11} fade={0} amp={14} op={0.45} className="lines side-lines" /></div>
        <div className="card"><span className="lbl">truenav score</span><h3>One number, 0 to 100.</h3><p>TrueNav score: {TOOLTIPS.score} Bands: {TOOLTIPS.bands}</p><FlowLines seed={23} n={11} fade={0} amp={14} op={0.45} className="lines side-lines" /></div>
      </div>
      <div className="foot"><span>FIXTURE · TESTNET · rows marked example are illustrative, not fixtures</span><span>public fields only</span></div>
    </DashShell>
  );
}
