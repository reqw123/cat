import os, sys, json, shutil, subprocess, hashlib
S = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, S)
import gen_layers

CAT = r"C:\cat"
PY = r"C:\Users\homec\anaconda3\python.exe"
REAL = "--real" in sys.argv
OUT = os.path.join(CAT, "cards") if REAL else os.path.join(S, "test_out3")
G = os.path.join(S, "gen")

common = dict(eyebrow="PHANTOM RESIDUAL", rarity="SSR", out_dir=OUT, overwrite=(not REAL))
cards = [
    dict(common, subject=os.path.join(G, "day_subject_cut.png"), scene=os.path.join(G, "day_bg.png"),
         name="林間露營·晝", glyph="晝", element="◈ FOREST 林", holo="dust", h2=48,
         skill_name="林蔭小憩", skill_en="Forest Camp Rest",
         skill_desc="在陽光斑駁的林間搭起帳篷歇息。回合開始時回復 **25%** 生命，並讓隊友的防禦提升 **10%**。",
         css={"BG_BLUR": "0.8", "SUBJ_WIDTH": "72%", "BG_BRIGHT": "1.02", "BG_SAT": "1.08", "BG_SCALE": "1.16",
              "WARN_OP": ".26", "PAST_OP": ".22"}),
    dict(common, subject=os.path.join(G, "night_subject_cut.png"), scene=os.path.join(G, "night_bg.png"),
         name="林間露營·夜", glyph="夜", element="◆ EMBER 燼", holo="embers", h1=34, h2=218,
         skill_name="營火夜話", skill_en="Campfire Tales",
         skill_desc="圍著營火與串燈度過長夜。每回合累積一層「暖意」，最多 **5** 層，每層攻擊提升 **8%**，滿層時治癒全隊。",
         css={"BG_BLUR": "0.8", "SUBJ_WIDTH": "74%", "BG_BRIGHT": "1.12", "BG_SAT": "1.1", "BG_SCALE": "1.16",
              "WARN_OP": ".3", "PAST_OP": ".26", "SUBJ_GLOW": "rgba(255,170,70,.55)"}),
]
if not REAL:
    shutil.copy2(os.path.join(CAT, "card-fx", "cards_meta.json"), os.path.join(S, "meta_test3.json"))

pre = None
if REAL:
    snap = lambda: {f: hashlib.md5(open(os.path.join(CAT, "cards", f), "rb").read()).hexdigest()
                    for f in os.listdir(os.path.join(CAT, "cards")) if os.path.isfile(os.path.join(CAT, "cards", f))}
    shutil.copy2(os.path.join(CAT, "card-fx", "cards_meta.json"), os.path.join(S, "cards_meta.before2.json"))
    pre = snap()

env = dict(os.environ, PYTHONIOENCODING="utf-8")
if REAL:
    env.pop("CARD_FX_META", None)
else:
    env["CARD_FX_META"] = os.path.join(S, "meta_test3.json")

for i, c in enumerate(cards):
    key = "day" if i == 0 else "night"
    c["notes"] = dict(generator="Gemini image API", model=gen_layers.MODEL,
                      scene_prompt=gen_layers.PROMPTS[key + "_bg"]["prompt"],
                      subject_prompt=gen_layers.PROMPTS[key + "_subject"]["prompt"],
                      reference_photo=key + ".png (user's camp photo, used as composition reference)",
                      postprocess="subject: magenta-key -> alpha (key_subject.py); scene: used as generated")
    pp = os.path.join(S, "params_camp_%d.json" % i)
    with open(pp, "w", encoding="utf-8") as f:
        json.dump(c, f, ensure_ascii=False, indent=2)
    r = subprocess.run([PY, os.path.join(CAT, "card-maker", "make_card_layers.py"), "--params", pp],
                       capture_output=True, text=True, encoding="utf-8", env=env)
    lines = [l[:170] for l in r.stdout.splitlines() if '"done"' in l or '"error"' in l or "失敗" in l]
    print(r.returncode, lines, r.stderr[-400:])

if REAL:
    post = snap()
    print("changed existing:", [k for k in pre if post.get(k) != pre[k]])
    print("added:", [k for k in post if k not in pre])
