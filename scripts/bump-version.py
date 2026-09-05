#!/usr/bin/env python3
"""Bump the visible asset marker everywhere at once.

Usage:
    scripts/bump-version.py          # next version (11 -> 12)
    scripts/bump-version.py 12       # set explicitly
    scripts/bump-version.py --check  # verify agreement, change nothing
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
ABOUT = ROOT / "about.html"
APP = ROOT / "app.js"

SPOTS = {
    "index ?v=": (INDEX, r"\?v=(\d+)", "?v={n}"),
    "index badge": (INDEX, r'(id="buildBadge"[^>]*>)(\d+)', r"\g<1>{n}"),
    "about ?v=": (ABOUT, r"\?v=(\d+)", "?v={n}"),
    "app meaning ?v=": (APP, r'(meaning\.js\?v=)(\d+)', r"\g<1>{n}"),
}


def read(p):
    return p.read_text(encoding="utf-8")


def found(text, pattern):
    return [m.group(m.lastindex) for m in re.finditer(pattern, text)]


def survey():
    cache = {}
    result = {}
    for name, (path, pattern, _) in SPOTS.items():
        if path not in cache:
            cache[path] = read(path)
        result[name] = found(cache[path], pattern)
    return result, cache


def report(survey_result):
    all_versions = set()
    problems = []
    for name, hits in survey_result.items():
        if not hits:
            problems.append("%s: no match found" % name)
            print("  %-18s MISSING" % name)
            continue
        uniq = sorted(set(hits), key=int)
        all_versions.update(uniq)
        flag = "" if len(uniq) == 1 else "  <-- inconsistent"
        print(
            "  %-18s v%s (%d spot%s)%s"
            % (name, ",v".join(uniq), len(hits), "" if len(hits) == 1 else "s", flag)
        )
        if len(uniq) > 1:
            problems.append("%s disagrees with itself: %s" % (name, uniq))
    if len(all_versions) > 1:
        problems.append("files disagree: found %s" % sorted(all_versions, key=int))
    return all_versions, problems


def apply(n, cache):
    written = {}
    for name, (path, pattern, repl) in SPOTS.items():
        text = written.get(path, cache[path])
        repl_s = repl.replace("{n}", str(n))
        text, count = re.subn(pattern, repl_s, text)
        if count == 0:
            raise SystemExit("no replacements for %s" % name)
        written[path] = text
    for path, text in written.items():
        path.write_text(text, encoding="utf-8")


def main():
    args = [a for a in sys.argv[1:] if a]
    check_only = "--check" in args
    explicit = next((a for a in args if a.isdigit()), None)

    print("current:")
    result, cache = survey()
    versions, problems = report(result)
    if problems:
        print("check failed:")
        for p in problems:
            print("  %s" % p)
        if check_only:
            sys.exit(1)

    if check_only:
        print("ok")
        return

    if explicit is not None:
        n = int(explicit)
    else:
        n = (max(int(v) for v in versions) + 1) if versions else 1

    print("bump to v%d" % n)
    apply(n, cache)
    print("after:")
    result, _ = survey()
    versions, problems = report(result)
    if problems:
        print("check failed after bump:")
        for p in problems:
            print("  %s" % p)
        sys.exit(1)
    print("ok")


if __name__ == "__main__":
    main()
