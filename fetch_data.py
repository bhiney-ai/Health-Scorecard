import csv, json, io, urllib.request, urllib.error, ssl, sys
SSL_CTX = ssl.create_default_context()
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX.check_hostname = False
    SSL_CTX.verify_mode = ssl.CERT_NONE

SHEETS = {
    'oh':      ('1D4WMx0zvSlVH2ROdqJb8di0bQYoxPJvizMkSL8HLufQ', '222471179'),
    'abc':     ('1_FIMGtcHlIG36ybWGsWtWUG9-ATxkUFzwBlZy1Of3i8', '1341808860'),
    'xyz':     ('1BSbgPqVX8YI_X0E45fA8_-4pL_0YNMctbUPxmsCcon4', '144111924'),
    'custSku': ('1DlVvTpy1z1Gdv6VATAQtbeP0aUQK-EH0z1GRLfpks80', '514486211'),
    'custMkt': ('1M4MGluu2hvG_0HDB4KO-QoGwkQy9_FOKyPV00CVO6dY', '1862358378'),
    'margin':  ('12QS8Kva_512I_oDS-gNle7dCpgCJzntiOIcpOttWaOo', '0'),
    'ledger':  ('13Yp1zREpOFCAkEIajli5lgWdwZAZLsi7e25yod6X_tc', '1033018785'),
    'proc':    ('1sPEc5rBdRB9qaJijBh4z8DK4ZVo--5xmTGbPTZ5n2nQ', '1794766977'),
    'daysAct': ('1dPHBFHQt_nZG3c-SLCinqbuGPCSVTwiz01hiwadvuKo', '0'),
}

# Only keep columns the dashboard actually uses.
# None → keep all columns.
KEEP_COLS = {
    'oh':      None,  # already lean
    'abc':     {'Netsuite Items Item ID', 'Warehouse (Picked) Warehouse Name',
                'Ordered Items Catalog Brand', 'Ordered Items Item Name',
                'Picked Items Category', 'Picked Items Sub-Category',
                'Orders Deliveries and Invoices Invoiced Amount',
                'inventory_classification'},
    'xyz':     {'Netsuite Items Item ID', 'Warehouse (Picked) Warehouse Name',
                'Picked Items Category', 'Ordered Items Item Name',
                'Ordered Items Catalog Brand',
                'xyz_classification', 'coefficient_of_variation',
                'recent_3_months_units', 'prior_9_months_units',
                'Orders Deliveries and Invoices Invoiced Sales Units'},
    'custSku': None,
    'custMkt': None,
    'margin':  None,
    'ledger':  {'Internal ID', 'Item', 'Location',
                'Beginning Inv On-hand Value', 'Ending Inv On-hand Value',
                'Value of Outputs'},
    'proc':    {'warehouse_name', 'item_id', 'in_catalog'},
    'daysAct': {'Item ID', 'Warehouse Name', 'days Active'},
}

# ── Network Sales Tracker: transaction-level item × customer detail ──────────
# Feeds the Score Engine customer drill-down. One Google Sheet per warehouse.
# NOTE: these must be shared "Anyone with the link can view" like the sheets
# above, or the fetch returns HTTP 401 and the warehouse is skipped (previous
# data is preserved rather than wiped).
TRACKERS = {
    'ATL1': '1uxqrorc7fdiFhXWqTo0s-2cgkuUA4Hji5yqLDYP_c_w',
    'AUS1': '124F1Y83vjPTPtfIHTtpt7DeWMqKfm5LhZFMiIPL1mc8',
    'BLI1': '1rfRGyGeQUN_Jac2KsOcEqnCDBvy6WyBMktvKyYIWoQc',
    'CLT1': '1Lblp0sNAJnBuzX1lk0dQQTHlMpi8yRw49MkC-wuqdbo',
    'DEN1': '1LnAxaMw6xXMBZi3E5Q1IjY1hzB5t7TrxAJZeLVYKwsA',
    'DFW1': '18vMFry_IIPv5ni3aLmCd7kMGz7wCaLyEduRh-hhzu6o',
    'EWR1': '1OsbP18hzmXov7QKesn1-toJnR833HKXpNWh1it3Hhcw',
    'HOU1': '1Co3X13WW3AznohX1WMyYqfrScxIlYsVOXNDA8DfWi_8',
    'LAX1': '13LL7yEGXjuM-ocXRN32A0e5nbwXyNW2si6Sghh5IddA',
    'MDT1': '1YjMwL3bvowp3TQjq9IEWEO9hSxWIEwt9nUbp1vELsIY',
    'MIA1': '1kcVvBh5jc836Mn6iDWQ59BArHKU5KMjBDp1Kj1lAUrc',
    'PDX1': '1eyYspvPktp11uzstOgiImp-57HFBJViYFh0FLO-SBIg',
    'PWM1': '17QDbX66utwYMhqrzpNyrGtg9oW95TgajzRryhKKJGuY',
    'SEA1': '1pRxu2eNFV-sqGKJG8f7P6eUOoAXXHGTz5qaLzFGduIA',
    'SMF1': '1N4qqAMNbIjXZ150YuoZSlVpf1jUdf6udQawzbX0UA4c',
}

def fetch_sheet(sheet_id, gid):
    url = f'https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
        return r.read().decode('utf-8')

def csv_to_json(text, keep=None):
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        return []
    counts = [sum(1 for c in rows[i] if c.strip()) for i in range(min(10, len(rows)))]
    threshold = max(counts) - 2
    hi = next(i for i, c in enumerate(counts) if c >= threshold)
    headers = [h.strip() for h in rows[hi]]
    result = []
    for row in rows[hi + 1:]:
        obj = {}
        for i, h in enumerate(headers):
            if h and (keep is None or h in keep):
                obj[h] = row[i].strip() if i < len(row) else ''
        if any(v for v in obj.values()):
            result.append(obj)
    return result

def aggregate_tracker(rows, wh):
    """Collapse transaction rows to one record per (item, customer).

    A tracker sheet can carry 40k+ order lines; the drill-down only needs the
    customer roster per item, so aggregating here keeps the published JSON
    small enough to load in the browser.
    """
    agg = {}
    for r in rows:
        item = (r.get('Item Name') or '').strip()
        cust = (r.get('Customer Name') or '').strip()
        if not item or not cust:
            continue
        k = (item.lower(), cust)
        try:
            qty = float((r.get('SO Item Qty') or '0').replace(',', '') or 0)
        except ValueError:
            qty = 0.0
        date = (r.get('Date Date') or '').strip()
        a = agg.get(k)
        if a is None:
            agg[k] = {'w': wh, 'i': item, 'c': cust, 'q': qty, 'n': 1, 'd': date,
                      'e': (r.get('Enterprise') or '').strip().upper() == 'TRUE'}
        else:
            a['q'] += qty
            a['n'] += 1
            if date > a['d']:
                a['d'] = date
    for a in agg.values():
        a['q'] = round(a['q'], 2)
    return list(agg.values())


errors = []
for key, (sid, gid) in SHEETS.items():
    try:
        print(f'Fetching {key}...', flush=True)
        text = fetch_sheet(sid, gid)
        rows = csv_to_json(text, keep=KEEP_COLS[key])
        with open(f'data/{key}.json', 'w') as f:
            json.dump(rows, f, separators=(',', ':'))
        print(f'  → {len(rows)} rows', flush=True)
    except Exception as e:
        print(f'  ERROR: {e}', file=sys.stderr)
        errors.append(f'{key}: {e}')

# ── Network Sales Tracker → custDetail.json ─────────────────────────────────
# A tracker that 401s (not link-shared) is skipped, not fatal: the drill-down
# degrades to "not loaded" for that warehouse and the rest still publish.
detail, skipped = [], []
for wh, sid in TRACKERS.items():
    try:
        print(f'Fetching tracker {wh}...', flush=True)
        rows = csv_to_json(fetch_sheet(sid, '0'))
        recs = aggregate_tracker(rows, wh)
        detail.extend(recs)
        print(f'  → {len(rows)} lines → {len(recs)} item×customer', flush=True)
    except Exception as e:
        code = getattr(e, 'code', None)
        skipped.append(f'{wh} ({"HTTP "+str(code) if code else e})')
        print(f'  SKIP {wh}: {e}', file=sys.stderr)

if detail:
    with open('data/custDetail.json', 'w') as f:
        json.dump(detail, f, separators=(',', ':'))
    print(f'custDetail.json → {len(detail)} rows', flush=True)
elif skipped:
    # Never overwrite good data with nothing; leave the previous file in place.
    print('No tracker data fetched — keeping existing custDetail.json', file=sys.stderr)

if skipped:
    print(f'\nTrackers skipped (share these "Anyone with the link can view"): '
          f'{", ".join(skipped)}', file=sys.stderr)

if errors:
    print('\nFailed:', '\n'.join(errors), file=sys.stderr)
    sys.exit(1)
print('Done.')
