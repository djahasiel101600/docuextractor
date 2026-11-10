"""Country vocabulary used by semantic field validation.

Extraction candidates such as ``"address."`` or ``"Gateshead Dr"`` must never
be accepted as a nationality just because they happen to sit next to a
"Citizenship" label. This module provides a self-contained ISO 3166-1 name and
alpha-2 code set (plus common English aliases) so the pipeline can reject
non-country values without adding a third-party dependency.

Values are stored casefolded and unaccented; ``is_country_value`` normalizes
the incoming text the same way before comparing. Exact matches are preferred;
values that are one typo away from a known country name (adjacent transposition,
single insertion/deletion/substitution) are still accepted, because a hand-typed
form saying "Phiippines" carries a country, not a data error. City names and
address fragments remain far enough from every country name to stay rejected.
"""
import unicodedata
from difflib import get_close_matches

COUNTRY_NAMES = frozenset(
    line.strip()
    for line in """
afghanistan
albania
algeria
andorra
angola
antigua and barbuda
argentina
armenia
australia
austria
azerbaijan
bahamas
bahrain
bangladesh
barbados
belarus
belgium
belize
benin
bhutan
bolivia
bosnia and herzegovina
botswana
brazil
brunei
bulgaria
burkina faso
burundi
cabo verde
cambodia
cameroon
canada
central african republic
chad
chile
china
colombia
comoros
congo
costa rica
croatia
cuba
cyprus
czechia
democratic republic of the congo
denmark
djibouti
dominica
dominican republic
ecuador
egypt
el salvador
equatorial guinea
eritrea
estonia
eswatini
ethiopia
fiji
finland
france
gabon
gambia
georgia
germany
ghana
greece
grenada
guatemala
guinea
guinea-bissau
guyana
haiti
honduras
hungary
iceland
india
indonesia
iran
iraq
ireland
israel
italy
ivory coast
jamaica
japan
jordan
kazakhstan
kenya
kiribati
kuwait
kyrgyzstan
laos
latvia
lebanon
lesotho
liberia
libya
liechtenstein
lithuania
luxembourg
madagascar
malawi
malaysia
maldives
mali
malta
marshall islands
mauritania
mauritius
mexico
micronesia
moldova
monaco
mongolia
montenegro
morocco
mozambique
myanmar
namibia
nauru
nepal
netherlands
new zealand
nicaragua
niger
nigeria
north korea
north macedonia
norway
oman
pakistan
palau
palestine
panama
papua new guinea
paraguay
peru
philippines
poland
portugal
qatar
romania
russia
rwanda
saint kitts and nevis
saint lucia
saint vincent and the grenadines
samoa
san marino
sao tome and principe
saudi arabia
senegal
serbia
seychelles
sierra leone
singapore
slovakia
slovenia
solomon islands
somalia
south africa
south korea
south sudan
spain
sri lanka
sudan
suriname
sweden
switzerland
syria
taiwan
tajikistan
tanzania
thailand
timor-leste
togo
tonga
trinidad and tobago
tunisia
turkey
turkmenistan
tuvalu
uganda
ukraine
united arab emirates
united kingdom
united states
united states of america
uruguay
uzbekistan
vanuatu
vatican city
venezuela
vietnam
yemen
zambia
zimbabwe
""".splitlines()
    if line.strip()
)

COUNTRY_CODES = frozenset(
    """
ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj
bl bm bn bo bq br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr
cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr
ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu
id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz
la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq
mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf
pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si
sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr
tt tv tw tz ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw
""".split()
)

# Common English spellings and abbreviations that are not the canonical ISO
# name but are unambiguous on these forms.
COUNTRY_ALIASES = frozenset(
    line.strip()
    for line in """
america
britain
burma
cape verde
cote d'ivoire
czech republic
drc
dprk
east timor
england
federated states of micronesia
great britain
holy see
hong kong
hong kong sar
iran, islamic republic of
islamic republic of iran
korea, democratic people's republic of
korea, republic of
kosovo
kyrgyz republic
lao pdr
lao people's democratic republic
macau
macau sar
macao
macao sar
macedonia
moldova, republic of
myanmar
northern ireland
plurinational state of bolivia
puerto rico
republic of ireland
republic of korea
republic of the congo
russian federation
scotland
slovak republic
st. kitts and nevis
st. lucia
st. vincent and the grenadines
swaziland
syrian arab republic
taiwan, province of china
tanzania, united republic of
tibet
turkiye
u.s.
u.s.a.
u.k.
uae
u.a.e.
uk
united kingdom of great britain and northern ireland
united states of america
usa
vatican
viet nam
wales
west bank
""".splitlines()
    if line.strip()
)


def _normalize(value):
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(
        character for character in text if not unicodedata.combining(character))
    return " ".join(text.casefold().strip().strip(".,;:").split())


_NORMALIZED_NAMES = frozenset(_normalize(name) for name in COUNTRY_NAMES)
_NORMALIZED_ALIASES = frozenset(_normalize(alias) for alias in COUNTRY_ALIASES)
_NORMALIZED_CODES = frozenset(code.casefold() for code in COUNTRY_CODES)

# Fuzzy matching only ever proposes a country name, never a two-letter code:
# codes are too short for a one-edit comparison to stay meaningful. Names are
# bucketed by length so the single-edit scan stays a handful of comparisons.
_FUZZY_CANDIDATES = tuple(sorted(_NORMALIZED_NAMES | _NORMALIZED_ALIASES))
_CANDIDATES_BY_LENGTH = {}
for _candidate in _FUZZY_CANDIDATES:
    _CANDIDATES_BY_LENGTH.setdefault(len(_candidate), []).append(_candidate)
_FUZZY_MIN_LENGTH = 6
_FUZZY_RATIO_CUTOFF = 0.9


def _is_single_edit_typo(value, candidate):
    """True when value and candidate differ by one insertion/deletion/
    substitution or one adjacent transposition (optimal string alignment 1)."""
    if value == candidate:
        return False
    if len(value) == len(candidate):
        mismatches = [
            index
            for index, (left, right) in enumerate(zip(value, candidate))
            if left != right
        ]
        if len(mismatches) == 1:
            return True
        if len(mismatches) == 2:
            first, second = mismatches
            return (
                second == first + 1
                and value[first] == candidate[second]
                and value[second] == candidate[first]
            )
        return False
    # One string must be the other plus a single extra character.
    shorter, longer = (
        (value, candidate) if len(value) < len(
            candidate) else (candidate, value)
    )
    if len(longer) - len(shorter) != 1:
        return False
    index = 0
    while index < len(shorter) and shorter[index] == longer[index]:
        index += 1
    return shorter[index:] == longer[index + 1:]


def _fuzzy_country_match(normalized):
    """Return a near-miss country name for a typo, or None.

    Only digit-free, reasonably long values are considered, and the candidate
    must be either a high similarity match or exactly one edit away. That keeps
    "Phiippines"/"Untied States" while "Alexandria", "Bishkek" and address
    fragments remain non-countries.
    """
    if len(normalized) < _FUZZY_MIN_LENGTH:
        return None
    if any(character.isdigit() for character in normalized):
        return None
    if len(normalized.split()) > 4:
        return None
    close = get_close_matches(
        normalized, _FUZZY_CANDIDATES, n=1, cutoff=_FUZZY_RATIO_CUTOFF
    )
    if close:
        return close[0]
    length = len(normalized)
    nearby = (
        _CANDIDATES_BY_LENGTH.get(length - 1, [])
        + _CANDIDATES_BY_LENGTH.get(length, [])
        + _CANDIDATES_BY_LENGTH.get(length + 1, [])
    )
    for candidate in nearby:
        if len(candidate) < _FUZZY_MIN_LENGTH:
            continue
        if _is_single_edit_typo(normalized, candidate):
            return candidate
    return None


def is_country_value(value):
    """Return True when ``value`` names an ISO country or a known alias.

    A single-typo rendering of a country name is accepted as well; the caller
    keeps the original text, this guard only decides whether it is country-like
    enough to be exported.
    """
    normalized = _normalize(value)
    if not normalized:
        return False
    if (
        normalized in _NORMALIZED_NAMES
        or normalized in _NORMALIZED_ALIASES
        or normalized in _NORMALIZED_CODES
    ):
        return True
    return _fuzzy_country_match(normalized) is not None
