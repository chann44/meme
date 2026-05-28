from PIL import Image
import numpy as np
import argparse
import os


def detect_image_bounds(image, density_threshold=0.5, consecutive=5):
    """
    Detect tight bounding box of actual photo content —
    removes white caption area (top/bottom) and white margins (left/right).

    Text/UI rows and columns: dark_ratio 0.03–0.35 (sparse strokes on white)
    Actual photo rows and columns: dark_ratio 0.50–0.90 (varied real photography)
    """
    gray = np.array(image.convert("L"))
    n_rows, n_cols = gray.shape
    is_dark = gray < 240

    # --- vertical (top / bottom) ---
    row_ratio = np.mean(is_dark, axis=1)

    top = 0
    for i in range(n_rows - consecutive):
        if np.min(row_ratio[i:i + consecutive]) > density_threshold:
            top = i
            break

    bottom = n_rows
    for i in range(n_rows - 1, consecutive, -1):
        if np.min(row_ratio[i - consecutive:i]) > density_threshold:
            bottom = i
            break

    # --- horizontal (left / right) ---
    col_ratio = np.mean(is_dark, axis=0)

    left = 0
    for i in range(n_cols - consecutive):
        if np.min(col_ratio[i:i + consecutive]) > 0.1:
            left = i
            break

    right = n_cols
    for i in range(n_cols - 1, consecutive, -1):
        if np.min(col_ratio[i - consecutive:i]) > 0.1:
            right = i
            break

    return top, bottom, left, right


def extract_template(image_path, output_path=None, density_threshold=0.5, consecutive=5):
    image = Image.open(image_path)
    top, bottom, left, right = detect_image_bounds(image, density_threshold, consecutive)

    template = image.crop((left, top, right, bottom))

    if output_path is None:
        base = os.path.splitext(os.path.basename(image_path))[0]
        output_path = f"{base}_template.png"

    template.save(output_path)
    print(f"Template saved: {output_path}")
    print(f"  Original : {image.size[0]}x{image.size[1]}")
    print(f"  Cropped  : {template.size[0]}x{template.size[1]}")
    print(f"  Removed  : top={top}px  bottom={image.size[1]-bottom}px  left={left}px  right={image.size[0]-right}px")
    return template


def main():
    parser = argparse.ArgumentParser(
        description="Extract meme template — strips caption text and white margins on all four sides."
    )
    parser.add_argument("--file", required=True, help="Path to input meme image")
    parser.add_argument("--output", default=None, help="Output path (default: <input>_template.png)")
    parser.add_argument("--density", type=float, default=0.5,
                        help="Dark pixel density threshold for top/bottom detection (default: 0.5)")
    parser.add_argument("--rows", type=int, default=5,
                        help="Consecutive qualifying rows/cols to confirm boundary (default: 5)")
    args = parser.parse_args()
    extract_template(args.file, args.output, args.density, args.rows)


if __name__ == "__main__":
    main()