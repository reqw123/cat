#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""圖片 → 全息殘影卡 一鍵生成（builder-gui「🪄 圖片一鍵生成卡片」的後端，也可單獨用）。

流程：讀圖 → 去背（rembg，或圖片本身已有透明就直接用）→ 抽主色 → 由主色推導整組配色
（:root、背景漸層、殘影濾鏡、全息色階、面板/標記/卡背）→ 填進 card_template.py → 輸出一份
自包含（圖片 base64 內嵌）的 cards/<名稱>_phantom_card.html。產出的卡片跟六狗系列同架構：
自由 360° 環轉、卡背、雙擊翻面、每秒自動翻面（L 鍵 / 桌面掛件 F4）、hover 視差、全息。

用法：  python make_card.py --params params.json
params.json 欄位（除 image 外都可省略，省略就自動推導）：
  image        來源圖片路徑（必填）
  name         卡片名稱（預設用檔名）
  eyebrow      名稱上方的小標題（預設 PHANTOM RESIDUAL）
  skill_name / skill_en / skill_desc   技能名稱、英文副標、說明（說明可用 **粗體**）
  element      左上角屬性晶片，例如 "◈ WIND 風"（預設依主色自動挑）
  glyph        卡背大字（預設取名稱第一個字）
  rarity       SR / SSR / UR / LR（預設 SSR）
  model        isnet-anime（動漫角色）/ isnet-general-use（照片、動物）/ u2net / none（不去背）
  holo         auto / dust / chrome_scan / embers / grid_bokeh / radar / speedlines
  out_dir      輸出資料夾（預設 ../cards）
  overwrite    已有同名檔案時是否覆蓋（預設 false）

進度用 stdout 的 `@@{json}` 行回報給 GUI（stage / done / error 事件），其他輸出是給人看的 log。
"""
import argparse
import base64
import colorsys
import html as htmllib
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def emit(event, **kw):
    print("@@" + json.dumps(dict(event=event, **kw), ensure_ascii=False), flush=True)


def fail(code, message):
    emit("error", code=code, message=message)
    sys.exit(1)


try:
    import numpy as np
    from PIL import Image, ImageFilter, ImageOps
except ImportError as e:  # pragma: no cover
    fail("missing_dep", f"缺少 Python 套件：{e.name}。請執行：pip install pillow numpy scipy \"rembg[cpu]\"")

from card_template import TEMPLATE
from holo_variants import HOLO_VARIANTS

MODELS = ("isnet-anime", "isnet-general-use", "u2net", "none")
HOLO_KEYS = ("auto",) + tuple(HOLO_VARIANTS.keys())


# ---------------------------------------------------------------- 顏色小工具
def clamp(v, a, b):
    return a if v < a else (b if v > b else v)


def hsl(h, s, l):
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360.0, clamp(l, 0, 1), clamp(s, 0, 1))
    return (round(r * 255), round(g * 255), round(b * 255))


def hexs(rgb):
    return "#%02x%02x%02x" % rgb


def rgba(rgb, a):
    return "rgba(%d,%d,%d,%s)" % (rgb[0], rgb[1], rgb[2], ("%.2f" % a).rstrip("0").rstrip("."))


# ---------------------------------------------------------------- 圖片處理
def load_image(path):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
    else:
        img = img.convert("RGB")
    return img


def has_real_alpha(img):
    if img.mode != "RGBA":
        return False
    a = np.array(img.split()[-1])
    return (a < 250).mean() > 0.03 and (a > 200).mean() > 0.02


def model_cached(model):
    """rembg 新版把模型放在 ~/.rembg/models/<名稱>/，舊版放 ~/.u2net/；找得到才算已下載。"""
    roots = [os.getenv("U2NET_HOME"), os.getenv("REMBG_HOME"),
             os.path.join(os.path.expanduser("~"), ".rembg"), os.path.join(os.path.expanduser("~"), ".u2net")]
    for root in filter(None, roots):
        for dirpath, _dirs, files in os.walk(os.path.expanduser(root)):
            if model + ".onnx" in files:
                return True
    return False


def cutout(img_rgb, model, erode=1, feather=1.0, lo=25, hi=115):
    """rembg 去背 + 軟化 alpha（同六狗 cutout.py）+ 去掉零星孤島 + 裁到緊貼邊界。"""
    try:
        from rembg import remove, new_session
    except ImportError:
        fail("missing_dep", "缺少 rembg。請執行：pip install \"rembg[cpu]\"")
    if not model_cached(model):
        emit("stage", key="model", message=f"第一次使用「{model}」，正在下載去背模型（約 170MB，只需一次）…")
    else:
        emit("stage", key="model", message=f"載入去背模型 {model}…")
    session = new_session(model)
    emit("stage", key="cutout", message="去背中（CPU 約 5～30 秒）…")
    out = remove(img_rgb, session=session)
    a = np.array(out.split()[-1]).astype(np.float32)
    a = np.clip((a - lo) / max(1, (hi - lo)) * 255.0, 0, 255).astype(np.uint8)
    alpha_img = Image.fromarray(a)
    if erode > 0:
        alpha_img = alpha_img.filter(ImageFilter.MinFilter(2 * erode + 1))
    alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(feather))
    out.putalpha(alpha_img)
    out = drop_islands(out)
    return out


def drop_islands(rgba_img):
    a = np.array(rgba_img.split()[-1])
    mask = (a > 30).astype(np.uint8)
    try:
        from scipy import ndimage
        lbl, n = ndimage.label(mask)
        if n > 1:
            sizes = ndimage.sum(mask, lbl, range(1, n + 1))
            keep = (lbl == (np.argmax(sizes) + 1))
            rgba_img.putalpha(Image.fromarray(np.where(keep, a, 0).astype(np.uint8)))
    except ImportError:
        pass
    return rgba_img


def crop_to_bbox(rgba_img, pad=6):
    bbox = rgba_img.split()[-1].point(lambda v: 255 if v > 24 else 0).getbbox()
    if not bbox:
        return rgba_img, (0, 0, rgba_img.width, rgba_img.height)
    l, t, r, b = bbox
    l, t = max(0, l - pad), max(0, t - pad)
    r, b = min(rgba_img.width, r + pad), min(rgba_img.height, b + pad)
    return rgba_img.crop((l, t, r, b)), (l, t, r, b)


def soft_full_subject(img_rgb):
    """model=none：不去背，把整張圖當主體，邊緣做橢圓羽化，避免像一張貼上去的矩形照片。"""
    w, h = img_rgb.size
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
    a = np.clip((1.05 - d) / 0.25, 0, 1)
    out = img_rgb.convert("RGBA")
    out.putalpha(Image.fromarray((a * 255).astype(np.uint8)))
    return out


MAX_SUBJECT_AR = 1.3   # 主體高寬比上限：更瘦高的（全身像）只留上半身，才放得進面板上方的空間


def portrait_crop(subject, bbox):
    """太瘦高的主體：保留頂端（頭部）到 MAX_SUBJECT_AR，底部做漸層淡出融進技能面板。"""
    w, h = subject.size
    if h / w <= MAX_SUBJECT_AR:
        return subject, bbox
    ch = int(round(w * MAX_SUBJECT_AR))
    out = subject.crop((0, 0, w, ch))
    a = np.array(out.split()[-1]).astype(np.float32)
    fade = int(ch * 0.16)
    ramp = np.ones(ch, dtype=np.float32)
    ramp[ch - fade:] = np.linspace(1.0, 0.0, fade)
    out.putalpha(Image.fromarray((a * ramp[:, None]).astype(np.uint8)))
    return out, (bbox[0], bbox[1], bbox[2], bbox[1] + ch)


def object_pos(frac_x, frac_y, src_w, src_h):
    """CSS object-fit:cover 的 object-position 百分比，讓場景窗口的中心對準來源圖的 (frac_x, frac_y)。
    場景窗＝卡片內寬 W × 0.84W（高度是卡片 1.4W 的 60%）。"""
    box_w, box_h = 1.0, 0.84
    scale = max(box_w / src_w, box_h / src_h)
    out = []
    for frac, dim, box in ((frac_x, src_w, box_w), (frac_y, src_h, box_h)):
        scaled = dim * scale
        overflow = scaled - box
        out.append(50 if overflow < 1e-3 else int(round(clamp((frac * scaled - box / 2) / overflow, 0, 1) * 100)))
    return "%d%% %d%%" % (out[0], out[1])


def fit_max(img, max_w, max_h):
    s = min(1.0, max_w / img.width, max_h / img.height)
    if s < 1.0:
        img = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)
    return img


def make_scene(src, subject_rgba, base_hue):
    """場景圖（卡片上半的窗）＝原圖。原圖本身有透明時，把主體疊在自己放大模糊的底上。"""
    if src.mode == "RGBA":
        bg = Image.new("RGB", subject_rgba.size, hsl(base_hue, 0.3, 0.16))
        blurred = subject_rgba.convert("RGB").filter(ImageFilter.GaussianBlur(24))
        bg = Image.blend(bg, blurred, 0.6)
        bg.paste(subject_rgba.convert("RGB"), mask=subject_rgba.split()[-1])
        scene = bg
    else:
        scene = src
    return fit_max(scene.convert("RGB"), 760, 1400)


# ---------------------------------------------------------------- 主色分析
def rgb_to_hsv_arr(rgb):
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    mx = rgb.max(axis=1)
    mn = rgb.min(axis=1)
    d = mx - mn
    h = np.zeros_like(mx)
    m = d > 1e-6
    rc = m & (mx == r)
    gc = m & (mx == g) & ~rc
    bc = m & ~rc & ~gc
    h[rc] = ((g[rc] - b[rc]) / d[rc]) % 6
    h[gc] = (b[gc] - r[gc]) / d[gc] + 2
    h[bc] = (r[bc] - g[bc]) / d[bc] + 4
    h = h * 60.0
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    return h, s, mx


def analyze_palette(subject_rgba, scene_rgb):
    """回傳 dict(h1,h2,s1,vivid,neutral)。h1＝主色相、h2＝副色相（度）。"""
    def hue_hist(img, use_alpha):
        small = img.copy()
        small.thumbnail((140, 140))
        arr = np.array(small.convert("RGBA")).reshape(-1, 4)
        if use_alpha:
            arr = arr[arr[:, 3] > 200]
        rgb = arr[:, :3].astype(np.float32) / 255.0
        if len(rgb) == 0:
            return None
        h, s, v = rgb_to_hsv_arr(rgb)
        ok = (s > 0.22) & (v > 0.22)
        w = np.where(ok, (s ** 1.3) * v, 0.0)
        hist = np.zeros(36)
        np.add.at(hist, (h // 10).astype(int) % 36, w)
        hist = np.convolve(np.r_[hist[-1], hist, hist[0]], [0.25, 0.5, 0.25], mode="valid")
        return hist, float(ok.mean()), float(s[ok].mean()) if ok.any() else 0.0

    res = hue_hist(subject_rgba, True)
    if res is None or res[1] < 0.04:
        res = hue_hist(scene_rgb, False) or (np.zeros(36), 0.0, 0.0)
    hist, vivid, mean_s = res
    if vivid < 0.04 or hist.max() <= 0:
        return dict(h1=215.0, h2=42.0, s1=0.45, vivid=vivid, neutral=True)

    i1 = int(hist.argmax())
    h1 = i1 * 10 + 5.0
    rest = hist.copy()
    for k in range(-4, 5):                       # 抹掉主色附近 ±40°
        rest[(i1 + k) % 36] = 0
    if rest.max() > hist.max() * 0.22:
        h2 = int(rest.argmax()) * 10 + 5.0
    else:                                        # 沒有明顯第二色 → 取分裂互補色
        h2 = (h1 + 150.0) % 360
    return dict(h1=h1, h2=h2, s1=clamp(0.35 + 0.5 * mean_s, 0.5, 0.78), vivid=vivid, neutral=False)


def element_for(h, neutral):
    if neutral:
        return "◆ STEEL 鋼"
    table = [(20, "◆ FLAME 焰"), (45, "◈ EMBER 燼"), (70, "◈ SUN 陽"), (165, "◈ WIND 風"),
             (200, "◈ TIDE 潮"), (255, "◆ FROST 霜"), (290, "❖ MYSTIC 玄"), (340, "◈ NEON 霓")]
    for limit, label in table:
        if h < limit:
            return label
    return "◆ FLAME 焰"


def holo_for(h, neutral):
    if neutral:
        return "chrome_scan"
    if h < 40 or h >= 340:
        return "embers"
    if h < 165:
        return "dust"
    if h < 255:
        return "radar"
    return "grid_bokeh"


# ---------------------------------------------------------------- 文字
def esc(s):
    return htmllib.escape(s, quote=False)


def rich(s):
    return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", esc(s))


def first_glyph(name):
    for ch in name:
        if re.match(r"[㐀-鿿豈-﫿]", ch):
            return ch
    for ch in name:
        if ch.isalnum():
            return ch.upper()
    return "✦"


def slugify(name):
    # 只留文字（含中日韓）、數字、底線、連字號，其他一律換成 _。檔名會被拿去當網址、當
    # electron-builder 的 files 萬用字元、當 yml 的值，所以 % # ? & [ ] { } ( ) ! * 空白都不能留
    # （實際發生過：名稱含 % 的卡片，打包後的 exe 載入時 %3F 被當成網址編碼，整個視窗空白）。
    s = re.sub(r"[^\w-]+", "_", name.strip()).strip("._-")
    return s or "card"


def b64(data):
    return base64.b64encode(data).decode("ascii")


# ---------------------------------------------------------------- 組裝
def build_config(p, pal, subject_size, bbox, src_size):
    h1, h2, s1 = pal["h1"], pal["h2"], pal["s1"]
    name = p["name"]
    c1 = hsl(h1, s1, 0.42)
    c1_light = hsl(h1, 0.85, 0.62)
    c2 = hsl(h2, 0.85, 0.58)
    c3 = hsl(h2, 0.95, 0.78)
    abyss = hsl(h1, 0.35, 0.065)

    ar = subject_size[1] / subject_size[0]
    bottom = 0.46
    width = clamp(min(0.9, (1 - bottom - 0.06) * 1.4 / ar), 0.5, 0.9)

    obj_pos = object_pos((bbox[0] + bbox[2]) / 2 / src_size[0],
                         (bbox[1] + 0.3 * (bbox[3] - bbox[1])) / src_size[1], src_size[0], src_size[1])

    holo_key = p["holo"]
    if holo_key == "auto":
        holo_key = holo_for(h1, pal["neutral"])
    holo_extra = {
        "DUSTC2": rgba(hsl(h2, 1.0, 0.72), 0.85),
        "DUSTC3": rgba(c1_light, 0.8),
        "EMBERC1": rgba(hsl(h2, 1.0, 0.6), 0.9),
        "EMBERC2": rgba(c3, 0.85),
    }
    stops = [(c3, 0), (hsl(h1, 0.9, 0.66), 22), (hsl(h2, 0.95, 0.6), 42),
             (hsl(h1 + 45, 0.9, 0.68), 64), (hsl(h2 - 40, 0.95, 0.6), 82), (c3, 100)]
    holo_stops = ", ".join("%s %d%%" % (rgba(c, 0.42), at) for c, at in stops)

    def ghost_filter(h, sat, bright, contrast, extra, glow_a):
        return ("sepia(1) hue-rotate(%ddeg) saturate(%s) brightness(%s) contrast(%s)%s drop-shadow(0 0 10px %s)"
                % (round(h - 38), sat, bright, contrast, extra, rgba(hsl(h, 1.0, 0.6), glow_a)))

    element = p["element"] or element_for(h1, pal["neutral"])
    eyebrow = p["eyebrow"] or "PHANTOM RESIDUAL"
    glyph = p["glyph"] or first_glyph(name)
    rarity = p["rarity"]

    cfg = {
        "PAGE_TITLE": esc("%s — %s 幻影殘卡" % (name, rarity)),
        "HOLO_ANG0": "108",
        "C1": hexs(c1), "C2": hexs(c2), "C3": hexs(c3), "ABYSS": hexs(abyss),
        "BODY_BG1": hexs(hsl(h1, 0.32, 0.14)), "BODY_BG2": hexs(hsl(h1, 0.32, 0.10)),
        "BODY_BG3": hexs(hsl(h1, 0.32, 0.065)), "BODY_BG4": hexs(hsl(h1, 0.3, 0.03)),
        "DUST1": rgba(c1_light, 0.5), "DUST2": rgba(c2, 0.45), "DUST3": rgba(c2, 0.35),
        # 金屬外框沿用六狗系列的金色（所有卡片一致）
        "FRAME_GRADIENT": "linear-gradient(115deg, #241a05 0%, #8a6a1c 9%, #d8b352 19%, #fff6d8 27%, #b98d2e 35%, #5c4610 47%, #9a7a24 58%, #f4e2a0 70%, #7c5f18 84%, #241a05 100%)",
        "FRAME_GLOW": "rgba(212,175,55,.16)",
        "INNER_BG1": hexs(hsl(h1, 0.32, 0.14)), "INNER_BG2": hexs(hsl(h1, 0.4, 0.03)),
        "INNER_RING": rgba(c2, 0.22),
        "OBJ_POS": obj_pos,
        "BG_BLUR": "8", "BG_BRIGHT": ".42", "BG_SAT": ".6", "BG_SCALE": "1.28",
        "WARN_OP": ".44", "WARN_FILTER": ghost_filter(h2, "3.4", ".95", "1.1", "", 0.7),
        "WARN_TX": "11%", "WARN_TY": "-16%", "WARN_SCALE": "1.16",
        "PAST_OP": ".4", "PAST_FILTER": ghost_filter(h1, "3.6", ".9", "1.08", " blur(.6px)", 0.7),
        "PAST_TX": "-26%", "PAST_TY": "16%", "PAST_SCALE": "1.24",
        "VEIL_BG": "radial-gradient(130%% 90%% at 50%% 20%%, %s, %s 60%%, %s 100%%)" % (
            rgba(c1_light, 0.12), rgba(hsl(h1, 0.4, 0.07), 0.24), rgba(hsl(h1, 0.4, 0.05), 0.4)),
        "MIST_BOT": rgba(hsl(h1, 0.35, 0.08), 0.72),
        "HOLO_STOPS": holo_stops,
        "CHIP_ELEM_LABEL": esc(element),
        "CHIP_ELEM_BG": "linear-gradient(120deg, %s, %s)" % (rgba(c1, 0.62), rgba(c2, 0.5)),
        "CHIP_ELEM_TEXT": hexs(hsl(h1, 0.9, 0.95)),
        "CHIP_ELEM_GLOW": rgba(c1_light, 0.4),
        "PANEL_BG": rgba(hsl(h1, 0.4, 0.07), 0.85),
        "PANEL_TOP_BORDER": rgba(hsl(h1, 0.6, 0.7), 0.3),
        "EYEBROW": esc(eyebrow),
        "EYEBROW_COLOR": hexs(hsl(h2, 0.9, 0.82)), "EYEBROW_GLOW": rgba(c2, 0.6),
        "NAME": esc(name),
        "NAME_GLOW": rgba(c1_light, 0.42),
        "RULE1": rgba(c1_light, 0.7), "RULE2": rgba(c2, 0.35),
        "SKILL_NAME": esc(p["skill_name"]), "SKILL_EN": esc(p["skill_en"]),
        "SKILL_DESC": rich(p["skill_desc"]),
        "SKILL_NAME_COLOR": hexs(hsl(h1, 0.75, 0.72)), "SKILL_NAME_GLOW": rgba(c1_light, 0.55),
        "SKILL_SUB_COLOR": hexs(hsl(h2, 0.3, 0.72)), "SKILL_B_GLOW": rgba(c3, 0.7),
        "SUBJ_BOTTOM": "%d%%" % round(bottom * 100), "SUBJ_WIDTH": "%d%%" % round(width * 100),
        "SUBJ_Z": "26", "SUBJ_GLOW": rgba(c2, 0.3),
        "RARITY": esc(rarity),
        "GLYPH": esc(glyph),
        "SET_NAME": "PHANTOM RESIDUAL · 幻影殘卡系列",
    }
    return cfg, holo_key, holo_extra


def render(cfg, holo_key, holo_extra, subject_png, scene_jpg):
    variant = HOLO_VARIANTS[holo_key]
    fx_css = variant["css"]
    for k, v in holo_extra.items():
        fx_css = fx_css.replace("%%" + k + "%%", v)
    out = TEMPLATE
    out = out.replace("%%HOLO_FX_CSS%%", fx_css).replace("%%HOLO_FX_HTML%%", variant["html"])
    out = out.replace("%%IMG_SUBJECT_B64%%", b64(subject_png)).replace("%%IMG_SCENE_B64%%", b64(scene_jpg))
    for k, v in cfg.items():
        out = out.replace("%%" + k + "%%", str(v))
    left = sorted(set(re.findall(r"%%([A-Z0-9_]+)%%", out)))
    if left:
        fail("template", "模板有未填的欄位：" + ", ".join(left))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", required=True)
    args = ap.parse_args()
    with open(args.params, "r", encoding="utf-8") as f:
        raw = json.load(f)

    image = raw.get("image")
    if not image or not os.path.isfile(image):
        fail("no_image", "找不到來源圖片：%s" % image)
    model = raw.get("model") or "isnet-anime"
    holo = raw.get("holo") or "auto"
    rarity = (raw.get("rarity") or "SSR").upper()
    if model not in MODELS:
        fail("bad_param", "不認得的去背模型：%s（可用：%s）" % (model, ", ".join(MODELS)))
    if holo not in HOLO_KEYS:
        fail("bad_param", "不認得的全息效果：%s" % holo)
    name = (raw.get("name") or "").strip() or os.path.splitext(os.path.basename(image))[0]
    p = {
        "name": name,
        "eyebrow": (raw.get("eyebrow") or "").strip(),
        "skill_name": (raw.get("skill_name") or "").strip() or "幻影殘響",
        "skill_en": (raw.get("skill_en") or "").strip() or "Phantom Echo",
        "skill_desc": (raw.get("skill_desc") or "").strip()
        or "在戰場留下一道時空殘影。受到攻擊時有 **40%** 機率閃避，並發動殘影反擊。",
        "element": (raw.get("element") or "").strip(),
        "glyph": (raw.get("glyph") or "").strip()[:2],
        "rarity": rarity if rarity in ("SR", "SSR", "UR", "LR") else "SSR",
        "holo": holo,
    }

    out_dir = os.path.abspath(raw.get("out_dir") or os.path.join(HERE, "..", "cards"))
    slug = slugify(name)
    out_path = os.path.join(out_dir, "%s_phantom_card.html" % slug)
    if os.path.exists(out_path) and not raw.get("overwrite"):
        fail("exists", "cards/%s_phantom_card.html 已經存在。換一個名稱，或勾選「覆蓋同名檔案」。" % slug)

    emit("stage", key="read", message="讀取圖片…")
    src = load_image(image)

    if has_real_alpha(src):
        emit("stage", key="cutout", message="圖片本身已有透明背景，跳過去背。")
        subject = drop_islands(src.copy())
        src_for_scene = src
    elif model == "none":
        emit("stage", key="cutout", message="不去背：整張圖當主體（邊緣羽化）。")
        subject = soft_full_subject(src.convert("RGB"))
        src_for_scene = src.convert("RGB")
    else:
        rgb = src.convert("RGB")
        subject = cutout(rgb, model)
        src_for_scene = rgb

    subject_full = subject
    src_size = src_for_scene.size
    emit("stage", key="palette", message="分析主色、推導配色與全息色階…")
    pal = analyze_palette(subject_full, src_for_scene.convert("RGB"))
    scene = make_scene(src_for_scene, subject_full, pal["h1"])

    subject, bbox = crop_to_bbox(subject_full)
    if subject.getbbox() is None or subject.width < 8:
        fail("cutout_empty", "去背後什麼都沒留下。換個去背模型，或改選「不去背」。")
    subject, bbox = portrait_crop(subject, bbox)
    subject = fit_max(subject, 720, 900)

    cfg, holo_key, holo_extra = build_config(p, pal, subject.size, bbox, src_size)

    emit("stage", key="render", message="組裝卡片 HTML…")
    buf = io.BytesIO()
    subject.save(buf, "PNG", optimize=True)
    subject_png = buf.getvalue()
    buf = io.BytesIO()
    scene.save(buf, "JPEG", quality=80)
    scene_jpg = buf.getvalue()
    html_text = render(cfg, holo_key, holo_extra, subject_png, scene_jpg)

    # 卡片瘦身：內嵌圖片轉 WebP、重複 3 份的場景圖收成 1 份（見 ../card-slim/slim.py，實測整張卡小 70～80%）。
    # 失敗不該讓整張卡生成失敗——退回沒瘦身的 html（卡片一樣能用，只是檔案比較大）。
    try:
        sys.path.insert(0, os.path.join(HERE, "..", "card-slim"))
        import slim
        slim_text, _slim_stats = slim.slim_html(html_text)
        slim_problems = slim.check_html(slim_text)
        if slim_problems:
            raise RuntimeError("；".join(slim_problems))
        html_text = slim_text
    except Exception as e:  # noqa: BLE001
        print("卡片瘦身失敗（卡片仍可用，只是檔案比較大）：%s" % e, flush=True)

    # 稀有度切換／技能演出／卡背資訊／音效（card-fx）：跟既有卡片同一套，見 ../card-fx/。
    # 編號、日期、四項數值登記在 card-fx/cards_meta.json；這一步失敗不該讓整張卡生成失敗。
    try:
        sys.path.insert(0, os.path.join(HERE, "..", "card-fx"))
        import apply_fx
        fx_meta = apply_fx.load_meta()
        fx_obj = apply_fx.build_meta(html_text, os.path.basename(out_path), out_path, fx_meta)
        html_text = apply_fx.inject(html_text, fx_obj)
        apply_fx.save_meta(fx_meta)
    except Exception as e:  # noqa: BLE001
        print("card-fx 注入失敗（卡片仍可用，但沒有技能演出/稀有度切換）：%s" % e, flush=True)

    os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(html_text)

    # 中間產物留一份，方便日後想手動微調（換色、換場景）時不用重新去背
    work = os.path.join(HERE, "output", slug)
    os.makedirs(work, exist_ok=True)
    with open(os.path.join(work, "subject.png"), "wb") as f:
        f.write(subject_png)
    with open(os.path.join(work, "scene.jpg"), "wb") as f:
        f.write(scene_jpg)
    with open(os.path.join(work, "config.json"), "w", encoding="utf-8") as f:
        json.dump(dict(params=p, holo=holo_key, palette=pal, tokens=cfg), f, ensure_ascii=False, indent=2)

    emit("done", file=os.path.basename(out_path), path=out_path, sizeBytes=len(html_text.encode("utf-8")),
         holo=holo_key,
         palette=dict(c1=cfg["C1"], c2=cfg["C2"], c3=cfg["C3"], abyss=cfg["ABYSS"],
                      h1=round(pal["h1"]), h2=round(pal["h2"]), neutral=pal["neutral"]),
         element=p["element"] or element_for(pal["h1"], pal["neutral"]), glyph=p["glyph"] or first_glyph(name))


if __name__ == "__main__":
    main()
