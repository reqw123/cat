"""Gemini 圖像 API 小工具：金鑰只從 ~/.claude/settings.local.json 的 env 區塊讀，絕不印出。"""
import base64, json, os, sys, urllib.request, urllib.error

SETTINGS = os.path.join(os.path.expanduser("~"), ".claude", "settings.local.json")
BASE = "https://generativelanguage.googleapis.com/v1beta"


def get_key():
    with open(SETTINGS, encoding="utf-8") as f:
        return json.load(f)["env"]["GEMINI_API_KEY"]


def call(path, payload=None, timeout=240):
    req = urllib.request.Request(
        BASE + path,
        data=None if payload is None else json.dumps(payload).encode("utf-8"),
        headers={"x-goog-api-key": get_key(), "Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        return {"_http_error": e.code, "_body": body[:600]}


def gen_image(model, prompt, ref_paths=(), out_path=None, aspect=None):
    """文字＋參考圖 → 圖片。回傳 (存檔路徑或None, 文字說明, 原始錯誤或None)。"""
    parts = [{"text": prompt}]
    for p in ref_paths:
        mime = "image/png" if p.lower().endswith(".png") else "image/jpeg"
        with open(p, "rb") as f:
            parts.append({"inline_data": {"mime_type": mime, "data": base64.b64encode(f.read()).decode()}})
    cfg = {"responseModalities": ["TEXT", "IMAGE"]}
    if aspect:
        cfg["imageConfig"] = {"aspectRatio": aspect}
    res = call("/models/%s:generateContent" % model, {"contents": [{"parts": parts}], "generationConfig": cfg})
    if "_http_error" in res:
        return None, "", res
    text, saved = [], None
    for cand in res.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            if "text" in part:
                text.append(part["text"])
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and out_path and not saved:
                with open(out_path, "wb") as f:
                    f.write(base64.b64decode(inline["data"]))
                saved = out_path
    return saved, " ".join(text)[:300], (None if saved else res.get("promptFeedback") or res)


if __name__ == "__main__":
    if sys.argv[1:] == ["models"]:
        res = call("/models?pageSize=200")
        if "_http_error" in res:
            print("HTTP", res["_http_error"], res["_body"])
        else:
            names = [m["name"].split("/")[-1] for m in res.get("models", [])
                     if "generateContent" in m.get("supportedGenerationMethods", [])]
            print("key OK; generateContent models with 'image' in name:")
            print([n for n in names if "image" in n or "imagen" in n or "banana" in n])
            print("total generateContent models:", len(names))
