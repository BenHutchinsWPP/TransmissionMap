"""Text normalisation shared by the whole moratorium pipeline.

Role: the one copy of `norm`/`jn` (jurisdiction-name keys, ported verbatim from
the build scripts) plus `normalize_text` and `match_key` for quote-versus-page comparison.
Dependencies: stdlib only; imported by verify.py and the build scripts.
"""
import re
import unicodedata


def norm(s):
    s = s.lower().replace("&", "and")
    s = re.sub(r"\bst\.?\s", "saint ", s)
    s = re.sub(r"\b(county|parish|city of|town of|village of|township|charter township|borough|city|town|village|of)\b", " ", s)
    return re.sub(r"[^a-z0-9]+", "", s)


def jn(name):
    return norm(re.sub(r"\(.*?\)|^City of |^Town of |^Village of |metropolitan government", "", name))


_MAP = str.maketrans({
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
})
_INVISIBLE = dict.fromkeys(map(ord, "​‌‍⁠﻿"))


def normalize_text(s):
    """Casefold, NFKC, ASCII quotes/dashes, no invisibles, joined hyphenation, single spaces."""
    s = s.translate(_INVISIBLE)
    s = re.sub(r"­\s*\n\s*", "", s).replace("­", "")
    s = unicodedata.normalize("NFKC", s).translate(_MAP)
    s = re.sub(r"(?<=\w)-[^\S\n]*\n\s*(?=\w)", "", s)
    s = s.casefold()
    return re.sub(r"\s+", " ", s).strip()


def match_key(s):
    """normalize_text with every hyphen (and the spaces around it) removed, for quote-versus-page
    comparison: a hyphenated compound split across lines, or a dash with and without spaces, compares equal."""
    return re.sub(r"\s*-\s*", "", normalize_text(s))
