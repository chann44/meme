import cv2
import numpy as np

EPS = 8.0          # row/col is a "gutter" if its std < EPS (near-uniform color)
MIN_GUTTER = 3     # min gutter thickness in px
MIN_PANEL = 40     # min panel side in px

# --- edge-seam detection (borderless stitched panels, e.g. 2x2 meme grids) ---
SEAM_COVER = 0.55  # a seam's straight-line segments must cover >= this fraction of the span
MERGE_PX = 3       # co-linear segments within this many px count as one seam
MAX_DEPTH = 6      # recursion guard


def _find_gutter(std, mean):          # solid near-white/near-black gutter (comics)
    n = len(std)
    low = std < EPS
    bands, i = [], 0
    while i < n:
        if low[i]:
            j = i
            while j < n and low[j]:
                j += 1
            if j - i >= MIN_GUTTER:
                bands.append((i, j))
            i = j
        else:
            i += 1

    def solid(b):                      # gutter must be near-white or near-black
        m = mean[b[0]:b[1]].mean()
        return m < 40 or m > 215

    bands = [b for b in bands if solid(b) and b[0] >= MIN_PANEL and n - b[1] >= MIN_PANEL]
    if not bands:
        return None
    bands.sort(key=lambda b: abs((b[0] + b[1]) / 2 - n / 2))
    return bands[0]


def _seam_candidates(gray, axis):
    """Find borderless panel seams as long straight Hough lines.

    axis=0 -> horizontal seams (row positions); axis=1 -> vertical seams (cols).
    Text strokes are too short to form a full-span line, so requiring a single
    line that covers most of the span rejects captions while keeping real
    photo-stitch / comic-border dividers. Returns [(pos, coverage), ...].
    """
    n = gray.shape[axis]
    span = gray.shape[1 - axis]
    if n < MIN_PANEL * 2:
        return []
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=60,
                            minLineLength=int(0.3 * span), maxLineGap=12)
    if lines is None:
        return []

    cover = {}
    for x1, y1, x2, y2 in lines[:, 0]:
        if axis == 0 and abs(int(y2) - int(y1)) <= 2:        # horizontal segment
            pos, a, b = (y1 + y2) // 2, min(x1, x2), max(x1, x2)
        elif axis == 1 and abs(int(x2) - int(x1)) <= 2:      # vertical segment
            pos, a, b = (x1 + x2) // 2, min(y1, y2), max(y1, y2)
        else:
            continue
        if pos < MIN_PANEL or n - pos < MIN_PANEL:           # keep seams off the borders
            continue
        cover.setdefault(int(pos), np.zeros(span, bool))[a:b + 1] = True

    merged = {}
    for pos in sorted(cover):
        for q in merged:
            if abs(q - pos) <= MERGE_PX:
                merged[q] |= cover[pos]
                break
        else:
            merged[pos] = cover[pos].copy()
    return [(p, float(c.mean())) for p, c in merged.items() if c.mean() >= SEAM_COVER]


def _segments(positions, n):
    """Turn interior seam positions into contiguous [start, end) bands covering 0..n."""
    pts = [0] + sorted(positions) + [n]
    return [(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]


def _split(gray, x0, y0, depth=0):
    h, w = gray.shape
    if depth < MAX_DEPTH:
        # 1. solid near-white/black gutters (classic comics)
        if h >= MIN_PANEL * 2:
            cut = _find_gutter(gray.std(axis=1), gray.mean(axis=1))
            if cut:
                s, e = cut
                return _split(gray[:s], x0, y0, depth + 1) + _split(gray[e:], x0, y0 + e, depth + 1)
        if w >= MIN_PANEL * 2:
            cut = _find_gutter(gray.std(axis=0), gray.mean(axis=0))
            if cut:
                s, e = cut
                return _split(gray[:, :s], x0, y0, depth + 1) + _split(gray[:, e:], x0 + e, y0, depth + 1)
        # 2. borderless content seams: split into the grid both axes define
        rows = [p for p, _ in _seam_candidates(gray, 0)]
        cols = [p for p, _ in _seam_candidates(gray, 1)]
        if rows or cols:
            out = []
            for ys, ye in _segments(rows, h):
                for xs, xe in _segments(cols, w):
                    out += _split(gray[ys:ye, xs:xe], x0 + xs, y0 + ys, depth + 1)
            return out
    return [(x0, y0, w, h)]


def detect_panels(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return _split(gray, 0, 0)
