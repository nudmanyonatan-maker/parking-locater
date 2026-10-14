#!/usr/bin/env python3
"""Fire hydrants near home, from NYC DEP's citywide hydrants open data.

Writes their positions to hydrants.json as [[lat, lon], ...]; the app marks
them on the map and warns when the car is parked next to one.

Usage: python3 fetch_hydrants.py OUT.json [lat lon radius_m]
"""
import json, sys, urllib.parse, urllib.request
from datetime import datetime, timezone

OUT = sys.argv[1]
LAT, LON = (float(sys.argv[2]), float(sys.argv[3])) if len(sys.argv) > 3 else (40.851304, -73.930153)  # 403 Audubon Ave
RADIUS_M = float(sys.argv[4]) if len(sys.argv) > 4 else 1000.0
DOMAIN = "https://data.cityofnewyork.us"
KNOWN_IDS = ["5bgh-vtsn"]  # "NYCDEP Citywide Hydrants"


def get(url):
    return json.load(urllib.request.urlopen(url, timeout=120))


def dataset_id():
    for ds in KNOWN_IDS:
        try:
            if get(f"{DOMAIN}/resource/{ds}.json?$limit=1"):
                return ds
        except Exception as e:  # moved or renamed: search the catalog instead
            print(f"{ds}: {e}", file=sys.stderr)
    q = urllib.parse.urlencode({"domains": "data.cityofnewyork.us", "q": "hydrants", "only": "dataset", "limit": 20})
    for r in get(f"https://api.us.opendata.socrata.com/api/catalog/v1?{q}")["results"]:
        name, ds = r["resource"]["name"], r["resource"]["id"]
        print(f"catalog: {ds} {name}", file=sys.stderr)
        if "hydrant" in name.lower():
            return ds
    sys.exit("No hydrant dataset found")


ds = dataset_id()
sample = get(f"{DOMAIN}/resource/{ds}.json?$limit=1")[0]
print(f"dataset {ds}, columns: {sorted(sample)}", file=sys.stderr)
geo = next((k for k, v in sample.items() if isinstance(v, dict) and v.get("type") == "Point"), None)
lat_key = next((k for k in sample if k.lower() in ("latitude", "lat")), None)
lon_key = next((k for k in sample if k.lower() in ("longitude", "lon", "long")), None)
if geo:
    where = f"within_circle({geo}, {LAT}, {LON}, {RADIUS_M:.0f})"
elif lat_key and lon_key:
    d_lat, d_lon = RADIUS_M / 111_320, RADIUS_M / 84_300  # metres per degree at this latitude
    where = f"{lat_key}::number between {LAT - d_lat} and {LAT + d_lat} AND {lon_key}::number between {LON - d_lon} and {LON + d_lon}"
else:
    sys.exit("No location columns")

rows = get(f"{DOMAIN}/resource/{ds}.json?" + urllib.parse.urlencode({"$where": where, "$limit": 50000}))
points = set()
for r in rows:
    try:
        lon, lat = r[geo]["coordinates"] if geo else (float(r[lon_key]), float(r[lat_key]))
    except (KeyError, TypeError, ValueError):
        continue
    points.add((round(float(lat), 6), round(float(lon), 6)))
print(f"{len(points)} hydrants within {RADIUS_M:.0f} m", file=sys.stderr)
if len(points) < 50:
    sys.exit("Too few hydrants; the query is probably wrong")

with open(OUT, "w") as f:
    json.dump(
        {
            "source": f"NYC DEP hydrants ({DOMAIN}/d/{ds})",
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "home": [LAT, LON],
            "points": sorted(points),
        },
        f,
        separators=(",", ":"),
    )
    f.write("\n")
