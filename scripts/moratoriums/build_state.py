"""state_actions.csv: enacted state-level data-center measures from upstream state_legislation.csv (+ state_additions rows).

    python build_state.py [--work DIR] [--dataset DIR] [--build DIR]

Reads   WORK/upstream/data/state_legislation.csv, WORK/upstream/work/answers/*/*.json,
        WORK/inputs/state_additions.csv
Writes  BUILD/state_actions.csv
"""
import glob, json, re
import pandas as pd

import argparse, os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # scripts/, for moratoriums.refresh

_ap = argparse.ArgumentParser()
_ap.add_argument("--work", default=os.environ.get("DCM_WORK") or os.getcwd(), help="work dir (env DCM_WORK; default cwd)")
_ap.add_argument("--dataset", help="published outputs (default WORK/dataset)")
_ap.add_argument("--build", help="intermediates (default WORK/build)")
_args = _ap.parse_args()
WORK = os.path.abspath(_args.work)
DATASET = os.path.abspath(_args.dataset or f"{WORK}/dataset")
BUILD = os.path.abspath(_args.build or f"{WORK}/build")
IN = f"{WORK}/inputs"
U = f"{WORK}/upstream"
os.makedirs(BUILD, exist_ok=True)
s = pd.read_csv(f"{U}/data/state_legislation.csv", dtype=str, keep_default_na=False)

ev = {}
PRI = {"primary": 0, "government": 0, "official": 0, "news": 2}
for f in sorted(glob.glob(f"{U}/work/answers/*/*.json")):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    for dec in (d.get("decisions", []) if isinstance(d, dict) else []) or []:
        k = dec.get("bill_key")
        if k:
            ev.setdefault(k, []).extend((PRI.get(str(e.get("source_type", "")).split("_")[0], 1), e["url"])
                                        for e in dec.get("evidence", []) or [] if str(e.get("url", "")).startswith("http"))
    for b in (d.get("new_bills", []) if isinstance(d, dict) else []) or []:
        k = f"{b.get('state_abbrev', d.get('state_abbrev'))}:{b.get('bill')}"
        ev.setdefault(k, []).extend((1, e["url"]) for e in b.get("evidence", []) or [] if str(e.get("url", "")).startswith("http"))

# hand classification after reading every enacted row's key_provisions (2026-10-03)
PAUSE = {"ny-executive-order-no-62-2026": "permit pause (state agency)",
         "az-hb-4168-2026": "incentive moratorium",
         "ny-s6486d-a7389c-2021-2022-enacted": "permit pause (crypto mining only)"}
# later primary sources for upstream rows: pid -> (urls placed first, end_condition)
EXTRA = {"tx-abbott-2026-08-03-data-center-audit-directive": (
    ["https://www.ercot.com/files/docs/2026/09/11/14-Batch-Zero-Update.pdf"],  # ERCOT board item 14, 2026-09-11
    "Until the PUCT/ERCOT verification and audit completes; ERCOT reports due to PUCT 2026-12-10.")}
OFF_TOPIC = {"MD:HB0293 / SB0056 (2026)", "KS:SB 51 (2025/2026)", "OK:HB 2836 (2025)"}

def clip(t, n=200):
    t = re.sub(r"\s+", " ", re.sub(r"\[VERIFY[^\]]*\]", "", t)).strip()
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"

ENACTED = (s.bill_status_category == "enacted") | (s.legal_effect_status == "in_force")
rows = []
for r in s[ENACTED].itertuples():
    key = f"{r.state_abbrev}:{r.bill}"
    if key in OFF_TOPIC:
        continue
    pid = r.policy_action_id
    pause = PAUSE.get(pid, "")
    if "abbott" in r.bill.lower():
        pause = "interconnection pause (ERCOT Batch Zero audit)"
    extra_urls, end = EXTRA.get(pid, ([], r.end_condition))
    urls = list(extra_urls)
    for _, u in sorted(([(0, r.primary_source_url)] if r.primary_source_url else []) + ev.get(key, [])):
        if u not in urls:
            urls.append(u)
    rows.append(dict(
        id=f"nm-state-{pid}", state=r.state_abbrev, instrument=r.bill,
        instrument_type=r.policy_instrument_type, mechanism=r.policy_mechanism, pause_like=bool(pause), pause_kind=pause,
        status="enacted" if r.legal_effect_status != "in_force" else "in_force", date_last_action=r.last_action_date_iso,
        date_effective=r.effective_date_iso, end_condition=end, summary=clip(r.key_provisions),
        source_urls="|".join(urls[:6]), upstream_id=pid, verify_flag="[VERIFY" in "".join(map(str, r)),
    ))
st = pd.DataFrame(rows)
add = f"{IN}/state_additions.csv"
if os.path.exists(add):
    st = pd.concat([st, pd.read_csv(add, dtype=str, keep_default_na=False)], ignore_index=True)
st.sort_values(["pause_like", "state"], ascending=[False, True]).to_csv(f"{BUILD}/state_actions.csv", index=False)
print("enacted rows:", len(st), "pause-like:", st.pause_like.astype(str).eq("True").sum(), "with urls:", (st.source_urls != "").sum())
print("mechanism:", st.mechanism.value_counts().to_dict())

