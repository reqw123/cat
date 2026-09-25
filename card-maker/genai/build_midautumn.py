"""2026 中秋祝福卡建置（夜：中秋快樂；晝：中秋快樂·晝）。
用法：python build_midautumn.py night|day [--real]
預設輸出到暫存資料夾測試（用 cards_meta 的副本）；--real 才寫進 C:\\cat\\cards（並比對既有卡 md5）。"""
import os, sys, json, shutil, subprocess, hashlib
S = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, S)
import gen_midautumn

CAT = r"C:\cat"
PY = r"C:\Users\homec\anaconda3\python.exe"
REAL = "--real" in sys.argv
SCRATCH = os.environ.get("MA_SCRATCH", os.path.join(S, "test_out_ma"))
OUT = os.path.join(CAT, "cards") if REAL else SCRATCH
G = os.path.join(S, "gen")
os.makedirs(OUT, exist_ok=True)
KEY_NOTE = "subject: magenta-key -> alpha (key_subject.key_magenta warm_fix+edge_desat+drop_pink, band=4); scene: used as generated"

VARIANTS = {
    "night": dict(
        slug="中秋快樂", sources=("ma_bg2_p2.png", "ma_subject_f.png", "ma_subject_f_cut.png"),
        stats={"團圓": 100, "平安": 100, "健康": 100, "如意": 100},
        card=dict(
            subject=os.path.join(G, "ma_subject_f_cut.png"), scene=os.path.join(G, "ma_bg2_p2.png"),
            name="中秋快樂", eyebrow="HAPPY MID-AUTUMN · 2026", rarity="SSR", glyph="月", element="◐ 中秋 2026",
            holo="dust", h1=40, h2=228,
            skill_name="月圓人團圓", skill_en="Happy Mid-Autumn Festival",
            skill_desc="2026.09.25 中秋佳節，玉兔提燈送祝福：願你 **闔家團圓**、**平安健康**，"
                       "心想事成，事事 **圓滿如意**！",
            css={"BG_BLUR": "0.6", "SUBJ_WIDTH": "60%", "BG_BRIGHT": "1.04", "BG_SAT": "1.08", "BG_SCALE": "1.14",
                 "WARN_OP": ".26", "PAST_OP": ".22", "SUBJ_GLOW": "rgba(255,196,90,.5)"},
            notes=dict(generator="Gemini image API",
                       scene_model="gemini-3-pro-image", scene_prompt=gen_midautumn.PROMPTS["bg2"]["prompt"],
                       subject_model="gemini-3.1-flash-image", subject_prompt=gen_midautumn.PROMPTS["subject"]["prompt"],
                       reference_photo="none (text-to-image only)", postprocess=KEY_NOTE))),
    "day": dict(
        slug="中秋快樂_晝", sources=("ma_day_bg_p.png", "ma_day_subject_p.png", "ma_day_subject_p_cut.png"),
        stats={"幸福": 100, "順心": 100, "快樂": 100, "吉祥": 100},
        card=dict(
            subject=os.path.join(G, "ma_day_subject_p_cut.png"), scene=os.path.join(G, "ma_day_bg_p.png"),
            name="中秋快樂·晝", eyebrow="HAPPY MID-AUTUMN · 2026", rarity="SSR", glyph="晝", element="◑ 中秋 2026",
            holo="dust", h1=40, h2=205,
            skill_name="桂香待月", skill_en="Waiting for the Moonrise",
            skill_desc="中秋傍晚桂花飄香，玉兔捧著月餅、剝好文旦，等圓月升起：祝你 **佳節愉快**、"
                       "**幸福美滿**，好運 **月月圓**！",
            css={"BG_BLUR": "0.6", "SUBJ_WIDTH": "60%", "BG_BRIGHT": "1.2", "BG_SAT": "1.18", "BG_SCALE": "1.14",
                 "WARN_OP": ".18", "PAST_OP": ".15", "SUBJ_GLOW": "rgba(255,214,140,.45)"},
            notes=dict(generator="Gemini image API", pair="日夜配對：夜版為 中秋快樂_phantom_card.html",
                       scene_model="gemini-3-pro-image", scene_prompt=gen_midautumn.PROMPTS["day_bg"]["prompt"],
                       scene_reference="gen/ma_bg2_p2.png (night card scene, composition reference)",
                       subject_model="gemini-3-pro-image", subject_prompt=gen_midautumn.PROMPTS["day_subject"]["prompt"],
                       subject_reference="gen/ma_subject_f.png (night card rabbit, identity reference)",
                       postprocess=KEY_NOTE))),
    "change": dict(
        slug="嫦娥奔月", sources=("ma_change_bg_p2.png", "ma_change_subject_p2.png", "ma_change_subject_p2_cut.png"),
        stats={"長久": 100, "團圓": 100, "安康": 100, "如願": 100},
        card=dict(
            subject=os.path.join(G, "ma_change_subject_p2_cut.png"), scene=os.path.join(G, "ma_change_bg_p2.png"),
            name="嫦娥奔月", eyebrow="HAPPY MID-AUTUMN · 2026", rarity="UR", glyph="娥", element="☾ 中秋 2026",
            holo="dust", h1=45, h2=200,
            skill_name="但願人長久", skill_en="Sharing the Moon Afar",
            skill_desc="嫦娥懷抱玉兔飛向廣寒宮，桂影滿天。但願人長久，千里共嬋娟——祝你中秋 **月圓情圓**、"
                       "**心願皆圓**，與思念的人 **共賞明月**！",
            css={"BG_BLUR": "0.6", "SUBJ_WIDTH": "62%", "BG_BRIGHT": "1.04", "BG_SAT": "1.08", "BG_SCALE": "1.14",
                 "WARN_OP": ".22", "PAST_OP": ".18", "SUBJ_GLOW": "rgba(200,225,255,.45)"},
            notes=dict(generator="Gemini image API",
                       scene_model="gemini-3-pro-image", scene_prompt=gen_midautumn.PROMPTS["change_bg"]["prompt"],
                       subject_model="gemini-3-pro-image", subject_prompt=gen_midautumn.PROMPTS["change_subject"]["prompt"],
                       reference_photo="none (text-to-image only)",
                       postprocess="subject: magenta-key -> alpha (key_subject.key_magenta edge_desat; no drop_pink/warm_fix "
                                   "because the crimson sash is near magenta) + magenta despill on hue 260-335 "
                                   "(key_change.py); scene: used as generated"))),
    "bbq": dict(
        slug="中秋烤肉", sources=("ma_bbq_bg_p.png", "ma_bbq_bg_m2_a.png", "ma_bbq_subject_p2.png", "ma_bbq_subject_p2_cut.png"),
        stats={"歡聚": 100, "美味": 100, "熱鬧": 100, "好運": 100},
        card=dict(
            subject=os.path.join(G, "ma_bbq_subject_p2_cut.png"), scene=os.path.join(G, "ma_bbq_bg_m2_a.png"),
            name="中秋烤肉", eyebrow="HAPPY MID-AUTUMN · 2026", rarity="SSR", glyph="烤", element="♨ 中秋 2026",
            holo="embers", h1=25, h2=222,
            skill_name="月下烤肉香", skill_en="Moonlight BBQ",
            skill_desc="中秋夜頂樓升起炭火，玉兔戴上柚子帽顧著烤肉架：祝你 **家人齊聚**、**笑聲滿滿**，"
                       "日子 **香氣四溢**、紅紅火火！",
            css={"BG_BLUR": "0.6", "SUBJ_WIDTH": "58%", "BG_BRIGHT": "1.06", "BG_SAT": "1.08", "BG_SCALE": "1.06",
                 "WARN_OP": ".24", "PAST_OP": ".2", "SUBJ_GLOW": "rgba(255,150,60,.5)"},
            notes=dict(generator="Gemini image API",
                       scene_model="gemini-3-pro-image", scene_prompt=gen_midautumn.PROMPTS["bbq_bg"]["prompt"],
                       scene_edit_prompt=gen_midautumn.PROMPTS["bbq_bg_m2"]["prompt"],
                       scene_edit_note="moon moved lower via image edit of ma_bbq_bg_p.png so it is not hidden by the chip",
                       subject_model="gemini-3-pro-image", subject_prompt=gen_midautumn.PROMPTS["bbq_subject"]["prompt"],
                       subject_reference="gen/ma_subject_f.png (series rabbit, identity reference)",
                       postprocess=KEY_NOTE))),
    "lantern": dict(
        slug="天燈祈願", sources=("ma_lantern_bg_p2.png", "ma_lantern_bg_m2_a.png", "ma_lantern_subject_p2.png", "ma_lantern_subject_p2_cut.png"),
        stats={"祈福": 100, "平安": 100, "順遂": 100, "高升": 100},
        card=dict(
            subject=os.path.join(G, "ma_lantern_subject_p2_cut.png"), scene=os.path.join(G, "ma_lantern_bg_m2_a.png"),
            name="天燈祈願", eyebrow="HAPPY MID-AUTUMN · 2026", rarity="SSR", glyph="燈", element="✦ 中秋 2026",
            holo="dust", h1=32, h2=230,
            skill_name="天燈祈福", skill_en="Wishes to the Moon",
            skill_desc="點亮天燈，把心願寫上、送向圓月：祝你 **願望成真**、**平安順遂**，"
                       "前程 **步步高升**！",
            css={"BG_BLUR": "0.6", "SUBJ_WIDTH": "52%", "BG_BRIGHT": "1.06", "BG_SAT": "1.1", "BG_SCALE": "1.06",
                 "WARN_OP": ".24", "PAST_OP": ".2", "SUBJ_GLOW": "rgba(255,170,80,.5)"},
            notes=dict(generator="Gemini image API",
                       scene_model="gemini-3-pro-image", scene_prompt=gen_midautumn.PROMPTS["lantern_bg"]["prompt"],
                       scene_edit_prompt=gen_midautumn.PROMPTS["lantern_bg_m2"]["prompt"],
                       scene_edit_note="moon moved lower via image edit of ma_lantern_bg_p2.png so it is not hidden by the chip",
                       subject_model="gemini-3-pro-image", subject_prompt=gen_midautumn.PROMPTS["lantern_subject"]["prompt"],
                       subject_reference="gen/ma_subject_f.png (series rabbit, identity reference)",
                       postprocess=KEY_NOTE))),
    "cake": dict(
        slug="月餅工坊", sources=("ma_cake_bg_p.png", "ma_cake_subject_p2.png", "ma_cake_subject_p2_cut.png"),
        stats={"甜蜜": 100, "團圓": 100, "豐盛": 100, "美滿": 100},
        card=dict(
            subject=os.path.join(G, "ma_cake_subject_p2_cut.png"), scene=os.path.join(G, "ma_cake_bg_p.png"),
            name="月餅工坊", eyebrow="HAPPY MID-AUTUMN · 2026", rarity="SSR", glyph="餅", element="◉ 中秋 2026",
            holo="dust", h1=35, h2=215,
            skill_name="餅圓人圓", skill_en="Fresh-baked Blessings",
            skill_desc="玉兔在工坊裡壓出一盤剛出爐的月餅，蛋黃、蓮蓉香氣滿屋：祝你 **甜甜蜜蜜**、"
                       "**團團圓圓**，生活 **餡料滿滿**！",
            css={"BG_BLUR": "0.6", "SUBJ_WIDTH": "58%", "BG_BRIGHT": "1.04", "BG_SAT": "1.08", "BG_SCALE": "1.06",
                 "WARN_OP": ".24", "PAST_OP": ".2", "SUBJ_GLOW": "rgba(255,180,90,.5)"},
            notes=dict(generator="Gemini image API",
                       scene_model="gemini-3-pro-image", scene_prompt=gen_midautumn.PROMPTS["cake_bg"]["prompt"],
                       subject_model="gemini-3-pro-image", subject_prompt=gen_midautumn.PROMPTS["cake_subject"]["prompt"],
                       subject_reference="gen/ma_subject_f.png (series rabbit, identity reference)",
                       postprocess=KEY_NOTE))),
    "pomelo": dict(
        slug="文旦飄香", sources=("ma_pomelo_bg_p.png", "ma_pomelo_subject_p2.png", "ma_pomelo_subject_p2_cut.png"),
        stats={"好運": 100, "保佑": 100, "清甜": 100, "平安": 100},
        card=dict(
            subject=os.path.join(G, "ma_pomelo_subject_p2_cut.png"), scene=os.path.join(G, "ma_pomelo_bg_p.png"),
            name="文旦飄香", eyebrow="HAPPY MID-AUTUMN · 2026", rarity="SSR", glyph="柚", element="❀ 中秋 2026",
            holo="dust", h1=72, h2=220,
            skill_name="柚來好運", skill_en="Pomelo of Good Fortune",
            skill_desc="中秋吃文旦，「柚」諧音「佑」，玉兔抱來果園裡最大的一顆：祝你 **好運柚柚來**、"
                       "**平安有保佑**，日子 **清甜又甘美**！",
            css={"BG_BLUR": "0.6", "SUBJ_WIDTH": "58%", "BG_BRIGHT": "1.06", "BG_SAT": "1.08", "BG_SCALE": "1.06",
                 "WARN_OP": ".24", "PAST_OP": ".2", "SUBJ_GLOW": "rgba(230,240,150,.45)"},
            notes=dict(generator="Gemini image API",
                       scene_model="gemini-3-pro-image", scene_prompt=gen_midautumn.PROMPTS["pomelo_bg"]["prompt"],
                       subject_model="gemini-3-pro-image", subject_prompt=gen_midautumn.PROMPTS["pomelo_subject"]["prompt"],
                       subject_reference="gen/ma_subject_f.png (series rabbit, identity reference)",
                       postprocess=KEY_NOTE))),
}

v = VARIANTS[next(a for a in sys.argv[1:] if a in VARIANTS)]
card = dict(v["card"], out_dir=OUT, overwrite=(not REAL))
fn = "%s_phantom_card.html" % v["slug"]

env = dict(os.environ, PYTHONIOENCODING="utf-8")
if REAL:
    env.pop("CARD_FX_META", None)
    mp = os.path.join(CAT, "card-fx", "cards_meta.json")
    cards_dir = os.path.join(CAT, "cards")
    snap = lambda: {f: hashlib.md5(open(os.path.join(cards_dir, f), "rb").read()).hexdigest()
                    for f in os.listdir(cards_dir) if os.path.isfile(os.path.join(cards_dir, f))}
    shutil.copy2(mp, os.path.join(S, "cards_meta.before_ma_%s.json" % v["slug"]))
    pre = snap()
else:
    mp = os.path.join(OUT, "meta_test.json")
    shutil.copy2(os.path.join(CAT, "card-fx", "cards_meta.json"), mp)
    env["CARD_FX_META"] = mp

pp = os.path.join(S, "params_%s.json" % v["slug"])
with open(pp, "w", encoding="utf-8") as f:
    json.dump(card, f, ensure_ascii=False, indent=2)
r = subprocess.run([PY, os.path.join(CAT, "card-maker", "make_card_layers.py"), "--params", pp],
                   capture_output=True, text=True, encoding="utf-8", env=env)
print(r.returncode, [l[:300] for l in r.stdout.splitlines() if '"done"' in l or '"error"' in l or "失敗" in l], r.stderr[-400:])

# 祝福卡：卡背四項數值改成祝福詞（fx.js 依 stats 的鍵名顯示），再重新注入 card-fx
with open(mp, encoding="utf-8") as f:
    meta = json.load(f)
meta[fn]["stats"] = v["stats"]
with open(mp, "w", encoding="utf-8", newline="\n") as f:
    f.write(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
r = subprocess.run([PY, os.path.join(CAT, "card-fx", "apply_fx.py"), os.path.join(OUT, fn)],
                   capture_output=True, text=True, encoding="utf-8", env=env)
print("apply_fx:", r.returncode, r.stdout[-300:], r.stderr[-300:])

if REAL:
    post = snap()
    print("changed existing:", [k for k in pre if post.get(k) != pre[k]])
    print("added:", [k for k in post if k not in pre])
    src = os.path.join(CAT, "card-maker", "output", v["slug"], "source")
    os.makedirs(src, exist_ok=True)
    for s_fn in v["sources"]:
        shutil.copy2(os.path.join(G, s_fn), src)
