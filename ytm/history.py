"""Reads the newest YouTube Music history item. JSON in on stdin, JSON out on stdout.
In:  {"raw": "<headers copied from browser>"}  or  {"auth": "<ytmusicapi auth json>"}
Out: {"ok": true, "auth": "<auth json, only for raw>", "item": {...} | null}
     {"ok": false, "authError": true/false, "error": "..."}
     authError=true  → credentials are genuinely invalid (HTTP 401/403, forbidden)
     authError=false → transient network / service issue, do not count against auth
"""
import sys, json

def main():
    try:
        import requests
        from ytmusicapi import YTMusic, setup
    except ImportError as e:
        print(json.dumps({"ok": False, "authError": False, "error": "import: " + str(e)[:120]}))
        return

    try:
        req = json.load(sys.stdin)
        raw = req.get("raw")
        auth = setup(filepath=None, headers_raw=raw) if raw else req["auth"]
        hist = YTMusic(auth).get_history()
        item = None
        if hist:
            h = hist[0]
            thumbs = h.get("thumbnails") or []
            item = {
                "videoId": h.get("videoId"),
                "title": h.get("title") or "",
                "artists": ", ".join(a.get("name", "") for a in (h.get("artists") or [])),
                "album": (h.get("album") or {}).get("name", ""),
                "albumArt": thumbs[-1].get("url", "") if thumbs else "",
                "durationSeconds": h.get("duration_seconds") or 0,
                "played": h.get("played") or "",
            }
        out = {"ok": True, "item": item}
        if raw:
            out["auth"] = auth if isinstance(auth, str) else json.dumps(auth)
        print(json.dumps(out))

    except Exception as e:
        msg = str(e)
        # Try to get HTTP status code if available
        status = None
        try:
            import requests as req_lib
            if isinstance(e, req_lib.exceptions.HTTPError):
                status = e.response.status_code if e.response is not None else None
            elif isinstance(e, (req_lib.exceptions.ConnectionError,
                                req_lib.exceptions.Timeout,
                                req_lib.exceptions.ReadTimeout)):
                # Purely network — not an auth failure
                print(json.dumps({"ok": False, "authError": False,
                                  "error": "network: " + type(e).__name__}))
                return
        except Exception:
            pass

        # Decide if it looks like an auth / credential problem
        auth_keywords = ("401", "403", "unauthorized", "forbidden",
                         "invalid cookie", "invalid header", "login", "sign in",
                         "credentials", "authentication")
        is_auth = (
            status in (401, 403)
            or any(kw in msg.lower() for kw in auth_keywords)
        )
        print(json.dumps({
            "ok": False,
            "authError": is_auth,
            "error": type(e).__name__ + ": " + msg[:150],
        }))

main()
