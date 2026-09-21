#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""卡片瘦身：把卡片 html 裡內嵌的 base64 圖片改成 WebP，並把「同一張圖重複內嵌好幾份」收成一份。

為什麼：每張卡有 4 個 <img src="data:...">——場景背景／警戒殘影／沉睡殘影是「同一張 JPEG 重複 3 份」，
主體是一張很大的 PNG（0.2～1.1 MB）。實測 PNG→WebP（quality 95、alpha 無損）體積約 1/5、透明度誤差 0、
PSNR 43～50 dB（肉眼無差）；重複的 3 份收成 1 份再省 2/3。詳見 桌面掛件說明.md〈🪶 卡片瘦身〉。

做了什麼（只動 <img src="data:image/...">，其餘一個字都不改）：
  1. 每張唯一的圖轉成 WebP：帶透明度的（主體）quality=subject_q、alpha 無損；不透明的（場景）quality=scene_q。
     保留 ICC 色彩描述檔、套用 EXIF 方向（跟瀏覽器顯示一致）；轉完反而沒有比較小就保留原圖。
  2. 內容完全相同的 <img> 只留第一份的 base64，其餘的 <img> 把 src 換成 data-slim-from="s1"，
     並在最後一個被改的 <img> 後面插一小段同步的 <script id="card-slim-resolve"> 在首次繪製前把 src 補回去
     （複製的是同一個字串，不會多一份 base64；fx.js 的 cloneNode 也會帶著 src）。
  3. 可重複執行（已經是 WebP／已收成一份的不會再動）。

用法：
  python slim.py                      # 處理 ../cards/*.html（不含子資料夾），原檔先備份到 card-slim/backup/<時間>/
  python slim.py a.html b.html        # 只處理指定檔案
  python slim.py --dry-run            # 只報告會省多少，不寫檔
  python slim.py --out DIR            # 不動原檔，結果寫到 DIR（測試用，不備份）
  python slim.py --scene-q 80 --subject-q 95
"""
import argparse
import base64
import datetime
import glob
import hashlib
import io
import os
import re
import shutil
import sys

from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS_DIR = os.path.abspath(os.path.join(HERE, "..", "cards"))
DATA_URI = re.compile(r'data:image/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)')
IMG_TAG = re.compile(r'<img\b[^>]*?\bsrc="(data:image/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+)"[^>]*>', re.S)
RESOLVE_ID = "card-slim-resolve"
RESOLVER = ('<script id="%s">(function(){var a=document.querySelectorAll(\'img[data-slim-from]\');'
            'for(var i=0;i<a.length;i++){var s=document.querySelector(\'[data-slim-id="\'+a[i].getAttribute(\'data-slim-from\')+\'"]\');'
            'if(s)a[i].src=s.src;}})();</script>') % RESOLVE_ID


def convert_image(raw, scene_q, subject_q):
    """回傳 (webp 位元組, 說明) 或 (None, 原因)。"""
    im = Image.open(io.BytesIO(raw))
    if im.format == "WEBP":
        return None, "already webp"
    icc = im.info.get("icc_profile")
    if im.getexif().get(0x0112, 1) != 1:          # EXIF 方向：瀏覽器會套用，PIL 重新編碼會丟掉 → 先轉正
        im = ImageOps.exif_transpose(im)
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    kw = {"method": 6}
    if icc:
        kw["icc_profile"] = icc
    if has_alpha:
        im = im.convert("RGBA")
        kw.update(quality=subject_q, alpha_quality=100)
    else:
        im = im.convert("RGB")
        kw.update(quality=scene_q)
    buf = io.BytesIO()
    im.save(buf, "WEBP", **kw)
    out = buf.getvalue()
    if len(out) >= len(raw) * 0.95:
        return None, "no gain"
    return out, "alpha q%d" % subject_q if has_alpha else "rgb q%d" % scene_q


def slim_html(text, scene_q=80, subject_q=95, cache=None):
    """回傳 (新的 html 文字, 統計 dict)。"""
    cache = {} if cache is None else cache
    stats = {"converted": 0, "kept": 0, "deduped": 0, "before": len(text.encode("utf-8"))}

    # ---- 1) 逐張轉 WebP（相同內容只轉一次）
    def sub_uri(m):
        key = hashlib.md5(m.group(0).encode("ascii")).hexdigest()
        if key not in cache:
            raw = base64.b64decode(m.group(2))
            out, why = convert_image(raw, scene_q, subject_q)
            cache[key] = ("data:image/webp;base64," + base64.b64encode(out).decode("ascii")) if out else m.group(0)
            cache[key + "#ok"] = out is not None
        stats["converted" if cache[key + "#ok"] else "kept"] += 1
        return cache[key]

    text = DATA_URI.sub(sub_uri, text)

    # ---- 2) 相同 src 的 <img> 收成一份
    tags = list(IMG_TAG.finditer(text))
    groups = {}
    for m in tags:
        groups.setdefault(m.group(1), []).append(m)
    edits = []          # (start, end, replacement)
    n = 0
    last_end = -1
    for uri, ms in groups.items():
        if len(ms) < 2:
            continue
        n += 1
        sid = "s%d" % n
        first = ms[0]
        edits.append((first.start(), first.end(), first.group(0).replace("<img", '<img data-slim-id="%s"' % sid, 1)))
        for m in ms[1:]:
            edits.append((m.start(), m.end(), m.group(0).replace('src="%s"' % uri, 'data-slim-from="%s"' % sid, 1)))
            stats["deduped"] += 1
        last_end = max(last_end, ms[-1].end())
    if edits:
        edits.sort(key=lambda e: e[0], reverse=True)
        for a, b, rep in edits:
            text = text[:a] + rep + text[b:]
        # 插入位置＝最後一個被改的 <img> 之後（往後的字元被前面的改動擠開了，重新找）
        last_from = [m for m in re.finditer(r'<img\b[^>]*data-slim-from="[^"]*"[^>]*>', text)][-1]
        text = text[:last_from.end()] + RESOLVER + text[last_from.end():]
    stats["after"] = len(text.encode("utf-8"))
    return text, stats


def check_html(text):
    """自我檢查：所有 data URI 都能解碼、所有 data-slim-from 都有對應來源、resolver 只有一份且位置正確。回傳問題清單。"""
    problems = []
    for m in DATA_URI.finditer(text):
        try:
            Image.open(io.BytesIO(base64.b64decode(m.group(2)))).load()
        except Exception as e:
            problems.append("圖片解不開：%s" % e)
    r = text.find(RESOLVER)
    body = text.replace(RESOLVER, "")          # resolver 腳本自己也含有這些字樣，比對前先拿掉
    ids = set(re.findall(r'data-slim-id="([^"]+)"', body))
    froms = re.findall(r'data-slim-from="([^"]+)"', body)
    for f in froms:
        if f not in ids:
            problems.append("data-slim-from=%s 找不到來源" % f)
    if froms:
        if r < 0 or text.count('id="%s"' % RESOLVE_ID) != 1:
            problems.append("resolver 腳本不是剛好一份")
        else:
            after = text[r + len(RESOLVER):]   # resolver 之後不能再出現任何要被解析的 <img>
            if 'data-slim-from="' in after or 'data-slim-id="' in after:
                problems.append("resolver 腳本位置太前面")
    elif r >= 0:
        problems.append("有 resolver 腳本卻沒有任何 data-slim-from")
    return problems


def main():
    ap = argparse.ArgumentParser(description="卡片瘦身：內嵌圖片轉 WebP＋重複圖收成一份")
    ap.add_argument("files", nargs="*")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--no-backup", action="store_true")
    ap.add_argument("--scene-q", type=int, default=80)
    ap.add_argument("--subject-q", type=int, default=95)
    a = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    files = a.files or sorted(glob.glob(os.path.join(CARDS_DIR, "*.html")))
    if not files:
        print("沒有要處理的檔案")
        return 0
    backup = None
    if not a.dry_run and not a.out and not a.no_backup:
        backup = os.path.join(HERE, "backup", datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    cache = {}
    tot_b = tot_a = 0
    bad = 0
    for f in files:
        with open(f, "r", encoding="utf-8", newline="") as fh:
            text = fh.read()
        new, st = slim_html(text, a.scene_q, a.subject_q, cache)
        probs = check_html(new)
        tot_b += st["before"]
        tot_a += st["after"]
        state = "無變動" if new == text else "%d 張轉 WebP、%d 份重複收掉" % (st["converted"], st["deduped"])
        print("%-46s %9s → %9s  (%s)%s" % (os.path.basename(f), format(st["before"], ","), format(st["after"], ","), state,
                                         ("  ⚠ " + "；".join(probs)) if probs else ""))
        if probs:
            bad += 1
            continue                      # 自我檢查沒過就不寫
        if a.dry_run or new == text:
            continue
        if a.out:
            os.makedirs(a.out, exist_ok=True)
            dest = os.path.join(a.out, os.path.basename(f))
        else:
            if backup:
                os.makedirs(backup, exist_ok=True)
                shutil.copy2(f, os.path.join(backup, os.path.basename(f)))
            dest = f
        with open(dest, "w", encoding="utf-8", newline="") as fh:
            fh.write(new)
    print("合計 %s → %s 位元組（省 %.1f%%）%s" % (format(tot_b, ","), format(tot_a, ","), 100.0 * (tot_b - tot_a) / max(1, tot_b),
                                          "　備份：" + backup if backup and os.path.isdir(backup) else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
