"""中秋系列玉兔主體去背（洋紅底 → alpha）。用法：python key_midautumn.py [名稱 ...]（省略＝全部）"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from key_subject import key_magenta, bbox_crop, preview, G

RABBIT = dict(warm_fix=True, edge_desat=True, drop_pink=True, band=4)
JOBS = {
    "ma_subject_f": RABBIT,            # 夜：提燈玉兔
    "ma_day_subject_p": RABBIT,        # 晝：捧月餅玉兔
    "ma_bbq_subject_p2": RABBIT,       # 烤肉
    "ma_lantern_subject_p2": RABBIT,   # 天燈
    "ma_cake_subject_p2": RABBIT,      # 月餅工坊
    "ma_pomelo_subject_p2": RABBIT,    # 文旦
}

for n in sys.argv[1:] or list(JOBS):
    k = bbox_crop(key_magenta(os.path.join(G, n + ".png"), **JOBS[n]))
    k.save(os.path.join(G, n + "_cut.png"))
    a = np.array(k.split()[-1])
    print(n, k.size, "opaque %.0f%%" % (100 * (a > 240).mean()), "partial %.0f%%" % (100 * ((a > 12) & (a <= 240)).mean()))
    preview(k, n)
