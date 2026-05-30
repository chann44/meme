import sys
import json
import argparse
import cv2
import numpy as np
import pytesseract
from pytesseract import Output

from pannels import detect_panels

CONF = 40
OCR_MIN = 600    # upscale small panels so the short side reaches this many px


def _text_blocks(img):
    h, w = img.shape[:2]
    scale = max(1.0, OCR_MIN / min(h, w))      # upscale tiny panels for legible OCR
    ocr = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC) \
        if scale > 1.0 else img
    d = pytesseract.image_to_data(ocr, config="--psm 6", output_type=Output.DICT)
    lines = {}
    for i in range(len(d["text"])):
        if int(d["conf"][i]) < CONF or not d["text"][i].strip():
            continue
        key = (d["block_num"][i], d["par_num"][i], d["line_num"][i])
        lines.setdefault(key, []).append(i)

    line_entries = []
    for key, idxs in lines.items():
        x = min(d["left"][i] for i in idxs) / scale
        y = min(d["top"][i] for i in idxs) / scale
        x2 = max(d["left"][i] + d["width"][i] for i in idxs) / scale
        y2 = max(d["top"][i] + d["height"][i] for i in idxs) / scale
        words = [d["text"][i].strip() for i in idxs]
        line_entries.append({"block": key[0], "x": int(x), "y": int(y),
                             "x2": int(x2), "y2": int(y2),
                             "text": " ".join(words), "h": int(y2 - y)})

    blocks = {}
    for le in line_entries:
        blocks.setdefault(le["block"], []).append(le)

    out = []
    for les in blocks.values():
        les.sort(key=lambda l: l["y"])
        # Split into sub-blocks at large vertical gaps so far-apart text (e.g. a
        # top caption and a bottom caption) does not merge into one block whose
        # bbox spans the whole image — which would mask/inpaint everything between.
        groups = [[les[0]]]
        for prev, cur in zip(les, les[1:]):
            gap = cur["y"] - prev["y2"]
            if gap > max(cur["h"], 10) * 1.2:
                groups.append([cur])
            else:
                groups[-1].append(cur)
        for g in groups:
            x = min(l["x"] for l in g)
            y = min(l["y"] for l in g)
            x2 = max(l["x2"] for l in g)
            y2 = max(l["y2"] for l in g)
            out.append({
                "bbox": [x, y, x2 - x, y2 - y],
                "text": "\n".join(l["text"] for l in g),
                "lines": len(g),
                "font_px": int(np.median([l["h"] for l in g])),
            })
    return out


def analyze(path):
    img = cv2.imread(path)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    H, W = img.shape[:2]
    res = {"image": path, "width": W, "height": H, "panels": []}
    for pid, (x, y, w, h) in enumerate(detect_panels(img)):
        blks = _text_blocks(img[y:y + h, x:x + w])
        for b in blks:
            bx, by, bw, bh = b["bbox"]
            b["bbox"] = [bx + x, by + y, bw, bh]
            cy = by + bh / 2
            b["position"] = "top" if cy < h / 3 else "bottom" if cy > 2 * h / 3 else "middle"
        res["panels"].append({"id": pid, "bbox": [x, y, w, h], "text_blocks": blks})
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("-o", "--out", default=None)
    a = ap.parse_args()
    res = analyze(a.image)
    out = json.dumps(res, indent=2)
    if a.out:
        open(a.out, "w").write(out)
    else:
        print(out)


if __name__ == "__main__":
    main()