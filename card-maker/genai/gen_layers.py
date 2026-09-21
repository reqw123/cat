import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gem

S = os.path.dirname(os.path.abspath(__file__))
G = os.path.join(S, "gen"); os.makedirs(G, exist_ok=True)
MODEL = os.environ.get("GEM_MODEL", "gemini-3.1-flash-image")

KEY_BG = ("Solid flat pure magenta background (exactly #FF00FF), completely uniform, no gradient, no floor, "
          "no cast shadow onto the background, no text, no border. The object sits alone, fully inside the frame with a margin all around.")

PROMPTS = {
    "day_bg": dict(refs=["day.png"], aspect="5:4", prompt=(
        "Use the reference photo as the exact composition guide (wooden deck in the foreground, tall tree trunks on the left, "
        "a trail vanishing between conifers in the centre, wooden fence and small stone planter mid-ground, railing on the right). "
        "Repaint it as a rich, atmospheric, semi-realistic illustration of a mountain forest campsite in bright daytime: "
        "strong depth with clear foreground / midground / far background layers, volumetric sunbeams through the canopy, "
        "drifting pollen and soft haze between the far trees, dappled light on the deck boards, lush ferns and moss at the edges, "
        "a hint of blue sky. Warm greens and golds. Painterly but detailed. No people, no text, no logos, no borders.")),
    "day_subject": dict(refs=["day.png"], aspect="1:1", prompt=(
        "A single isolated camping still-life vignette in the same painterly semi-realistic style and warm daylight as the reference: "
        "a small olive-green canvas tent with its door tied open, a wooden folding camp chair beside it, a hanging enamel lantern on a "
        "short wooden post, a neat stack of firewood, and ferns, moss and wildflowers growing around the base. "
        "Three-quarter front view, bold readable silhouette, crisp clean outer edges, rich detail. " + KEY_BG)),
    "night_bg": dict(refs=["night.png"], aspect="5:4", prompt=(
        "Use the reference photo as the exact composition guide (wooden deck, tall trunks on the left wrapped in a string of warm bulbs, "
        "a trail in the centre, wooden fence and stone planter mid-ground, railing on the right, dark forest behind). "
        "Repaint it as a rich, atmospheric, semi-realistic illustration of a mountain forest campsite at night: "
        "deep blue-black forest, warm golden string lights glowing with soft bloom, fireflies, faint mist, a scattering of stars "
        "and a hint of moonlight through gaps in the canopy, warm light pooling on the deck boards with fallen leaves. "
        "Strong depth with clear foreground / midground / far layers. Painterly but detailed. No people, no text, no logos, no borders.")),
    "night_subject": dict(refs=["night.png"], aspect="1:1", prompt=(
        "A single isolated camping still-life vignette at night in the same painterly semi-realistic style as the reference: "
        "a small crackling campfire in a ring of stones with rising sparks, a glowing lantern, a small canvas tent lit warmly from inside "
        "with its door tied open, a wooden log seat, and a short string of warm bulbs draped between two posts. "
        "Three-quarter front view, bold readable silhouette, crisp clean outer edges, glowing details. " + KEY_BG)),
}

if __name__ == "__main__":
    names = sys.argv[1:] or list(PROMPTS)
    for n in names:
        spec = PROMPTS[n]
        out = os.path.join(G, n + ".png")
        t = time.time()
        saved, text, err = gem.gen_image(MODEL, spec["prompt"], [os.path.join(S, r) for r in spec["refs"]], out, spec["aspect"])
        print(n, "OK" if saved else "FAIL", "%.0fs" % (time.time() - t), (text or "")[:120], json.dumps(err, ensure_ascii=False)[:500] if err else "")
