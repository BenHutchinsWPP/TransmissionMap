#!/usr/bin/env python3
"""Build src/registry/escalation-index.json: the year index the route cost engine escalates with.

Network (BLS public API v1, no key; not run in CI). Annual averages 1990..2025 of

  labour    ECI total compensation, private industry, construction  CIU2012300000000I
            (starts 2001; earlier years chained back with CES2000000008, average hourly
            earnings of production and nonsupervisory employees, construction)
  materials PPI net inputs to power and communication structures    WPUIP231232
            (earlier years chained back with WPUSI012011, materials and components
            for construction)

Chaining: S[y] = fallback[y] * primary[y0] / fallback[y0] for y < y0, y0 the first year
the primary series has. Blend: I[y] = 0.526 L[y]/L[2025] + 0.474 M[y]/M[2025], so
I[2025] = 1. The labour weight 0.526 is the bare-cost labour share of the example line in
the MISO MTEP26 cost estimation workbook (labour cells F134+F136+F138 over bare F131..F138).

Usage: python3 scripts/build_escalation_index.py [--raw-dir DIR]   (replies saved to DIR)
"""
import argparse
import datetime
import json
import os
import urllib.request

API = 'https://api.bls.gov/publicAPI/v1/timeseries/data/'
FIRST, TO_YEAR = 1990, 2025
LABOUR_W = 0.526
SERIES = {
    'labour': ('CIU2012300000000I', 'CES2000000008'),
    'materials': ('WPUIP231232', 'WPUSI012011'),
}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'registry', 'escalation-index.json')


def annual(rows, years):
    """rows: BLS data rows of one series. Returns {year: annual average}; a published
    annual value (M13, Q05, A01) wins, else the mean of a complete year of monthly (12) or
    quarterly (4) values. A year with a gap is left out."""
    by = {}
    for r in rows:
        by.setdefault(int(r['year']), {})[r['period']] = float(r['value'])
    out = {}
    for y, p in by.items():
        if y not in years:
            continue
        pub = [p[k] for k in ('M13', 'Q05', 'A01') if k in p]
        mon = [p[f'M{m:02d}'] for m in range(1, 13) if f'M{m:02d}' in p]
        qtr = [p[f'Q{q:02d}'] for q in range(1, 5) if f'Q{q:02d}' in p]
        if pub:
            out[y] = pub[0]
        elif len(mon) == 12:
            out[y] = sum(mon) / 12
        elif len(qtr) == 4:
            out[y] = sum(qtr) / 4
    return out


def chain(primary, fallback, years):
    """primary, fallback: {year: value}. Primary where it has a year, else the fallback
    rescaled at the first common year y0 (the first year of primary)."""
    y0 = min(primary)
    if y0 not in fallback:
        raise ValueError(f'fallback has no value for the first primary year {y0}')
    k = primary[y0] / fallback[y0]
    out = {}
    for y in years:
        if y in primary:
            out[y] = primary[y]
        elif y in fallback and y < y0:
            out[y] = fallback[y] * k
        else:
            raise ValueError(f'no value for {y}')
    return out, y0


def blend(labour, materials, to_year, w=LABOUR_W):
    return {y: w * labour[y] / labour[to_year] + (1 - w) * materials[y] / materials[to_year]
            for y in sorted(labour)}


def fetch(ids, raw_dir):
    rows = {i: [] for i in ids}
    for a in range(FIRST, TO_YEAR + 1, 10):
        b = min(a + 9, TO_YEAR)
        body = json.dumps({'seriesid': ids, 'startyear': str(a), 'endyear': str(b)}).encode()
        req = urllib.request.Request(API, body, {'Content-type': 'application/json'})
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read().decode()
        if raw_dir:
            os.makedirs(raw_dir, exist_ok=True)
            with open(os.path.join(raw_dir, f'bls_{a}_{b}.json'), 'w') as f:
                f.write(text)
        reply = json.loads(text)
        if reply.get('status') != 'REQUEST_SUCCEEDED':
            raise SystemExit(f'BLS {a}-{b}: {reply.get("status")} {reply.get("message")}')
        for s in reply['Results']['series']:
            rows[s['seriesID']].extend(s['data'])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw-dir')
    args = ap.parse_args()
    ids = [i for pair in SERIES.values() for i in pair]
    rows = fetch(ids, args.raw_dir)
    years = range(FIRST, TO_YEAR + 1)
    parts, info = {}, {}
    for name, (pid, fid) in SERIES.items():
        p = annual(rows[pid], set(years))
        f = annual(rows[fid], set(years))
        missing = [y for y in years if y not in p and y not in f]
        if missing:
            raise SystemExit(f'{pid}/{fid}: no complete year for {missing}')
        if TO_YEAR not in p:
            raise SystemExit(f'{pid}: no complete {TO_YEAR}')
        parts[name], y0 = chain(p, f, years)
        info[name] = {'id': pid, 'first_year': y0, 'chain_id': fid, 'chain_years': [FIRST, y0 - 1] if y0 > FIRST else []}
    idx = blend(parts['labour'], parts['materials'], TO_YEAR)
    doc = {
        'to_year': TO_YEAR,
        'index': {str(y): round(v, 6) for y, v in idx.items()},
        'series': info,
        'weights': {'labour': LABOUR_W, 'materials': round(1 - LABOUR_W, 3)},
        'fetched': datetime.date.today().isoformat(),
        'src': 'BLS annual averages: ECI construction compensation and PPI power and communication structures inputs, '
               'each chained back with a longer BLS series, blended 0.526 labour / 0.474 materials (MISO MTEP26 cost workbook example line).',
    }
    with open(OUT, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    print('2014->2025 x%.4f  2018->2025 x%.4f' % (idx[2025] / idx[2014], idx[2025] / idx[2018]))
    for n in parts:
        print(n, '2014->2025 x%.4f' % (parts[n][2025] / parts[n][2014]), info[n])


if __name__ == '__main__':
    main()
