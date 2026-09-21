"""兩張營區照片主體：① 去掉文字/浮水印/介面圖示 → ② 隔離主體到洋紅底。
用法： python gen_subjects.py clean cabin tent     （步驟 1）
       python gen_subjects.py iso cabin tent       （步驟 2，吃步驟 1 的輸出）
金鑰只由 gem.py 從 settings.local.json 讀取，不印出。"""
import os, sys, time, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gem

SRC = os.path.join(HERE, "src")
GEN = os.path.join(HERE, "gen"); os.makedirs(GEN, exist_ok=True)
MODEL = os.environ.get("GEM_MODEL", "gemini-3.1-flash-image")

KEEP = ("Do NOT change, restyle, repaint, add or remove anything else. Keep every object, its colours, materials, "
        "proportions, lighting and small details exactly as in the photo.")

CLEAN = {
    "cabin": ("Edit this photo. Remove ALL overlaid graphics: the logo in the top-right corner, the yellow and white text "
              "banner along the bottom edge, the Chinese text label on the wooden wall, the row of pagination dots, and the "
              "arrow icons at the left and right edges. Fill each removed area naturally (wall planks, deck boards, sky) so "
              "the result looks like an untouched original photograph without any text or UI. " + KEEP +
              " Output the full frame at the same composition."),
    "tent": ("Edit this photo. Remove ALL overlaid graphics: the logo in the top-right corner, the large yellow text banner "
             "along the bottom edge, the letter-and-number label near the bottom centre, the pagination dots, and the arrow "
             "icon at the left edge. Fill each removed area naturally (ground, foliage, wooden platform) so the result "
             "looks like an untouched original photograph without any text or UI. " + KEEP +
             " Output the full frame at the same composition."),
}
ISO = {
    "cabin": ("Isolate the main subject of this photo as a clean game-asset style cut-out: the wooden cabin wall with its roof "
              "eave, door and window, the wooden deck platform in front of it, the two benches, the rabbit statues, the small "
              "mailbox props and the green mat. Replace the sky, mountains, trees, side railing and everything else outside "
              "the subject with ONE solid flat pure magenta background (#FF00FF), perfectly uniform, no gradient. "
              "The subject was cropped by the photo frame: finish the cropped edges (deck front edge, wall sides, roof) "
              "neatly and plausibly so the whole subject reads as one complete isolated object floating on the magenta, "
              "with a margin of magenta all around. No cast shadow on the background, no text. Keep the subject's colours, "
              "materials and details faithful to the photo."),
    "tent": ("Isolate the main subject of this photo as a clean game-asset style cut-out: the wooden platform with the dark "
             "and mustard-yellow dome tent, the folding table with its items, the chairs, the black equipment box, the "
             "awning, and the white projector screen on its stand at the right, each with only a thin natural strip of "
             "ground/path under it. Replace the trees, sky, foliage, fence and everything else outside the subject with "
             "ONE solid flat pure magenta background (#FF00FF), perfectly uniform, no gradient. The subject was cropped by "
             "the photo frame: finish the cropped edges neatly and plausibly so the whole subject reads as one complete "
             "isolated vignette floating on the magenta, with a margin of magenta all around. No cast shadow on the "
             "background, no text. Keep the subject's colours, materials and details faithful to the photo."),
}

if __name__ == "__main__":
    step, names = sys.argv[1], sys.argv[2:]
    for n in names:
        if step == "clean":
            refs, prompt, out, aspect = [os.path.join(SRC, n + ".png")], CLEAN[n], os.path.join(GEN, n + "_clean.png"), "3:2"
        else:
            refs, prompt, out, aspect = [os.path.join(GEN, n + "_clean.png")], ISO[n], os.path.join(GEN, n + "_iso.png"), "3:2"
        t = time.time()
        saved, text, err = gem.gen_image(MODEL, prompt, refs, out, aspect)
        print(n, step, "OK" if saved else "FAIL", "%.0fs" % (time.time() - t), (text or "")[:100],
              json.dumps(err, ensure_ascii=False)[:400] if err else "")
