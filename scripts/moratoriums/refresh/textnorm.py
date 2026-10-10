"""Text normalisation shared by the whole moratorium pipeline.

Role: the one copy of `norm`/`jn` (jurisdiction-name keys, ported verbatim from
the build scripts) plus `normalize_text` and `match_key` for quote-versus-page comparison,
`name_in_text`, the whole-word form of the jn() test for a place named in a text, and `locate`,
which finds a quote's span in the raw text by its match_key().
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


_GENERIC = re.compile(r"\b(county|parish|city of|town of|village of|township|charter township|borough|city|town|village|of)\b")


def _words(s):
    """norm() as space-separated words: ' saint charles ' for 'City of St. Charles'."""
    s = re.sub(r"['’]", "", s.lower().replace("&", " and "))
    s = _GENERIC.sub(" ", re.sub(r"\bst\.?\s", "saint ", s))
    return " " + " ".join(re.findall(r"[a-z0-9]+", s)) + " "


def name_in_text(name, text):
    """The jurisdiction's name, as jn() reduces it, occurs in `text` as whole words: "Owen County" and
    "Town of Owen" both match "owen", but "Ada" does not match "Canada"."""
    key = _words(re.sub(r"\(.*?\)|^City of |^Town of |^Village of |metropolitan government", "", name))
    return bool(key.strip()) and key in _words(text)


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


def locate(quote, text):
    """(start, end) of `quote` in the raw `text`, found by match_key() as quote_in_page compares them,
    or None. Each raw character is normalised on its own, which agrees with match_key() except for
    combining sequences NFKC would compose."""
    chars, offs = [], []
    for i, ch in enumerate(text):
        if ord(ch) in _INVISIBLE or ch == "\xad":
            continue
        for c in unicodedata.normalize("NFKC", ch).translate(_MAP).casefold():
            chars.append(" " if c.isspace() else c)
            offs.append(i)
    key, kofs = [], []
    for m in re.finditer(r"( *- *)|( +)|([^ -]+)", "".join(chars)):
        if m.group(2):
            key.append(" ")
            kofs.append(offs[m.start()])
        elif m.group(3):
            key.append(m.group(3))
            kofs.extend(offs[m.start():m.end()])
    needle = match_key(quote or "")
    at = "".join(key).find(needle) if needle else -1
    if at < 0:
        return None
    return kofs[at], kofs[at + len(needle) - 1] + 1
