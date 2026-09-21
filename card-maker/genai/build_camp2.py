"""第二組營區卡：森林屋·晝（木屋主體＋日景背景）、露天影院·夜（帳篷＋投影幕主體＋夜景背景）。
用法： python build_camp2.py          → 測試輸出到暫存資料夾（不動 cards/、cards_meta.json）
       python build_camp2.py --real   → 寫入 C:\\cat\\cards（不覆蓋；事後比對既有檔案 md5）"""
import os, sys, json, shutil, subprocess, hashlib, tempfile
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import gen_subjects

CAT = r"C:\cat"
PY = r"C:\Users\homec\anaconda3\python.exe"
REAL = "--real" in sys.argv
TMP = os.path.join(tempfile.gettempdir(), "camp2_test"); os.makedirs(TMP, exist_ok=True)
OUT = os.path.join(CAT, "cards") if REAL else os.path.join(TMP, "cards")
G = os.path.join(HERE, "gen")


def night_grade(src, dst):
    """帳篷主體放到夜景上：只做輕微調色（變暗、偏藍），造型不改。"""
    im = Image.open(src).convert("RGBA")
    a = np.array(im).astype(np.float32)
    a[..., 0] *= 0.78; a[..., 1] *= 0.84; a[..., 2] *= 0.98
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA").save(dst)
    return dst


tent_night = night_grade(os.path.join(G, "tent_iso2_cut.png"), os.path.join(G, "tent_iso2_cut_night.png"))

common = dict(eyebrow="PHANTOM RESIDUAL", rarity="SSR", out_dir=OUT, overwrite=(not REAL))
cards = [
    dict(common, subject=os.path.join(G, "cabin_iso_cut.png"), scene=os.path.join(HERE, "day.png"),
         name="森林屋·晝", glyph="屋", element="◈ LODGE 木", holo="dust", h1=24, h2=205,
         skill_name="兔兔守門", skill_en="Rabbit Guardians",
         skill_desc="木屋前的兔兔雕像默默看守營地。戰鬥開始時為全隊加上「守護」，抵擋下一次傷害的 **30%**，並回復 **10%** 生命。",
         css={"BG_BLUR": "0.8", "BG_BRIGHT": "1.22", "BG_SAT": "1.12", "BG_SCALE": "1.14",
              "WARN_OP": ".3", "PAST_OP": ".26", "SUBJ_GLOW": "rgba(255,190,110,.45)"}),
    dict(common, subject=tent_night, scene=os.path.join(HERE, "night.png"),
         name="露天影院·夜", glyph="影", element="❖ CINEMA 影", holo="grid_bokeh", h1=208, h2=40,
         skill_name="星空電影院", skill_en="Starlit Cinema",
         skill_desc="在樹林間拉起銀幕，窩在帳篷裡看一場電影。每回合回復 **15%** 生命，並讓全隊 **免疫負面狀態** 一回合。",
         css={"SUBJ_WIDTH": "92%", "BG_BLUR": "0.8", "BG_BRIGHT": "1.12", "BG_SAT": "1.1", "BG_SCALE": "1.14",
              "WARN_OP": ".3", "PAST_OP": ".26", "SUBJ_GLOW": "rgba(150,200,255,.5)"}),
]

env = dict(os.environ, PYTHONIOENCODING="utf-8")
pre = None
meta = os.path.join(CAT, "card-fx", "cards_meta.json")
if REAL:
    env.pop("CARD_FX_META", None)
    shutil.copy2(meta, os.path.join(TMP, "cards_meta.before.json"))
    snap = lambda: {f: hashlib.md5(open(os.path.join(CAT, "cards", f), "rb").read()).hexdigest()
                    for f in os.listdir(os.path.join(CAT, "cards")) if os.path.isfile(os.path.join(CAT, "cards", f))}
    pre = snap()
else:
    shutil.copy2(meta, os.path.join(TMP, "meta_test.json"))
    env["CARD_FX_META"] = os.path.join(TMP, "meta_test.json")

for i, c in enumerate(cards):
    src_key = "cabin" if i == 0 else "tent"
    c["notes"] = dict(
        generator="Gemini image API", model=gen_subjects.MODEL,
        background="user's camp photo (%s) used as-is" % ("day" if i == 0 else "night"),
        subject_source="user's screenshot (%s), low-res with overlays" % src_key,
        step1_clean_prompt=gen_subjects.CLEAN[src_key], step2_isolate_prompt=gen_subjects.ISO[src_key],
        step3="tent only: recomposed via recompose_tent.py so the screen sits next to the platform (tent_iso2.png)" if i else "",
        postprocess="magenta key -> alpha (key_subject.py / key_camp2.py)" + ("; mild night colour grade (x0.78,0.84,0.98)" if i else ""))
    pp = os.path.join(TMP, "params_camp2_%d.json" % i)
    with open(pp, "w", encoding="utf-8") as f:
        json.dump(c, f, ensure_ascii=False, indent=2)
    r = subprocess.run([PY, os.path.join(CAT, "card-maker", "make_card_layers.py"), "--params", pp],
                       capture_output=True, text=True, encoding="utf-8", env=env)
    print(r.returncode, [l[:150] for l in r.stdout.splitlines() if '"done"' in l or '"error"' in l or "失敗" in l], r.stderr[-300:])

if REAL:
    post = snap()
    print("changed existing:", [k for k in pre if post.get(k) != pre[k]])
    print("added:", [k for k in post if k not in pre])
else:
    print("test output:", OUT)
