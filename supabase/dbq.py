#!/usr/bin/env python3
"""Run SQL against the live Supabase project from the command line.

    python3 dbq.py "select count(*) from houses;"
    python3 dbq.py -f schema.sql

Reads a Supabase personal access token from ~/.supabase_token. No secret
lives in this repository.
"""
import json, os, sys, urllib.request, urllib.error

REF = 'jfedobsozembqfhjmubj'
TOKEN_FILE = os.path.expanduser('~/.supabase_token')


def run(sql, label=''):
    if not os.path.exists(TOKEN_FILE):
        sys.exit("No token. Create one at "
                 "https://supabase.com/dashboard/account/tokens then:\n"
                 "  printf '%s' 'sbp_...' > ~/.supabase_token && chmod 600 ~/.supabase_token")
    token = open(TOKEN_FILE).read().strip()
    req = urllib.request.Request(
        'https://api.supabase.com/v1/projects/%s/database/query' % REF,
        data=json.dumps({'query': sql}).encode(),
        headers={'Authorization': 'Bearer ' + token,
                 'Content-Type': 'application/json',
                 # Cloudflare in front of the API rejects the default
                 # Python-urllib agent with a 1010, which looks like an auth
                 # failure until you notice curl works.
                 'User-Agent': 'curl/8.5.0',
                 'Accept': 'application/json'},
        method='POST')
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            out = json.loads(r.read().decode() or '[]')
            if label:
                print("OK   %s" % label)
            return out
    except urllib.error.HTTPError as e:
        print("FAIL %s -> HTTP %s\n%s" % (label, e.code, e.read().decode()[:800]))
        return None


def table(rows):
    if not rows:
        print("(no rows)"); return
    cols = list(rows[0].keys())
    w = {c: max(len(c), *(len(str(r.get(c, ''))) for r in rows)) for c in cols}
    print("  " + "  ".join(c.ljust(w[c]) for c in cols))
    print("  " + "  ".join("-" * w[c] for c in cols))
    for r in rows:
        print("  " + "  ".join(str(r.get(c, '')).ljust(w[c]) for c in cols))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    if sys.argv[1] == '-f':
        res = run(open(sys.argv[2]).read(), sys.argv[2])
    else:
        res = run(sys.argv[1])
    if isinstance(res, list):
        table(res)
