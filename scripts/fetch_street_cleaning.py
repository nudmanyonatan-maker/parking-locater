#!/usr/bin/env python3
"""Street-cleaning (alternate side parking) signs near home, from NYC DOT's
"Parking Regulation Locations and Signs" open data (nfid-uabd).

Groups the broom-symbol signs into block faces (street, cross streets, side)
and writes their sign texts and positions to street-cleaning.json. Rules are
parsed at runtime by shared/cleaning.ts, so this only collects data.

Usage: python3 fetch_street_cleaning.py OUT.json [lat lon radius_ft]
Needs: pyproj (pip install pyproj)
"""
import json, re, sys, urllib.parse, urllib.request
from datetime import datetime, timezone
from pyproj import Transformer

OUT = sys.argv[1]
LAT, LON = (float(sys.argv[2]), float(sys.argv[3])) if len(sys.argv) > 3 else (40.851304, -73.930153)  # 403 Audubon Ave
RADIUS_FT = float(sys.argv[4]) if len(sys.argv) > 4 else 2200.0

to_sp = Transformer.from_crs("EPSG:4326", "EPSG:2263", always_xy=True)  # NY Long Island State Plane (ft)
to_ll = Transformer.from_crs("EPSG:2263", "EPSG:4326", always_xy=True)
hx, hy = to_sp.transform(LON, LAT)

where = (
    "borough='Manhattan' AND upper(sign_description) like '%BROOM%' AND record_type='Current' "
    f"AND sign_x_coord::number between {hx - RADIUS_FT:.0f} and {hx + RADIUS_FT:.0f} "
    f"AND sign_y_coord::number between {hy - RADIUS_FT:.0f} and {hy + RADIUS_FT:.0f}"
)
url = "https://data.cityofnewyork.us/resource/nfid-uabd.json?" + urllib.parse.urlencode({"$where": where, "$limit": 20000})
rows = json.load(urllib.request.urlopen(url, timeout=120))
print(f"{len(rows)} broom signs in the box", file=sys.stderr)

def clean_street(s):
    s = re.sub(r"\s+", " ", (s or "").strip().upper())
    return s

def clean_rule(desc):
    d = re.sub(r"\(SUPERSEDES[^)]*\)", "", desc.upper())
    d = d.replace("<->", "").replace("-->", "").replace("<--", "")
    return re.sub(r"\s+", " ", d).strip()

faces = {}
for r in rows:
    if r.get("sign_design_voided_on_date"):
        continue
    try:
        x, y = float(r["sign_x_coord"]), float(r["sign_y_coord"])
    except (KeyError, ValueError):
        continue
    if (x - hx) ** 2 + (y - hy) ** 2 > RADIUS_FT ** 2:
        continue
    street, a, b, side = clean_street(r.get("on_street")), clean_street(r.get("from_street")), clean_street(r.get("to_street")), (r.get("side_of_street") or "").upper()
    lo, hi = sorted([a, b])
    key = f"{street}|{lo}|{hi}|{side}"
    lon, lat = to_ll.transform(x, y)
    face = faces.setdefault(key, {"id": key, "street": street, "from": lo, "to": hi, "side": side, "rules": [], "points": []})
    rule = clean_rule(r.get("sign_description", ""))
    if not rule:
        continue
    if rule not in face["rules"]:
        face["rules"].append(rule)
    # Each sign: [lat, lon, index into rules]. Long blocks can change rules partway.
    face["points"].append([round(lat, 6), round(lon, 6), face["rules"].index(rule)])

out = {
    "source": "NYC DOT Parking Regulation Locations and Signs (data.cityofnewyork.us, nfid-uabd), broom-symbol signs",
    "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "home": {"lat": LAT, "lon": LON, "radiusFt": RADIUS_FT},
    "faces": sorted(faces.values(), key=lambda f: f["id"]),
}
import os
os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
with open(OUT, "w") as fh:
    json.dump(out, fh, indent=1)
print(f"{len(out['faces'])} block faces -> {OUT}", file=sys.stderr)
rules = sorted({r for f in out["faces"] for r in f["rules"]})
print(f"{len(rules)} distinct rules:", file=sys.stderr)
for r in rules:
    print("  " + r, file=sys.stderr)
