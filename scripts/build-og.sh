#!/usr/bin/env bash
# Regenerates the committed social image and logo PNGs from the SVG sources.
# Needs librsvg (brew install librsvg). Run from anywhere; output is committed.
set -euo pipefail
cd "$(dirname "$0")/.."
rsvg-convert -w 1200 -h 630 brand/og-image.svg -o web/public/og.png
rsvg-convert -w 512 -h 512 web/public/favicon.svg -o web/public/logo.png
echo "wrote web/public/og.png (1200x630) and web/public/logo.png (512x512)"
