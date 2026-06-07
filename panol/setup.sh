#!/usr/bin/env bash
# panol setup — installs everything needed to run `make analyze` / `make render`.
set -euo pipefail

cd "$(dirname "$0")"

say() { printf "\033[36m==>\033[0m %s\n" "$1"; }
ok()  { printf "\033[32m  ok\033[0m %s\n" "$1"; }

# 1. uv (Python package/runtime manager)
if ! command -v uv >/dev/null 2>&1; then
  say "installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  # make uv available in this shell session
  export PATH="$HOME/.local/bin:$PATH"
else
  ok "uv $(uv --version | awk '{print $2}')"
fi

# 2. tesseract OCR engine (required by pytesseract in analize.py)
if ! command -v tesseract >/dev/null 2>&1; then
  say "installing tesseract"
  if command -v brew >/dev/null 2>&1; then
    brew install tesseract
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y tesseract-ocr
  else
    echo "  !! could not auto-install tesseract — install it manually:" >&2
    echo "     macOS:  brew install tesseract" >&2
    echo "     linux:  sudo apt-get install tesseract-ocr" >&2
    exit 1
  fi
else
  ok "tesseract $(tesseract --version 2>&1 | head -1 | awk '{print $2}')"
fi

# 3. Python deps (opencv, pillow, numpy, pytorch, simple-lama-inpainting, ...)
say "syncing python dependencies (uv sync)"
uv sync
ok "deps installed"

# 4. working directories
mkdir -p analysis out
ok "analysis/ and out/ ready"

cat <<'EOF'

setup complete. Try:

  make meme IMG=images/images.jpeg CAPS=caps/leo.json

The LaMa inpainting model (~200MB) downloads automatically on the first render.
EOF
