"""帳篷主體太寬 → 讓帳篷平台與投影幕靠攏成緊湊構圖（帳篷/投影幕本體保持不變）。"""
import os, sys, json, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import gem
GEN = os.path.join(HERE, "gen")
prompt = ("Recompose this isolated cut-out into a compact arrangement. Keep the dark and mustard-yellow dome tent, the wooden "
          "platform, the folding table, chair, black box, awning and the white projector screen on its tripod EXACTLY as they "
          "look now (same colours, materials, details, no redesign). Only change their placement: move the projector screen much "
          "closer, standing right beside the wooden platform on the right, slightly larger than now, so the tent and the screen "
          "together fill a compact, roughly 4:3 area. Keep the same solid flat pure magenta background (#FF00FF), perfectly "
          "uniform, with a margin of magenta all around, no cast shadow on the background, no text.")
t = time.time()
saved, text, err = gem.gen_image(os.environ.get("GEM_MODEL", "gemini-3.1-flash-image"), prompt,
                                 [os.path.join(GEN, "tent_iso.png"), os.path.join(GEN, "tent_clean.png")],
                                 os.path.join(GEN, "tent_iso2.png"), "4:3")
print("OK" if saved else "FAIL", "%.0fs" % (time.time() - t), json.dumps(err, ensure_ascii=False)[:300] if err else "")
