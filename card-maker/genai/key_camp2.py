import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import key_subject as ks
G = ks.G
jobs = {"cabin_iso": dict(drop_pink=False),        # 木屋有粉紅兔子，不能剔除粉色
        "tent_iso2": dict(drop_pink=False, core_m=120, edge_desat=True)}
for n, kw in jobs.items():
    k = ks.bbox_crop(ks.key_magenta(os.path.join(G, n + ".png"), **kw))
    k.save(os.path.join(G, n + "_cut.png")); ks.preview(k, n)
    a = np.array(k.split()[-1]); print(n, k.size, "opaque %.0f%%" % (100 * (a > 240).mean()))
