"""洋紅底 → 真透明 RGBA。核心遮罩 + 邊緣色彩去汙（用內部乾淨顏色取代邊緣 3px），並輸出深/淺底預覽。"""
import os, sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

S = os.path.dirname(os.path.abspath(__file__))
G = os.path.join(S, "gen")


def key_magenta(path, core_m=65, band=3, min_area=6, warm_fix=False, drop_pink=False, edge_desat=False):
    im = np.array(Image.open(path).convert("RGB"))
    f = im.astype(np.float32)
    m = np.minimum(f[..., 0], f[..., 2]) - f[..., 1]        # 洋紅度：背景≈230~255，暖色/綠色 < 0
    mask = m < core_m
    if drop_pink:                                   # 洋紅污染（高飽和、色相 295°~350°）不是畫面內容 → 剔除；淡紫花瓣飽和度低，不受影響
        hsv = np.array(Image.fromarray(im).convert("HSV")).astype(np.float32)
        hh, ss, vv = hsv[..., 0] * 360 / 255, hsv[..., 1] / 255, hsv[..., 2] / 255
        pink = (hh >= 295) & (hh <= 350) & (ss > 0.38) & (vv > 0.4)
        pink = ndimage.binary_dilation(pink, iterations=2)
        mask &= ~pink
    # 去零星雜點（背景雜訊 / 極小的孤立像素），保留火花這類小但亮的點：面積下限 min_area
    lbl, n = ndimage.label(mask)
    if n:
        sizes = ndimage.sum(mask, lbl, range(1, n + 1))
        keep = np.zeros(n + 1, bool); keep[1:] = sizes >= min_area
        mask = keep[lbl]
    # 只補「小而且不是洋紅底」的洞（花瓣高光等）；被圍住的大片洋紅背景要留成透明
    holes = ndimage.binary_fill_holes(mask) & ~mask
    hl, hn = ndimage.label(holes)
    for i in range(1, hn + 1):
        region = hl == i
        if region.sum() < 300 and float(m[region].mean()) < 150:
            mask = mask | region
    # 邊緣去汙：距離邊界 ≤band 的像素，顏色改用最近的「內部」像素
    dist = ndimage.distance_transform_edt(mask)
    inner = dist > band
    if inner.any():
        idx = ndimage.distance_transform_edt(~inner, return_distances=False, return_indices=True)
        clean = im[idx[0], idx[1]]
        rgb = np.where((mask & ~inner)[..., None], clean, im)
    else:
        rgb = im
    alpha = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    rgb_img = Image.fromarray(rgb.astype(np.uint8))
    if edge_desat:                                 # 貼近邊界的洋紅色暈：只降飽和度（銀色金屬、白布會變回中性色），不動紅/橘/木色
        hsv = np.array(rgb_img.convert("HSV")).astype(np.float32)
        hdeg = hsv[..., 0] * 360 / 255
        sel = mask & (dist <= 8) & (hdeg >= 285) & (hdeg <= 345) & (hsv[..., 1] > 35)
        hsv[..., 1] = np.where(sel, hsv[..., 1] * 0.12, hsv[..., 1])
        rgb_img = Image.fromarray(hsv.astype(np.uint8), "HSV").convert("RGB")
    if warm_fix:                                   # 洋紅色相（280°~350°）→ 暖橘：清掉透過玻璃/火花殘留的粉色
        hsv = np.array(rgb_img.convert("HSV")).astype(np.int32)
        h = hsv[..., 0] * 360.0 / 255.0
        sel = (h >= 280) & (h <= 350) & (hsv[..., 1] > 30)
        hsv[..., 0] = np.where(sel, int(32 * 255 / 360), hsv[..., 0])
        rgb_img = Image.fromarray(hsv.astype(np.uint8), "HSV").convert("RGB")
    out = rgb_img.convert("RGBA")
    out.putalpha(alpha)
    return out


def bbox_crop(img, pad=6, thr=12):
    l, t, r, b = img.split()[-1].point(lambda v: 255 if v > thr else 0).getbbox()
    return img.crop((max(0, l - pad), max(0, t - pad), min(img.width, r + pad), min(img.height, b + pad)))


def preview(img, name):
    W, H = img.size
    for tag, col in (("dark", (18, 28, 20)), ("light", (238, 240, 232))):
        bg = Image.new("RGBA", (W, H), col + (255,))
        bg.alpha_composite(img)
        bg.convert("RGB").save(os.path.join(G, "%s_%s_prev.png" % (name, tag)))


if __name__ == "__main__":
    for n in sys.argv[1:] or ["day_subject", "night_subject"]:
        k = bbox_crop(key_magenta(os.path.join(G, n + ".png"), warm_fix=n.startswith("night"), drop_pink=n.startswith("day")))
        k.save(os.path.join(G, n + "_cut.png"))
        a = np.array(k.split()[-1])
        print(n, k.size, "opaque %.0f%%" % (100 * (a > 240).mean()), "partial %.0f%%" % (100 * ((a > 12) & (a <= 240)).mean()))
        preview(k, n)
