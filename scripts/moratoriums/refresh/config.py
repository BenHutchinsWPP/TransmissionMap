"""Run configuration for the weekly moratorium refresh.

Role: one frozen `Config` holding caps, model ids, seed pages, discovery
queries, plus the `PRICES` table and `PROBE_MODELS`. Overridable with `DCM_*` environment variables or an
overrides dict (`Config.load`). Also holds the state name table used when
phrasing follow-up queries.
Dependencies: stdlib only; imported by queries.py and the later run modules.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, fields, replace
from typing import Mapping

# Model ids. The OpenRouter slugs are checked against https://openrouter.ai/api/v1/models (2026-10-08).
SONNET_MODEL = "claude-sonnet-5-5"
OPUS_MODEL = "claude-opus-5-5"
OPENROUTER_SONNET = "anthropic/claude-sonnet-5.5"
OPENROUTER_OPUS = "anthropic/claude-opus-5.5"

SEED_PAGES: tuple[str, ...] = (
    "https://www.savrn.com/data-center-moratorium-tracker",
    "https://datacenterbans.com/",
    "https://dcmap.us/",
    "https://servercountry.org/",
    "https://writing.strisker.com/",
    "https://www.nj.gov/pinelands/landuse/amend/ords.shtml",
    # SEC EDGAR full-text search; {query} is URL-encoded, {start}/{end} are ISO dates.
    "https://efts.sec.gov/LATEST/search-index?q={query}&dateRange=custom&startdt={start}&enddt={end}",
)

SEC_QUERY_TERMS: tuple[str, ...] = (
    '"data center" moratorium',
    '"data center" "pause" "new load"',
    '"large load" moratorium "data center"',
)

DISCOVERY_QUERIES: tuple[str, ...] = (
    "data center moratorium approved",
    "council bans data centers",
    "county commissioners data center moratorium vote",
    "township data center moratorium",
    "utility pauses new data center load",
    "utility pauses large load interconnection data centers",
    "PUD moratorium data centers",
    "cooperative moratorium cryptocurrency mining",
    "electric cooperative pauses crypto mining load",
    "extends data center moratorium",
    "lifts data center moratorium",
    "data center moratorium expires",
    "data center zoning ban adopted",
    "permanent ban on data centers ordinance",
    "board of supervisors data center moratorium",
    "city council pauses data center applications",
    "governor executive order data center pause",
    "state legislature data center moratorium bill",
    "planning commission data center moratorium recommended",
    "data center permit pause water power concerns",
)

# USD per million tokens; list prices 2026-10, verify on the pricing page.
PRICES: dict[str, dict[str, float]] = {
    SONNET_MODEL: {"input": 2.0, "output": 10.0, "cache_read": 0.2, "cache_write": 2.5},
    OPUS_MODEL: {"input": 4.0, "output": 20.0, "cache_read": 0.2, "cache_write": 5.0},
}

# Probe models per provider (used by `llm --probe`).
PROBE_MODELS = {"anthropic": SONNET_MODEL, "openrouter": OPENROUTER_SONNET}

US_STATES: dict[str, str] = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii",
    "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "PR": "Puerto Rico",
}


@dataclass(frozen=True)
class Config:
    # Hard stop on search requests (retries count). 220 = 200 planned + 20 slack for 429/5xx retries.
    max_requests: int = 220
    max_pages: int = 300
    max_llm_calls: int = 400
    max_opus_calls: int = 40
    discovery_reserved: int = 20
    # Stop issuing searches, fetches and model calls after this long, so the job's own timeout
    # never ends a run after its credits are spent; what was gathered is still verified and written.
    wall_clock_minutes: int = 90
    expiry_window_days: int = 21  # wider than the longest gap between runs (16 days)
    stale_days: int = 90
    sonnet_model: str = SONNET_MODEL
    opus_model: str = OPUS_MODEL
    openrouter_sonnet: str = OPENROUTER_SONNET
    openrouter_opus: str = OPENROUTER_OPUS
    seed_pages: tuple[str, ...] = SEED_PAGES
    discovery_queries: tuple[str, ...] = DISCOVERY_QUERIES
    # Per-priority request shares (D10); an unused share flows down to the next group.
    shares: tuple[tuple[str, int], ...] = (("pending", 80), ("expiring", 50), ("utility", 20), ("rotating", 30))

    @property
    def max_requests_for_planning(self) -> int:
        """Requests the planner may schedule: the shares plus the discovery reserve, within the hard stop."""
        return min(sum(n for _, n in self.shares) + self.discovery_reserved, self.max_requests)

    @classmethod
    def load(cls, env: Mapping[str, str] | None = None,
             overrides: Mapping[str, object] | None = None) -> "Config":
        """Defaults, then `DCM_<FIELD>` env vars (int fields; `DCM_SONNET_MODEL`/`DCM_OPUS_MODEL` strings, blank = default), then `overrides`."""
        env = os.environ if env is None else env
        cfg = cls()
        changes: dict[str, object] = {}
        for f in fields(cls):
            if isinstance(getattr(cfg, f.name), int):
                raw = env.get("DCM_" + f.name.upper())
                if raw not in (None, ""):
                    changes[f.name] = int(raw)
        for name in ("sonnet_model", "opus_model"):
            raw = (env.get("DCM_" + name.upper()) or "").strip()
            if raw:
                changes[name] = raw
        changes.update(overrides or {})
        return replace(cfg, **changes)
