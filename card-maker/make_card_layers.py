#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""分層版卡片生成：場景圖（背景＋殘影）與去背主體是「兩張獨立的圖」，而不是同一張照片。

適用情境：兩層都是生圖 API 產出（或手工準備）時，例如「露營場景」＋「浮起的露營小物件」。
跟 make_card.py 共用同一份模板與所有函式（import make_card），輸出同架構的自包含 HTML
（360° 環轉、卡背、雙擊翻面、自動翻面、全息、card-fx、瘦身）。不修改 make_card.py。

用法：  python make_card_layers.py --params params.json
params.json 欄位：
  subject      去背主體 PNG（必須是真透明 RGBA；洋紅底生圖請先用 key 去背）— 必填
  scene        場景圖（不透明）— 必填
  name / eyebrow / skill_name / skill_en / skill_desc / element / glyph / rarity / holo / out_dir / overwrite
               同 make_card.py
  h1, h2       覆寫主色／副色相（度）。省略＝從主體自動分析
  css          覆寫模板欄位的 dict，例如 {"BG_BLUR": "2", "BG_BRIGHT": ".8", "WARN_OP": ".3"}
  notes        寫進 output/<slug>/provenance.json 的來源說明（生圖模型、提示詞…）
"""
import argparse
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import make_card as mc  # noqa: E402  (只 import，不會執行 main)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", required=True)
    args = ap.parse_args()
    with open(args.params, "r", encoding="utf-8") as f:
        raw = json.load(f)

    for key in ("subject", "scene"):
        if not raw.get(key) or not os.path.isfile(raw[key]):
            mc.fail("no_image", "找不到 %s 圖片：%s" % (key, raw.get(key)))
    rarity = (raw.get("rarity") or "SSR").upper()
    holo = raw.get("holo") or "auto"
    if holo not in mc.HOLO_KEYS:
        mc.fail("bad_param", "不認得的全息效果：%s" % holo)
    name = (raw.get("name") or "").strip() or os.path.splitext(os.path.basename(raw["subject"]))[0]
    p = {
        "name": name,
        "eyebrow": (raw.get("eyebrow") or "").strip(),
        "skill_name": (raw.get("skill_name") or "").strip() or "幻影殘響",
        "skill_en": (raw.get("skill_en") or "").strip() or "Phantom Echo",
        "skill_desc": (raw.get("skill_desc") or "").strip() or "在戰場留下一道時空殘影。",
        "element": (raw.get("element") or "").strip(),
        "glyph": (raw.get("glyph") or "").strip()[:2],
        "rarity": rarity if rarity in ("SR", "SSR", "UR", "LR") else "SSR",
        "holo": holo,
    }

    out_dir = os.path.abspath(raw.get("out_dir") or os.path.join(HERE, "..", "cards"))
    slug = mc.slugify(name)
    out_path = os.path.join(out_dir, "%s_phantom_card.html" % slug)
    if os.path.exists(out_path) and not raw.get("overwrite"):
        mc.fail("exists", "cards/%s_phantom_card.html 已經存在。換一個名稱，或設 overwrite。" % slug)

    mc.emit("stage", key="read", message="讀取主體與場景圖層…")
    subject_src = mc.load_image(raw["subject"])
    if not mc.has_real_alpha(subject_src):
        mc.fail("no_alpha", "主體圖沒有真透明（alpha）。洋紅底生圖請先去背再傳入。")
    scene_src = mc.load_image(raw["scene"]).convert("RGB")

    subject, bbox = mc.crop_to_bbox(subject_src)
    subject = mc.fit_max(subject, 900, 900)
    scene = mc.fit_max(scene_src, 1100, 1000)

    mc.emit("stage", key="palette", message="分析主色並推導配色…")
    pal = mc.analyze_palette(subject_src, scene)
    if raw.get("h1") is not None:
        pal["h1"] = float(raw["h1"]); pal["neutral"] = False
    if raw.get("h2") is not None:
        pal["h2"] = float(raw["h2"])

    cfg, holo_key, holo_extra = mc.build_config(p, pal, subject.size, bbox, scene.size)
    cfg["OBJ_POS"] = "50% 50%"                       # 場景本來就是為卡片窗口構圖的，置中即可
    for k, v in (raw.get("css") or {}).items():
        if k not in cfg:
            mc.fail("bad_param", "css 覆寫了不存在的模板欄位：%s" % k)
        cfg[k] = str(v)

    mc.emit("stage", key="render", message="組裝卡片 HTML…")
    buf = io.BytesIO()
    subject.save(buf, "PNG", optimize=True)
    subject_png = buf.getvalue()
    buf = io.BytesIO()
    scene.save(buf, "JPEG", quality=84)
    scene_jpg = buf.getvalue()
    html_text = mc.render(cfg, holo_key, holo_extra, subject_png, scene_jpg)

    try:                                              # 瘦身（同 make_card.py）
        sys.path.insert(0, os.path.join(HERE, "..", "card-slim"))
        import slim
        slim_text, _stats = slim.slim_html(html_text)
        problems = slim.check_html(slim_text)
        if problems:
            raise RuntimeError("；".join(problems))
        html_text = slim_text
    except Exception as e:  # noqa: BLE001
        print("卡片瘦身失敗（卡片仍可用，只是檔案比較大）：%s" % e, flush=True)

    try:                                              # card-fx（同 make_card.py）
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

    work = os.path.join(HERE, "output", slug)
    os.makedirs(work, exist_ok=True)
    with open(os.path.join(work, "subject.png"), "wb") as f:
        f.write(subject_png)
    with open(os.path.join(work, "scene.jpg"), "wb") as f:
        f.write(scene_jpg)
    with open(os.path.join(work, "config.json"), "w", encoding="utf-8") as f:
        json.dump(dict(params=p, holo=holo_key, palette=pal, tokens=cfg), f, ensure_ascii=False, indent=2)
    with open(os.path.join(work, "provenance.json"), "w", encoding="utf-8") as f:
        json.dump(raw.get("notes") or {}, f, ensure_ascii=False, indent=2)

    mc.emit("done", file=os.path.basename(out_path), path=out_path, sizeBytes=len(html_text.encode("utf-8")),
            holo=holo_key,
            palette=dict(c1=cfg["C1"], c2=cfg["C2"], c3=cfg["C3"], abyss=cfg["ABYSS"],
                         h1=round(pal["h1"]), h2=round(pal["h2"])),
            element=p["element"] or mc.element_for(pal["h1"], pal["neutral"]),
            glyph=p["glyph"] or mc.first_glyph(name))


if __name__ == "__main__":
    main()
