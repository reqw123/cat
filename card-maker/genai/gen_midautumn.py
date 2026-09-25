"""2026 中秋閃卡：場景（滿月庭園）＋主體（玉兔提燈）兩張獨立圖層。
用法：python gen_midautumn.py [bg|subject ...] [--pro] [--tag a]"""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gem

S = os.path.dirname(os.path.abspath(__file__))
G = os.path.join(S, "gen"); os.makedirs(G, exist_ok=True)
MODEL = "gemini-3-pro-image" if "--pro" in sys.argv else os.environ.get("GEM_MODEL", "gemini-3.1-flash-image")

KEY_BG = ("Solid flat pure magenta background (exactly #FF00FF), completely uniform, no gradient, no floor, "
          "no cast shadow onto the background, no glow or bloom spilling onto the background, no text, no border. "
          "The subject sits alone, fully inside the frame with a margin all around.")

PROMPTS = {
    "bg": dict(aspect="5:4", prompt=(
        "A rich, atmospheric, semi-realistic painterly illustration for the Mid-Autumn Festival night: "
        "an enormous luminous golden full moon rising in a deep indigo night sky with thin silver clouds, "
        "a classical Chinese garden in the foreground and midground: a curved stone arch bridge over a calm lotus pond "
        "that mirrors the moon, a red-pillared pavilion with upturned eaves on the right, strings of glowing red and "
        "amber paper lanterns, a blossoming osmanthus tree with tiny golden flowers drifting on the breeze at the left edge, "
        "distant misty mountains. Strong depth with clear foreground / midground / far layers, warm lantern light against "
        "cool blue moonlight. Leave the lower-centre area relatively calm (a subject will be placed there). "
        "No people, no animals, no text, no calligraphy, no logos, no borders.")),
    "bg2": dict(aspect="5:4", prompt=(
        "A rich, atmospheric, semi-realistic painterly illustration for the Mid-Autumn Festival night. "
        "COMPOSITION: an enormous luminous golden full moon placed in the UPPER-LEFT area of the sky (its centre about "
        "one quarter from the left edge and one fifth from the top), deep indigo night sky with thin silver clouds. "
        "Below: a classical Chinese garden: a curved stone arch bridge over a calm lotus pond that mirrors the moonlight, "
        "a red-pillared pavilion with upturned eaves and glowing red and amber paper lanterns on the right edge, "
        "a blossoming osmanthus tree with tiny golden flowers at the far left edge with petals drifting, distant misty "
        "mountains. Strong depth with clear foreground / midground / far layers, warm lantern light against cool blue "
        "moonlight. Keep the centre and lower-centre calm and uncluttered (a subject will be placed there). "
        "No people, no animals, no text, no calligraphy, no logos, no borders.")),
    "day_bg": dict(aspect="5:4", refs=["gen/ma_bg2_p2.png"], prompt=(
        "Use the reference image as the exact composition guide (same classical Chinese garden: stone arch bridge over "
        "the lotus pond in the centre, red-pillared two-storey pavilion with hanging lanterns on the right, blossoming "
        "osmanthus tree on the left, misty mountains behind, full moon in the upper-left). Repaint the SAME scene in the "
        "late afternoon of the Mid-Autumn Festival, golden hour: warm sunlight from the right raking across the garden, "
        "soft sky gradient from clear blue at the top to peach and gold near the mountains, a pale ivory full moon rising "
        "in the same upper-left position, the paper lanterns hung but unlit (red and amber paper catching the sunlight), "
        "bright golden osmanthus blossoms with petals drifting, lotus flowers open, sparkling pond reflections, "
        "light haze between the mountains. Same rich semi-realistic painterly style and depth as the reference. "
        "Keep the centre and lower-centre calm. No people, no animals, no text, no calligraphy, no logos, no borders.")),
    "day_subject": dict(aspect="1:1", refs=["gen/ma_subject_f.png"], prompt=(
        "Draw the SAME white Jade Rabbit character as in the reference (same face, fur, ear colour, proportions and "
        "painterly semi-realistic style) in a new daytime Mid-Autumn pose: sitting upright and holding one golden-brown "
        "mooncake with ornate embossed pattern in both front paws, looking happy. Beside it on a small round wooden tray: "
        "two more mooncakes and a peeled pomelo with its green-yellow rind opened like petals; the red rabbit-shaped "
        "paper lantern rests unlit on the ground next to the tray. Warm natural afternoon sunlight from the right. "
        "Compact grouping, three-quarter front view, bold readable silhouette, crisp clean outer edges. " + KEY_BG)),
    "change_bg": dict(aspect="5:4", prompt=(
        "A rich, atmospheric, semi-realistic painterly illustration of the Moon Palace (Guanghan Palace) of Chinese legend "
        "on Mid-Autumn night: an enormous luminous pale-gold full moon filling the upper-middle of the sky (about 60% of the "
        "image width, its lower edge near the vertical middle), soft glowing halo, deep blue night sky with a few stars. "
        "Below it, an endless sea of silver-blue clouds; rising from the clouds on the left and right, the elegant jade-white "
        "and gold palace roofs of the Moon Palace with upturned eaves and softly glowing lanterns, and a huge ancient cassia "
        "(osmanthus) tree with golden blossoms at one side. Drifting golden osmanthus petals and faint sparkles. "
        "Cool moonlight blue against warm gold accents, strong depth, dreamy but detailed. Keep the centre calm (a flying "
        "figure will be placed in front of the moon). No people, no animals, no text, no calligraphy, no logos, no borders.")),
    "change_subject": dict(aspect="1:1", prompt=(
        "Chang'e, the Chinese Moon Goddess, in the same rich semi-realistic painterly style as a premium collectible card: "
        "a graceful young woman flying upward toward the upper right, full body, serene gentle face, long black hair in an "
        "elegant high bun with gold hairpins and a small crescent-moon ornament. She wears fully covering, modest, flowing "
        "layered Tang-dynasty hanfu in white, pale ice-blue and gold with a deep red waist sash; a long silk ribbon (pibo) in "
        "pale blue and gold curls in loops CLOSE around her body (not spreading far). She cradles a small fluffy white "
        "jade rabbit in her arms. Soft moonlight rim light. Compact, bold readable silhouette that fits inside a square "
        "with margin, crisp clean outer edges, no motion blur, no glow halo. IMPORTANT: no pink, no purple, no magenta "
        "colours anywhere on the figure or clothing. " + KEY_BG)),
    "bbq_bg": dict(aspect="5:4", prompt=(
        "A rich, atmospheric, semi-realistic painterly illustration of a Taiwanese Mid-Autumn Festival night on a cosy "
        "apartment rooftop terrace: a large glowing golden full moon in the upper-left sky, deep blue night sky, the warm "
        "twinkling lights of a dense Taiwanese city skyline and mountains in the distance, strings of warm bulb lights "
        "zigzagging overhead, potted plants along the parapet, a low wooden table with a pile of pomelos, a teapot and "
        "cups, folding stools, faint wisps of barbecue smoke rising and catching the light, a few red paper lanterns. "
        "Warm cosy lights against cool blue night, strong depth with foreground / midground / far layers. Keep the "
        "centre and lower-centre calm (a subject will be placed there). No people, no animals, no text, no signs, "
        "no logos, no borders.")),
    "bbq_subject": dict(aspect="1:1", refs=["gen/ma_subject_f.png"], prompt=(
        "Draw the SAME white Jade Rabbit character as in the reference (same face, fur, ear colour, proportions and "
        "painterly semi-realistic style) at a Taiwanese Mid-Autumn barbecue: the rabbit wears a hat made from a "
        "green-yellow pomelo peel (Taiwanese tradition) between its ears, stands happily beside a small square tabletop "
        "charcoal grill and turns a skewer with one paw; on the grill: Taiwanese sausages, corn on the cob, shiitake "
        "mushrooms, green peppers and skewers of meat, glowing red-orange charcoal and a few small flames and sparks. "
        "Warm firelight on the rabbit. NO smoke. Compact grouping, three-quarter front view, bold readable silhouette, "
        "crisp clean outer edges. " + KEY_BG)),
    "lantern_bg": dict(aspect="5:4", prompt=(
        "A rich, atmospheric, semi-realistic painterly illustration of a Mid-Autumn night sky-lantern festival in a "
        "small old mountain town in a green valley in Taiwan: a narrow old railway track running through the village, "
        "old houses with warm windows, lush dark mountains on both sides, a river below. Hundreds of glowing warm "
        "orange, red and yellow sky lanterns rising into the deep blue night sky toward a large luminous full moon in "
        "the upper-left, their reflections shimmering on the river. Magical, hopeful mood, warm lantern glow against "
        "cool blue night, strong depth with foreground / midground / far layers. Keep the centre and lower-centre calm "
        "(a subject will be placed there). No people, no animals, no text on the lanterns, no signs, no logos, no borders.")),
    "lantern_subject": dict(aspect="1:1", refs=["gen/ma_subject_f.png"], prompt=(
        "Draw the SAME white Jade Rabbit character as in the reference (same face, fur, ear colour, proportions and "
        "painterly semi-realistic style) releasing a Taiwanese sky lantern: the rabbit stands on its hind legs, both front "
        "paws raised holding the bottom rim of a large red rectangular paper sky lantern (about twice the rabbit's height) "
        "that is just starting to lift off, glowing warmly from the small flame inside, with one large golden calligraphy "
        "character \"福\" painted on the front of the lantern. Looking up hopefully. Warm lantern light on the rabbit's "
        "face and fur. Compact grouping, three-quarter front view, bold readable silhouette, crisp clean outer edges, "
        "no glow halo spilling onto the background, no smoke. " + KEY_BG)),
    "bbq_bg_m": dict(aspect="5:4", refs=["gen/ma_bbq_bg_p.png"], prompt=(
        'Edit the reference image. Keep EVERYTHING exactly the same (composition, buildings, lights, lanterns, colours, style, framing) EXCEPT the full moon: remove it from its current position (fill that area with matching night sky and the string lights) and paint the same glowing golden full moon, slightly larger, with its centre at about 32% from the left edge and 32% from the top edge, fully visible and clear of the edges. No text, no borders.')),
    "lantern_bg_m": dict(aspect="5:4", refs=["gen/ma_lantern_bg_p2.png"], prompt=(
        'Edit the reference image. Keep EVERYTHING exactly the same (composition, buildings, lights, lanterns, colours, style, framing) EXCEPT the full moon: remove it from its current position (fill that area with matching night sky and floating sky lanterns) and paint the same glowing golden full moon, slightly larger, with its centre at about 80% from the left edge and 31% from the top edge, fully visible and clear of the edges. No text, no borders.')),
    "bbq_bg_m2": dict(aspect="5:4", refs=["gen/ma_bbq_bg_p.png"], prompt=(
        "Edit the reference image. Keep EVERYTHING the same (rooftop, table, stools, plants, lanterns, string lights, "
        "city, colours, style, framing) EXCEPT the moon. Remove the moon from the top-left corner (replace with plain "
        "night sky). Instead, paint a large glowing golden full moon RISING LOW in the sky: it sits just above the city "
        "buildings on the LEFT HALF of the image, its bottom edge touching the distant mountain ridge, clearly lower "
        "than the string lights at the top of the image, around one third from the left edge. No text, no borders.")),
    "lantern_bg_m2": dict(aspect="5:4", refs=["gen/ma_lantern_bg_p2.png"], prompt=(
        "Edit the reference image. Keep EVERYTHING the same (village, railway, river, mountains, sky lanterns, colours, "
        "style, framing) EXCEPT the moon. Remove the moon from the top-left corner (replace with night sky and a few "
        "small lanterns). Instead, paint a large glowing golden full moon RISING LOW in the sky on the RIGHT side of the "
        "image: its bottom edge just touching the mountain ridge on the right, clearly away from the top edge, about "
        "one fifth from the right edge, with a few sky lanterns drifting in front of it. No text, no borders.")),
    "cake_bg": dict(aspect="5:4", prompt=(
        "A rich, atmospheric, semi-realistic painterly illustration of a cosy traditional Chinese mooncake bakery workshop "
        "on Mid-Autumn night: warm wooden interior, shelves and walls hung with carved wooden mooncake moulds, stacked "
        "bamboo steamers, a brick oven with a warm orange glow, wooden trays of golden mooncakes cooling, jars of lotus "
        "paste and red bean, bags of flour, red paper lanterns hanging from the beams. On the LEFT side of the image, a "
        "large round moon-gate window, its centre about one third down from the top and one quarter from the left, "
        "through which a big glowing golden full moon is clearly visible in a deep blue night sky. Warm golden interior "
        "light against the cool moonlight window, strong depth. Keep the centre and lower-centre calm (a subject will be "
        "placed there). No people, no animals, no text, no signs, no logos, no borders.")),
    "cake_subject": dict(aspect="1:1", refs=["gen/ma_subject_f.png"], prompt=(
        "Draw the SAME white Jade Rabbit character as in the reference (same face, fur, ear colour, proportions and "
        "painterly semi-realistic style) as a little mooncake baker: wearing a small cream-white cloth apron, standing at "
        "a low wooden work block and pressing a carved wooden mooncake mould with both paws, looking proud and happy. "
        "Beside it: a round wooden tray of freshly baked golden-brown mooncakes with crisp embossed flower patterns, one "
        "cut in half showing a golden salted egg yolk inside lotus paste, and a small bowl of dough. Warm oven light on "
        "the rabbit. NO flour clouds, NO steam. Compact grouping, three-quarter front view, bold readable silhouette, "
        "crisp clean outer edges. " + KEY_BG)),
    "pomelo_bg": dict(aspect="5:4", prompt=(
        "A rich, atmospheric, semi-realistic painterly illustration of a Taiwanese pomelo orchard on Mid-Autumn night: "
        "rows of lush pomelo trees heavy with big round green-yellow pomelos, dark glossy leaves, a winding dirt path, "
        "bamboo baskets full of harvested pomelos, a small old farmhouse with warm windows in the distance, fireflies and "
        "soft mist between the trees, gentle hills. A big glowing golden full moon rising LOW in the sky on the RIGHT "
        "half of the image, just above the treetops, its centre about one third down from the top and one quarter from "
        "the right edge, fully visible. Cool moonlight blue with warm lantern-gold accents, strong depth with foreground "
        "/ midground / far layers. Keep the centre and lower-centre calm (a subject will be placed there). No people, "
        "no animals, no text, no signs, no logos, no borders.")),
    "pomelo_subject": dict(aspect="1:1", refs=["gen/ma_subject_f.png"], prompt=(
        "Draw the SAME white Jade Rabbit character as in the reference (same face, fur, ear colour, proportions and "
        "painterly semi-realistic style) hugging a giant Taiwanese wendan pomelo that is bigger than the rabbit itself: "
        "a round pear-shaped green-yellow pomelo with a short stem and two glossy leaves, the rabbit wraps both front "
        "paws around it and smiles cheerfully. Next to them a small round plate of peeled pomelo segments with pale "
        "yellow-white translucent flesh and a curl of peel. Soft moonlight rim light and warm light. Compact grouping, "
        "three-quarter front view, bold readable silhouette, crisp clean outer edges. " + KEY_BG)),
    "subject": dict(aspect="1:1", prompt=(
        "A single isolated Mid-Autumn Festival character vignette in a rich semi-realistic painterly style with crisp detail: "
        "an adorable fluffy white Jade Rabbit sitting upright, gentle expression, holding up a glowing traditional red "
        "rabbit-shaped paper lantern on a short bamboo stick, next to a small stack of golden-brown mooncakes with ornate "
        "embossed patterns on a little round wooden tray, and a sprig of golden osmanthus flowers. "
        "Warm golden-amber rim light as if lit by moonlight and the lantern. Three-quarter front view, bold readable "
        "silhouette, crisp clean outer edges, the rabbit's fur edges clean and defined. " + KEY_BG)),
}

if __name__ == "__main__":
    tag = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else ""
    names = [a for a in sys.argv[1:] if a in PROMPTS] or list(PROMPTS)
    for n in names:
        spec = PROMPTS[n]
        out = os.path.join(G, "ma_%s%s.png" % (n, ("_" + tag) if tag else ""))
        t = time.time()
        saved, text, err = gem.gen_image(MODEL, spec["prompt"], [os.path.join(S, r) for r in spec.get("refs", [])], out, spec["aspect"])
        print(n, MODEL, "OK" if saved else "FAIL", "%.0fs" % (time.time() - t), (text or "")[:120],
              json.dumps(err, ensure_ascii=False)[:500] if err else "", flush=True)
