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

if errors:
    print('\nFailed:', '\n'.join(errors), file=sys.stderr)
    sys.exit(1)
print('Done.')
