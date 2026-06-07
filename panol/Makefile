# panol — meme panel analyzer + caption renderer
#
# Pipeline:  analyze (detect panels + OCR text)  ->  render (inpaint old text, draw new captions)
#
# Quick start:
#   make setup                                  # install deps (uv + tesseract)
#   make meme IMG=images/images.jpeg CAPS=caps/leo.json
#
# Or step by step:
#   make analyze IMG=images/images.jpeg         # -> analysis/images.json
#   make render  IMG=images/images.jpeg CAPS=caps/leo.json   # -> out/out_images.png

# ---- configurable variables (override on the command line: make analyze IMG=...) ----
# IMG  = input image
# CAPS = captions JSON, shape {"0":"text","1":"..."}
# FONT = optional font override, e.g. FONT=/path/to/font.ttf
IMG  ?= images/images.jpeg
CAPS ?= caps/leo.json
FONT ?=

# ---- derived paths ----
NAME     := $(basename $(notdir $(IMG)))
ANALYSIS := analysis/$(NAME).json
OUT      := out/out_$(NAME).png

RUN      := uv run
FONT_ARG := $(if $(FONT),--font $(FONT),)

.DEFAULT_GOAL := help

.PHONY: help setup analyze render meme clean clean-all

help: ## Show this help
	@echo "panol — targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Variables:  IMG=$(IMG)  CAPS=$(CAPS)  FONT=$(if $(FONT),$(FONT),<auto>)"

setup: ## Install dependencies (runs setup.sh)
	./setup.sh

analyze: $(ANALYSIS) ## Detect panels + OCR text  -> analysis/<name>.json

$(ANALYSIS): $(IMG)
	@mkdir -p analysis
	$(RUN) analize.py $(IMG) -o $(ANALYSIS)
	@echo "wrote $(ANALYSIS)"

render: analyze ## Render captions onto the image  -> out/out_<name>.png
	@mkdir -p out
	$(RUN) reader.py $(ANALYSIS) $(CAPS) -o $(OUT) $(FONT_ARG)
	@echo "wrote $(OUT)"

meme: render ## Full pipeline: analyze then render in one shot
	@echo "done: $(IMG) + $(CAPS) -> $(OUT)"

clean: ## Remove generated output images
	rm -rf out/*.png

clean-all: clean ## Remove generated outputs AND analysis JSON
	rm -rf analysis/*.json
