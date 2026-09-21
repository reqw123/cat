#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 card-fx（稀有度切換／技能演出／卡背資訊／音效）注入卡片 html。可重複執行：
已注入的區塊（<!--CARD-FX:BEGIN--> … <!--CARD-FX:END-->）會被整段換成最新版。

用法：
  python apply_fx.py                 # 處理 ../cards/*.html 與 ../cards/dog_cards/*.html
  python apply_fx.py path\\a.html ... # 只處理指定檔案
  python apply_fx.py --check         # 只檢查哪些卡片缺區塊或版本不同，不寫檔

每張卡的資料（編號、收藏日期、四項數值、顏色…）放在 cards_meta.json，第一次見到的卡片會自動
建立一筆（顏色、名稱、屬性、稀有度從卡片 html 解析；編號依序遞增；日期取檔案建立日；
數值由名稱雜湊出一組穩定的數字）。之後想改數值／日期，直接改 cards_meta.json 再重新執行。
"""
import glob
import hashlib
import json
import os
import re
import sys
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS_DIR = os.path.abspath(os.path.join(HERE, "..", "cards"))
META_FILE = os.environ.get("CARD_FX_META") or os.path.join(HERE, "cards_meta.json")   # 環境變數只給測試用
BEGIN, END = "<!--CARD-FX:BEGIN-->", "<!--CARD-FX:END-->"
BLOCK_RE = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\r?\n?", re.S)

# 既有卡片的固定編號（依做出來的先後）；之後新增的卡片接在後面
INITIAL_ORDER = [
    "jimmy_phantom_card.html", "gojo_phantom_card.html", "gojo_hollow_purple_card.html",
    "wangcai_phantom_card.html", "yinglang_phantom_card.html", "feilong_phantom_card.html",
    "zhuaige_phantom_card.html", "jifeng_phantom_card.html", "wuming_phantom_card.html",
    "營區陽光男孩-幻影卡.html",
]
# 沒有 --c1/--c2/--c3 的老卡片（jimmy 型架構）用主題色，見 fx.css 的 --fx-c1..3
FALLBACK_COLORS = {
    "jimmy_phantom_card.html": ["#10b981", "#06b6d4", "#dcfff6"],
    "gojo_phantom_card.html": ["#a855f7", "#38bdf8", "#e6f6ff"],
    "gojo_hollow_purple_card.html": ["#b15cff", "#ff3ba7", "#ffe3f4"],
    "營區陽光男孩-幻影卡.html": ["#ffb43a", "#5ac8f5", "#fff1d6"],
}
STAT_KEYS = ["ATK", "DEF", "SPD", "LUK"]


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()


def load_meta():
    try:
        with open(META_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_meta(meta):
    with open(META_FILE, "w", encoding="utf-8", newline="\n") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


def stable_stats(name):
    h = hashlib.md5(name.encode("utf-8")).digest()
    return {k: 55 + h[i] % 43 for i, k in enumerate(STAT_KEYS)}


def file_date(path):
    try:
        st = os.stat(path)
        ts = getattr(st, "st_birthtime", None) or st.st_ctime
        return datetime.date.fromtimestamp(ts).isoformat()
    except OSError:
        return datetime.date.today().isoformat()


def mix_white(hexcolor, amt):
    h = hexcolor.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    f = lambda v: round(v + (255 - v) * amt)
    return "#%02x%02x%02x" % (f(r), f(g), f(b))


def parse_card(html, filename):
    """從卡片 html 解析顯示用資訊。"""
    def first(rx, default=""):
        m = re.search(rx, html, re.S)
        return strip_tags(m.group(1)) if m else default

    name = first(r'<h1 class="name">(.*?)</h1>') or os.path.splitext(filename)[0]
    element = first(r'<span class="chip chip--(?!ssr)[a-z]+">(.*?)</span>')
    rarity = first(r'<span class="chip chip--ssr">(.*?)</span>', "SSR").upper()
    skill = first(r'<p class="skill__name">(.*?)(?:<span|</p>)')
    skill = skill.replace("✦", "").strip()
    cols = []
    for k in ("c1", "c2", "c3"):
        m = re.search(r"--%s:\s*(#[0-9a-fA-F]{3,8})" % k, html)
        cols.append(m.group(1) if m else None)
    fb = FALLBACK_COLORS.get(filename)
    if fb:
        cols = [c or fb[i] for i, c in enumerate(cols)]
    if not cols[0]:
        cols[0] = "#8be9fd"
    if not cols[1]:
        cols[1] = "#bd93f9"
    if not cols[2]:
        cols[2] = mix_white(cols[1], 0.6)
    return dict(name=name, element=element, rarity=rarity if rarity in ("SR", "SSR", "UR", "LR") else "SSR",
                skillName=skill, colors=cols)


def ensure_entry(meta, filename, path, name_hint=None):
    """cards_meta.json 裡沒有這張卡就建一筆；回傳（可能是新建的）那筆。"""
    e = meta.get(filename)
    if e is None:
        used = [int(v.get("no", 0)) for v in meta.values() if str(v.get("no", "")).isdigit()]
        if filename in INITIAL_ORDER:
            no = INITIAL_ORDER.index(filename) + 1
        else:
            no = max([len(INITIAL_ORDER)] + used) + 1
        e = {"no": "%03d" % no, "date": file_date(path), "stats": stable_stats(filename + "|" + (name_hint or ""))}
        meta[filename] = e
    return e


def build_meta(html, filename, path, meta):
    parsed = parse_card(html, filename)
    e = ensure_entry(meta, filename, path, parsed["name"])
    out = dict(parsed)
    out.update(id=os.path.splitext(filename)[0], no=e["no"], date=e["date"], stats=e["stats"])
    if e.get("rarity") in ("SR", "SSR", "UR", "LR"):     # 手動指定的預設稀有度優先
        out["rarity"] = e["rarity"]
    return out


def read_text(path):
    with open(path, "rb") as f:
        raw = f.read().decode("utf-8")
    return raw, ("\r\n" if "\r\n" in raw else "\n")


def block_text(meta_obj):
    with open(os.path.join(HERE, "fx.css"), "r", encoding="utf-8") as f:
        css = f.read().replace("\r\n", "\n")
    with open(os.path.join(HERE, "fx.js"), "r", encoding="utf-8") as f:
        js = f.read().replace("\r\n", "\n")
    if "</script" in js.lower():
        raise ValueError("fx.js 不能出現 </script")
    meta_json = json.dumps(meta_obj, ensure_ascii=False).replace("</", "<\\/")
    return (BEGIN + "\n<script type=\"application/json\" id=\"card-meta\">" + meta_json + "</script>\n"
            "<style id=\"card-fx-css\">\n" + css + "</style>\n"
            "<script id=\"card-fx-js\">\n" + js + "</script>\n" + END + "\n")


def inject(html, meta_obj):
    """回傳注入（或更新）過區塊的 html 文字（行尾沿用原檔）。"""
    eol = "\r\n" if "\r\n" in html else "\n"
    text = html.replace("\r\n", "\n")
    text = BLOCK_RE.sub("", text)
    block = block_text(meta_obj)
    i = text.lower().rfind("</body>")
    text = (text[:i] + block + text[i:]) if i >= 0 else (text + "\n" + block)
    return text.replace("\n", eol) if eol == "\r\n" else text


def process(path, meta, check=False):
    filename = os.path.basename(path)
    html, _eol = read_text(path)
    meta_obj = build_meta(html, filename, path, meta)
    new = inject(html, meta_obj)
    changed = new != html
    if changed and not check:
        with open(path, "wb") as f:
            f.write(new.encode("utf-8"))
    return changed, meta_obj


def main(argv):
    # 主控台是 cp950（繁中 Windows 預設）時，print 卡名裡的字（例如「五条」的「条」）會丟 UnicodeEncodeError；
    # 以前 print 寫在下面的 try 裡，這個「只是印不出來」的錯誤被當成處理失敗 → sys.exit(1)，整批在那張卡中止
    # （後面的卡片沒處理、cards_meta.json 也沒存）。所以：輸出改用 UTF-8（印不出來的字元用替代符，永不丟例外），
    # 而且 print 移出 try。只在直接執行時才動 stdout（被 make_card.py 匯入時不會經過 main()）。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001  （stream 不支援 reconfigure 就維持原樣）
            pass
    check = "--check" in argv
    paths = [a for a in argv if not a.startswith("--")]
    if not paths:
        paths = sorted(glob.glob(os.path.join(CARDS_DIR, "*.html")) + glob.glob(os.path.join(CARDS_DIR, "dog_cards", "*.html")))
    meta = load_meta()
    for p in paths:
        try:
            changed, m = process(p, meta, check)
        except Exception as e:  # noqa: BLE001
            print("失敗 %s：%s" % (p, e))
            sys.exit(1)
        print(("需要更新 " if check else "已注入 ") + os.path.relpath(p, os.path.dirname(HERE)) if changed
              else "已是最新 " + os.path.relpath(p, os.path.dirname(HERE)), "| NO.%s %s %s" % (m["no"], m["name"], m["rarity"]))
    if not check:
        save_meta(meta)


if __name__ == "__main__":
    main(sys.argv[1:])
