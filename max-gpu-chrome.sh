#!/usr/bin/env bash
# Maximize WebGPU connect speed on a Desktop/noVNC rental (NOT Jupyter-only).
set -euo pipefail
echo "[hashcats] checking NVIDIA…"
nvidia-smi -L || { echo "No NVIDIA — WebGPU will be slow/software. Prefer Desktop image with GPU."; }
FLAGS=(
  --enable-unsafe-webgpu
  --enable-features=Vulkan,UseSkiaRenderer,WebGPUService
  --ignore-gpu-blocklist
  --disable-gpu-driver-bug-workarounds
  --enable-gpu-rasterization
  --disable-background-timer-throttling
  --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows
)
URL="${1:-https://hashcats.fun/mine}"
echo "[hashcats] launching Chrome with MAX GPU flags → $URL"
# Prefer google-chrome / chromium
CHROME=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium-browser || command -v chromium || true)
if [[ -z "$CHROME" ]]; then
  echo "Install Google Chrome on the rental desktop first."
  exit 1
fi
"$CHROME" "${FLAGS[@]}" --new-window "$URL" >/tmp/hashcats-chrome.log 2>&1 &
echo "[hashcats] opened. Check chrome://gpu for WebGPU: Hardware accelerated"
echo "[hashcats] Reject SwiftShader. Then Connect wallet → max GPU slider → Start"
