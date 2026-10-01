"""Reads the newest YouTube Music history item. JSON in on stdin, JSON out on stdout.
In:  {"raw": "<headers copied from browser>"}  or  {"auth": "<ytmusicapi auth json>"}
Out: {"ok": true, "auth": "<auth json, only for raw>", "item": {...} | null}  or  {"ok": false, "error": "..."}
"""
import sys, json
from ytmusicapi import YTMusic, setup


def main():
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
    except Exception as e:  # never leak headers in errors
        print(json.dumps({"ok": False, "error": type(e).__name__ + ": " + str(e)[:150]}))


main()
