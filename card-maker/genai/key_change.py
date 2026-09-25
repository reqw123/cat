"""嫦娥主體去背：腰帶是暗紅（色相 ~346°，接近洋紅），不開 drop_pink / warm_fix。
另加「洋紅去溢色」：只對色相 260°~335° 的像素，把 min(R,B) 超過 G 的部分從 R、B 扣掉 → 髮絲縫隙的洋紅變深灰、
半透明披帛的淡紫變回淡藍灰；暗紅腰帶、唇色、金色都不在這個色相範圍。"""
import os, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from key_subject import key_magenta, bbox_crop, preview, G


def despill_magenta(img, h_lo=260, h_hi=335):
    arr = np.array(img).astype(np.float32)
    rgb = arr[..., :3]
    hsv = np.array(img.convert("RGB").convert("HSV")).astype(np.float32)
    hdeg = hsv[..., 0] * 360 / 255
    sel = (hdeg >= h_lo) & (hdeg <= h_hi) & (hsv[..., 1] > 20)
    excess = np.clip(np.minimum(rgb[..., 0], rgb[..., 2]) - rgb[..., 1], 0, None)
    excess = np.where(sel, excess, 0)
    rgb[..., 0] -= excess
    rgb[..., 2] -= excess * 0.85          # 藍色留一點，淡紫會落在「淡藍灰」而不是純灰，跟冰藍衣料一致
    arr[..., :3] = np.clip(rgb, 0, 255)
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


n = sys.argv[1] if len(sys.argv) > 1 else "ma_change_subject_p2"
k = bbox_crop(despill_magenta(key_magenta(os.path.join(G, n + ".png"), edge_desat=True)))
k.save(os.path.join(G, n + "_cut.png"))
a = np.array(k.split()[-1])
print(n, k.size, "opaque %.0f%%" % (100 * (a > 240).mean()), "partial %.0f%%" % (100 * ((a > 12) & (a <= 240)).mean()))
preview(k, n)
