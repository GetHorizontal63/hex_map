"""
Builds the static data files used by the web app.

Sources (no API key required):
  - ACS 5-year table-based summary files (tract + place rows)
  - Census Gazetteer files (tract / place internal points + land area)

Output:
  data/tracts.json  columnar tract table (location, land area, metrics)
  data/places.json  named places with population, used for map labels
  data/timeline/covid.json  weekly cumulative COVID-19 cases/deaths by county (NYT)
  data/bg/SS.json   per-state block-group tables, loaded on demand when a
                    state or county is in focus (Connecticut uses tracts:
                    its 2020 block-group centroids predate the 2022 county changes)

Usage:  python scripts/build_data.py [--year 2024]
"""
import argparse
import csv
import io
import json
import os
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", ".cache")
OUT = os.path.join(ROOT, "data")

ACS_URL = "https://www2.census.gov/programs-surveys/acs/summary_file/{y}/table-based-SF/data/5YRData/acsdt5y{y}-{t}.dat"
GAZ_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{y}_Gazetteer/{y}_Gaz_{k}_national.zip"
CENPOP_BG_URL = "https://www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/CenPop2020_Mean_BG.txt"
CB_BG_URL = "https://www2.census.gov/geo/tiger/GENZ{y}/shp/cb_{y}_us_bg_500k.zip"
# CDC PLACES 2025 release, census tract (GIS-friendly) table
PLACES_URL = "https://data.cdc.gov/api/views/yjkw-uj5s/rows.csv?accessType=DOWNLOAD"
NYT_URL = "https://raw.githubusercontent.com/nytimes/covid-19-data/master/us-counties-{y}.csv"
COUNTY_POP_2020_URL = "https://www2.census.gov/programs-surveys/popest/datasets/2010-2020/counties/totals/co-est2020-alldata.csv"

# PLACES crude prevalence measures from PolicyMap's chronic conditions index. Chronic kidney
# disease (their 12th) was dropped from PLACES in 2025 and older releases are no longer served.
HEALTH = ["obesity", "bphigh", "highchol", "chd", "copd", "casthma", "diabetes",
          "cancer", "depression", "stroke", "arthritis"]

# table -> estimate columns we keep
TABLES = {
    "b01003": [1],                      # total population
    "b19013": [1],                      # median household income
    "b25077": [1],                      # median home value
    "b25064": [1],                      # median gross rent
    "b01002": [1],                      # median age
    "b19083": [1],                      # gini index
    "b17001": [1, 2],                   # poverty universe, below poverty
    "b03002": [1, 3, 4, 5, 6, 9, 12],   # race / hispanic origin
    "b15003": [1, 22, 23, 24, 25],      # educational attainment 25+
    "b25003": [1, 2],                   # tenure (owner occupied)
    "b23025": [3, 5],                   # civilian labor force, unemployed
    "b05002": [1, 13],                  # foreign born
    "c17002": [1, 2, 3],                # ratio of income to poverty (block-group poverty)
}
# tables published for block groups (the rest are tract-only and inherited)
BG_TABLES = {"b01003", "b19013", "b25077", "b25064", "b01002", "b03002", "b15003", "b25003", "b23025", "c17002"}

TRACT = "1400000US"
PLACE = "1600000US"
BG = "1500000US"


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    print("  downloading", url)
    tmp = dest + ".part"
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)
    return dest


def read_acs(year, table, cols, prefixes):
    path = fetch(ACS_URL.format(y=year, t=table), os.path.join(CACHE, f"{year}-{table}.dat"))
    out = {}
    with open(path, encoding="latin-1") as f:
        header = f.readline().rstrip("\n").split("|")
        idx = [header.index(f"{table.upper()}_E{c:03d}") for c in cols]
        for line in f:
            if not line.startswith(prefixes):
                continue
            parts = line.rstrip("\n").split("|")
            vals = []
            for i in idx:
                try:
                    v = float(parts[i])
                except ValueError:
                    v = None
                # ACS uses large negative sentinels for missing / suppressed values
                if v is not None and v < -1000:
                    v = None
                vals.append(v)
            out[parts[0]] = vals
    return out


def read_gazetteer(year, kind):
    path = fetch(GAZ_URL.format(y=year, k=kind), os.path.join(CACHE, f"{year}-gaz-{kind}.zip"))
    with zipfile.ZipFile(path) as z:
        name = [n for n in z.namelist() if n.endswith(".txt")][0]
        raw = z.read(name)
    # recent Gazetteer files are UTF-8 (Cañon City, Española); older ones were Latin-1
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    rows = csv.reader(io.StringIO(text), delimiter="\t")
    header = [h.strip() for h in next(rows)]
    return [dict(zip(header, [c.strip() for c in r])) for r in rows]


def read_dbf(data, wanted):
    """Minimal dBase III reader: returns rows of the wanted fields as strings."""
    import struct
    n, hlen, rlen = struct.unpack("<IHH", data[4:12])
    fields, off = [], 32
    while data[off] != 0x0D:
        name = data[off:off + 11].split(b"\x00")[0].decode()
        fields.append((name, data[off + 16]))
        off += 32
    pos, idx = 1, {}
    for name, ln in fields:
        idx[name] = (pos, ln)
        pos += ln
    out = []
    for i in range(n):
        rec = data[hlen + i * rlen: hlen + (i + 1) * rlen]
        out.append({w: rec[idx[w][0]: idx[w][0] + idx[w][1]].decode("latin-1").strip() for w in wanted})
    return out


def read_bg_geography(year):
    path = fetch(CB_BG_URL.format(y=year), os.path.join(CACHE, f"{year}-cb-bg.zip"))
    with zipfile.ZipFile(path) as z:
        name = [n for n in z.namelist() if n.endswith(".dbf")][0]
        rows = read_dbf(z.read(name), ["GEOID", "ALAND"])
    area = {r["GEOID"]: int(r["ALAND"]) / 2589988.11 for r in rows}  # m^2 -> sq mi
    path = fetch(CENPOP_BG_URL, os.path.join(CACHE, "cenpop2020-bg.txt"))
    pts = {}
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            geoid = r["STATEFP"] + r["COUNTYFP"] + r["TRACTCE"] + r["BLKGRPCE"]
            pts[geoid] = (float(r["LONGITUDE"]), float(r["LATITUDE"]))
    return area, pts


def read_places():
    """Crude prevalence (% of adults) per tract."""
    path = fetch(PLACES_URL, os.path.join(CACHE, "places-2025-tract.csv"))
    out = {}
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            r = {k.strip().lower(): v for k, v in r.items()}
            out[r["tractfips"].zfill(11)] = {
                m: (float(r[f"{m}_crudeprev"]) if r.get(f"{m}_crudeprev") not in (None, "") else None) for m in HEALTH}
    return out


def chronic_index(places):
    """PolicyMap-style chronic conditions index: per condition, 0 = bottom quartile,
    1 = middle, 2 = top quartile (national tract percentiles); summed over the 11 conditions (0-22)."""
    cuts = {}
    for m in HEALTH:
        vals = sorted(r[m] for r in places.values() if r[m] is not None)
        cuts[m] = (vals[len(vals) // 4], vals[(3 * len(vals)) // 4])
    out = {}
    for tid, r in places.items():
        if any(r[m] is None for m in HEALTH):
            out[tid] = None
            continue
        out[tid] = sum(0 if r[m] <= cuts[m][0] else 2 if r[m] >= cuts[m][1] else 1 for m in HEALTH)
    return out


def build_covid():
    """Weekly (Sunday) cumulative cases and deaths per county, plus 2020 population."""
    import datetime as dt
    remap = {"New York City": ["36005", "36047", "36061", "36081", "36085"],
             "Kansas City": ["29095"], "Joplin": ["29097"]}
    ak_merge = {"02063": "02261", "02066": "02261"}  # 2019 Valdez-Cordova split; boundaries predate it
    series = {}  # fips -> {date: (cases, deaths)}
    last = None
    for year in (2020, 2021, 2022, 2023):
        path = fetch(NYT_URL.format(y=year), os.path.join(CACHE, f"nyt-us-counties-{year}.csv"))
        with open(path, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                fips = r["fips"]
                targets = [ak_merge.get(fips, fips)] if fips else remap.get(r["county"], [])
                cases = int(float(r["cases"] or 0)); deaths = int(float(r["deaths"] or 0))
                for t in targets:
                    d = series.setdefault(t, {})
                    # sources that share a target (Kansas City + Jackson County, the Alaska split) add up
                    c0, d0 = d.get(r["date"], (0, 0))
                    d[r["date"]] = (c0 + cases, d0 + deaths)
                last = max(last or r["date"], r["date"])
    start = dt.date(2020, 1, 26)
    end = dt.date.fromisoformat(last)
    dates = []
    d = start
    while d <= end:
        dates.append(d.isoformat()); d += dt.timedelta(days=7)
    if dates[-1] != last:
        dates.append(last)

    path = fetch(COUNTY_POP_2020_URL, os.path.join(CACHE, "co-est2020-alldata.csv"))
    pop = {}
    with open(path, encoding="latin-1") as f:
        for r in csv.DictReader(f):
            if r["SUMLEV"] == "050":
                fips = ak_merge.get(r["STATE"] + r["COUNTY"], r["STATE"] + r["COUNTY"])
                pop[fips] = pop.get(fips, 0) + int(r["POPESTIMATE2020"])
    nyc = ["36005", "36047", "36061", "36081", "36085"]
    nyc_pop = sum(pop.get(c, 0) for c in nyc)

    fips_list, pops, cases_out, deaths_out = [], [], [], []
    for fips in sorted(series):
        if fips not in pop:
            continue
        d = series[fips]
        known = sorted(d)
        cs, ds, k, cur = [], [], 0, (0, 0)
        for date in dates:
            while k < len(known) and known[k] <= date:
                cur = d[known[k]]; k += 1
            cs.append(cur[0]); ds.append(cur[1])
        fips_list.append(fips)
        # NYC is reported as one unit: give each borough the city total and city population (same rate)
        pops.append(nyc_pop if fips in nyc else pop[fips])
        cases_out.append(cs); deaths_out.append(ds)
    os.makedirs(os.path.join(OUT, "timeline"), exist_ok=True)
    with open(os.path.join(OUT, "timeline", "covid.json"), "w") as f:
        json.dump({"source": "The New York Times, COVID-19 data (github.com/nytimes/covid-19-data)",
                   "dates": dates, "fips": fips_list, "pop": pops, "cases": cases_out, "deaths": deaths_out},
                  f, separators=(",", ":"))
    print(f"timeline/covid.json: {len(fips_list)} counties x {len(dates)} weeks")
    register_timeline("covid.json")


def register_timeline(name):
    """Record a built timeline in data/timeline/index.json so the app can offer it."""
    path = os.path.join(OUT, "timeline", "index.json")
    files = json.load(open(path))["files"] if os.path.exists(path) else []
    if name not in files:
        files.append(name)
    with open(path, "w") as f:
        json.dump({"files": sorted(files)}, f)


def pct(num, den):
    if num is None or not den:
        return None
    return round(100.0 * num / den, 1)


def rnd(v, d=0):
    if v is None:
        return None
    return round(v, d) if d else int(round(v))


PLACE_SUFFIXES = [
    " city and borough", " consolidated government (balance)", " metropolitan government (balance)",
    " unified government (balance)", " metro government (balance)", " (balance)", " city", " town",
    " village", " borough", " CDP", " municipality", " urban county", " comunidad", " zona urbana",
    " plantation", " corporation",
]


def clean_place(name):
    n = name
    changed = True
    while changed:
        changed = False
        for s in PLACE_SUFFIXES:
            if n.endswith(s):
                n = n[: -len(s)]
                changed = True
    # "Nashville-Davidson metropolitan government" style names
    for sep in ["-Davidson", "-Jefferson County", "-Fayette", "-Richmond County", "-Clarke County",
                "-Muscogee", "-Bibb County", "-Cusseta-Chattahoochee County", "-Wyandotte County"]:
        n = n.replace(sep, "")
    n = n.split("/")[0]
    if n.startswith("Urban "):
        n = n[6:]
    return n.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2024")
    ap.add_argument("--min-place-pop", type=int, default=1000)
    ap.add_argument("--covid-only", action="store_true", help="only rebuild data/timeline/covid.json")
    args = ap.parse_args()
    if args.covid_only:
        os.makedirs(CACHE, exist_ok=True)
        return build_covid()
    y = args.year
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)

    print("ACS tables")
    acs = {}
    for t, cols in TABLES.items():
        prefixes = (TRACT,) + ((BG,) if t in BG_TABLES else ()) + ((PLACE,) if t == "b01003" else ())
        acs[t] = read_acs(y, t, cols, prefixes)
        print(f"  {t}: {len(acs[t])} rows")

    print("Gazetteer")
    tracts_gaz = read_gazetteer(y, "tracts")
    places_gaz = read_gazetteer(y, "place")

    fields = [
        "county", "lon", "lat", "area", "pop",
        "income", "homeValue", "rent", "medianAge", "gini",
        "poverty", "white", "black", "hispanic", "asian", "native", "multi",
        "bachelors", "owner", "unemployment", "foreignBorn",
        *HEALTH, "chronicIndex",
    ]
    cols = {f: [] for f in fields}

    print("CDC PLACES")
    places_health = read_places()
    chronic = chronic_index(places_health)
    print(f"  {len(places_health)} tracts")

    def health(tract_geoid):
        h = places_health.get(tract_geoid) or {}
        return {**{m: h.get(m) for m in HEALTH}, "chronicIndex": chronic.get(tract_geoid)}

    def get(t, gid, i=0):
        r = acs[t].get(gid)
        return None if r is None else r[i]

    def metrics(gid, tract_row=None):
        r = acs["b03002"].get(gid) or [None] * 7
        e = acs["b15003"].get(gid) or [None] * 5
        bach = None if e[0] is None else sum(v or 0 for v in e[1:])
        if tract_row is None:
            poverty = pct(get("b17001", gid, 1), get("b17001", gid, 0))
            gini = rnd(get("b19083", gid), 3)
            foreign = pct(get("b05002", gid, 1), get("b05002", gid, 0))
        else:
            p = acs["c17002"].get(gid)
            poverty = None if p is None or p[1] is None else pct(p[1] + (p[2] or 0), p[0])
            gini, foreign = tract_row["gini"], tract_row["foreignBorn"]
        return {
            "income": rnd(get("b19013", gid)),
            "homeValue": rnd(get("b25077", gid)),
            "rent": rnd(get("b25064", gid)),
            "medianAge": rnd(get("b01002", gid), 1),
            "gini": gini,
            "poverty": poverty,
            "white": pct(r[1], r[0]),
            "black": pct(r[2], r[0]),
            "native": pct(r[3], r[0]),
            "asian": pct(r[4], r[0]),
            "multi": pct(r[5], r[0]),
            "hispanic": pct(r[6], r[0]),
            "bachelors": pct(bach, e[0]),
            "owner": pct(get("b25003", gid, 1), get("b25003", gid, 0)),
            "unemployment": pct(get("b23025", gid, 1), get("b23025", gid, 0)),
            "foreignBorn": foreign,
        }

    tract_rows = {}
    for g in tracts_gaz:
        geoid = g["GEOID"]
        gid = TRACT + geoid
        pop = get("b01003", gid)
        if pop is None:
            continue
        row = {
            "county": int(geoid[:5]),
            "lon": round(float(g["INTPTLONG"]), 4),
            "lat": round(float(g["INTPTLAT"]), 4),
            "area": round(float(g["ALAND_SQMI"]), 3),
            "pop": rnd(pop),
            **metrics(gid),
            **health(geoid),
        }
        tract_rows[geoid] = row
        for f in fields:
            cols[f].append(row[f])

    n = len(cols["pop"])
    with open(os.path.join(OUT, "tracts.json"), "w") as f:
        json.dump({"year": int(y), "count": n, "columns": cols}, f, separators=(",", ":"))
    print(f"tracts.json: {n} tracts")

    print("Block groups")
    bg_area, bg_pts = read_bg_geography(y)
    bg_fields = [f for f in fields if f != "county"]
    by_state = {}
    for gid, vals in acs["b01003"].items():
        if not gid.startswith(BG):
            continue
        geoid = gid[len(BG):]
        st = geoid[:2]
        if st in ("09", "72") or geoid not in bg_pts or geoid not in bg_area:
            continue
        tract = tract_rows.get(geoid[:11])
        if tract is None:
            continue
        lon, lat = bg_pts[geoid]
        row = {"lon": round(lon, 5), "lat": round(lat, 5), "area": round(bg_area[geoid], 4),
               "pop": rnd(vals[0]), **metrics(gid, tract), **{k: tract[k] for k in [*HEALTH, "chronicIndex"]}}
        cols_s = by_state.setdefault(st, {f: [] for f in bg_fields})
        for f in bg_fields:
            cols_s[f].append(row[f])
    os.makedirs(os.path.join(OUT, "bg"), exist_ok=True)
    total = 0
    for st, c in sorted(by_state.items()):
        with open(os.path.join(OUT, "bg", f"{st}.json"), "w") as f:
            json.dump({"count": len(c["pop"]), "columns": c}, f, separators=(",", ":"))
        total += len(c["pop"])
    print(f"bg/*.json: {total} block groups in {len(by_state)} states")

    places = []
    for g in places_gaz:
        pop = get("b01003", PLACE + g["GEOID"])
        if pop is None or pop < args.min_place_pop:
            continue
        places.append([
            clean_place(g["NAME"]), g["USPS"],
            round(float(g["INTPTLONG"]), 4), round(float(g["INTPTLAT"]), 4), int(pop),
        ])
    places.sort(key=lambda p: -p[4])
    with open(os.path.join(OUT, "places.json"), "w", encoding="utf-8") as f:
        json.dump({"fields": ["name", "state", "lon", "lat", "pop"], "rows": places}, f,
                  separators=(",", ":"), ensure_ascii=False)
    print(f"places.json: {len(places)} places")

    build_covid()


if __name__ == "__main__":
    sys.exit(main())
