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

def fetch_sheet(sheet_id, gid):
    url = f'https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60, context=SSL_CTX) as r:
        return r.read().decode('utf-8')

def csv_to_json(text):
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        return []
    # Find densest row in first 10 — handles sheets with multi-row title blocks
    hi = max(range(min(10, len(rows))), key=lambda i: sum(1 for c in rows[i] if c.strip()))
    headers = [h.strip() for h in rows[hi]]
    result = []
    for row in rows[hi + 1:]:
        obj = {}
        for i, h in enumerate(headers):
            if h:
                obj[h] = row[i].strip() if i < len(row) else ''
        if any(v for v in obj.values()):
            result.append(obj)
    return result

errors = []
for key, (sid, gid) in SHEETS.items():
    try:
        print(f'Fetching {key}...', flush=True)
        text = fetch_sheet(sid, gid)
        rows = csv_to_json(text)
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
