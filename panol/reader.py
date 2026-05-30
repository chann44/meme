import os
import json
import argparse
import cv2
import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

PAD = 6
CAP_FRAC = 0.42   # caption strip height as a fraction of panel height
CAP_MIN = 30      # min caption strip height in px

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Impact.ttf",   # classic meme font
    "/Library/Fonts/Impact.ttf",
    "C:\\Windows\\Fonts\\impact.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]


def _font_path(override):
    if override:
        return override
    for c in FONT_CANDIDATES:
        if os.path.exists(c):
            return c
    raise SystemExit("no font found; pass --font /path/to/font.ttf")


_LAMA = None
_LAMA_DEVICE = "cpu"   # LaMa uses FFT convolutions; CPU is the reliable backend on Apple Silicon


def _lama():
    """Load the big-lama TorchScript model. The published checkpoint was traced on
    CUDA, so it must be loaded with an explicit map_location to run on this machine."""
    global _LAMA
    if _LAMA is None:
        from simple_lama_inpainting.utils import download_model
        url = os.environ.get(
            "LAMA_MODEL_URL",
            "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt",
        )
        path = os.environ.get("LAMA_MODEL") or download_model(url)
        model = torch.jit.load(path, map_location=_LAMA_DEVICE)
        model.eval().to(_LAMA_DEVICE)
        _LAMA = model
    return _LAMA


def _glyph_mask(gray):
    """Precise text-stroke mask: top-hat catches bright glyphs, black-hat catches dark
    outlines, so only the actual lettering is selected — not the background behind it."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    resp = cv2.max(cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, k),
                   cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, k))
    _, m = cv2.threshold(resp, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    return m


def _remove_text(img, analysis, extra=None):
    from simple_lama_inpainting.utils import prepare_img_and_mask

    H, W = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mask = np.zeros((H, W), np.uint8)

    def clamp(x, y, w, h):
        return max(x - PAD, 0), max(y - PAD, 0), min(x + w + PAD, W), min(y + h + PAD, H)

    # Detected text boxes are tight (one line each) -> fill the rectangle for a clean,
    # complete removal with no ghosting halo.
    for x, y, w, h in (b["bbox"] for p in analysis["panels"] for b in p["text_blocks"]):
        x0, y0, x1, y1 = clamp(x, y, w, h)
        if x1 > x0 and y1 > y0:
            cv2.rectangle(mask, (x0, y0), (x1, y1), 255, -1)
    # Speculative strips (hidden text OCR missed) span lots of real image -> mask only
    # the actual glyph strokes so grass/faces behind them are preserved.
    for x, y, w, h in (extra or []):
        x0, y0, x1, y1 = clamp(x, y, w, h)
        if x1 <= x0 or y1 <= y0:
            continue
        gm = cv2.dilate(_glyph_mask(gray[y0:y1, x0:x1]), np.ones((3, 3), np.uint8), iterations=2)
        mask[y0:y1, x0:x1] = cv2.max(mask[y0:y1, x0:x1], gm)
    if not mask.any():
        return img

    rgb = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    image_t, mask_t = prepare_img_and_mask(rgb, Image.fromarray(mask), _LAMA_DEVICE)
    with torch.inference_mode():
        out_t = _lama()(image_t, mask_t)
    res = np.clip(out_t[0].permute(1, 2, 0).detach().cpu().numpy() * 255, 0, 255).astype(np.uint8)
    out = cv2.cvtColor(res, cv2.COLOR_RGB2BGR)
    if out.shape[:2] != img.shape[:2]:                  # LaMa pads to a multiple of 8
        out = out[:img.shape[0], :img.shape[1]]
    # LaMa reconstructs the WHOLE image (softening it); keep original sharp pixels
    # and only take LaMa's fill inside the mask so nothing else gets blurred.
    keep = mask == 0
    out[keep] = img[keep]
    return out


def _wrap(draw, text, font, max_w):
    words = text.split()
    if not words:
        return text
    lines, cur = [], words[0]
    for w in words[1:]:
        if draw.textlength(cur + " " + w, font=font) <= max_w:
            cur += " " + w
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return "\n".join(lines)


def _caption_region(panel):
    """A consistent caption box: the bottom strip of the panel, same for every panel."""
    px, py, pw, ph = panel["bbox"]
    rh = min(max(CAP_MIN, int(ph * CAP_FRAC)), ph - 2 * PAD)
    return [px + PAD, py + ph - rh - PAD, pw - 2 * PAD, rh]


def _fit_from(draw, text, font_path, max_w, max_h, start):
    """Fit text starting at `start` px, shrinking only if it would overflow."""
    size = max(10, start)
    while size > 8:
        font = ImageFont.truetype(font_path, size)
        wrapped = _wrap(draw, text, font, max_w)
        sw = max(1, size // 15)
        bb = draw.multiline_textbbox((0, 0), wrapped, font=font, stroke_width=sw, align="center")
        if bb[2] - bb[0] <= max_w and bb[3] - bb[1] <= max_h:
            return font, wrapped, sw
        size -= 2
    font = ImageFont.truetype(font_path, 10)
    return font, _wrap(draw, text, font, max_w), 1


def _text_color(img, bbox):
    """Sample the original text's fill color (white vs black meme text)."""
    x, y, w, h = bbox
    crop = img[max(y, 0):y + h, max(x, 0):x + w].reshape(-1, 3)
    if crop.size == 0:
        return (255, 255, 255), (0, 0, 0)
    g = crop.mean(1)
    bright = int((g > 200).sum())
    dark = int((g < 55).sum())
    if dark > bright:                          # black text -> white outline
        return (0, 0, 0), (255, 255, 255)
    return (255, 255, 255), (0, 0, 0)          # white text -> black outline (default)


def _strip_coverage(panel, region):
    """Fraction of the caption strip already covered by detected text boxes."""
    rx, ry, rw, rh = region
    covered = 0
    for b in panel["text_blocks"]:
        x, y, w, h = b["bbox"]
        ix = max(0, min(x + w, rx + rw) - max(x, rx))
        iy = max(0, min(y + h, ry + rh) - max(y, ry))
        covered += ix * iy
    return covered / max(rw * rh, 1)


def _anchor(panel):
    """Caption placement is always the bottom strip (so it never covers the art), but
    the font SIZE and COLOR are inherited from the original detected text when present."""
    rx, ry, rw, rh = _caption_region(panel)
    a = {"region": [rx, ry, rw, rh], "max_w": rw, "max_h": rh,
         "center": (rx + rw / 2, ry + rh / 2),
         "left": rx, "right": rx + rw, "top": ry, "bot": ry + rh}
    blocks = panel["text_blocks"]
    if blocks:
        b = max(blocks, key=lambda b: b["bbox"][2] * b["bbox"][3])
        a.update(font_px=b["font_px"], color_bbox=b["bbox"])
    else:
        a.update(font_px=None, color_bbox=None)
    # Clear the whole strip unless real text already covers it (then it was removed
    # precisely). Catches hidden captions OCR missed and noise-only detections.
    a["clear"] = _strip_coverage(panel, [rx, ry, rw, rh]) < 0.12
    return a


def render(analysis, captions, out_path, font_path):
    img = cv2.imread(analysis["image"])
    orig = img.copy()                          # sample original colors before inpainting

    captioned = [p for p in analysis["panels"] if str(p["id"]) in captions]
    anchors = {str(p["id"]): _anchor(p) for p in captioned}
    strips = [a["region"] for p in captioned if (a := anchors[str(p["id"])])["clear"]]
    img = _remove_text(img, analysis, extra=strips)

    # One shared size across the image: median of the original detected sizes.
    detected = [a["font_px"] for a in anchors.values() if a["font_px"]]
    shared = int(np.median(detected)) if detected else None

    pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(pil)

    for pid, a in anchors.items():
        fill, stroke = _text_color(orig, a["color_bbox"]) if a["color_bbox"] else ((255, 255, 255), (0, 0, 0))
        start = int((shared or a["font_px"] or int(a["max_h"] * 0.5)) * 1.4)
        # keep the (shared) original size; shrink only if the new text overflows the strip
        font, wrapped, sw = _fit_from(draw, captions[pid], font_path, a["max_w"], a["max_h"], start)
        bb = draw.multiline_textbbox((0, 0), wrapped, font=font, stroke_width=sw, align="center")
        tw, th = bb[2] - bb[0], bb[3] - bb[1]
        tx = max(a["left"], min(int(a["center"][0] - tw / 2) - bb[0], a["right"] - tw))
        ty = max(a["top"], min(int(a["center"][1] - th / 2) - bb[1], a["bot"] - th))
        draw.multiline_text((tx, ty), wrapped, font=font, fill=fill,
                            stroke_width=sw, stroke_fill=stroke, align="center")

    cv2.imwrite(out_path, cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("analysis", help="analysis JSON from analyze.py")
    ap.add_argument("captions", help='JSON mapping panel id -> text, e.g. {"0":"hi","1":"bye"}')
    ap.add_argument("-o", "--out", default="out/out.png")
    ap.add_argument("--font", default=None)
    a = ap.parse_args()
    analysis = json.load(open(a.analysis))
    captions = json.load(open(a.captions))
    render(analysis, captions, a.out, _font_path(a.font))


if __name__ == "__main__":
    main()