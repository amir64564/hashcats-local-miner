#!/usr/bin/env bash
# Maximize WebGPU connect speed on a Desktop/noVNC rental (NOT Jupyter-only).
# Usage: ./max-gpu-chrome.sh [url]
set -euo pipefail

echo "[hashcats] === GPU rent connect helper ==="
echo "[hashcats] Prefer Clore/Vast Desktop/noVNC + NVIDIA — NOT Jupyter"
echo "[hashcats] Full steps: EASY_RENT.md · one-screen: rent-checklist.md"
echo

if command -v nvidia-smi >/dev/null 2>&1; then
  echo "[hashcats] NVIDIA devices:"
  nvidia-smi -L || true
else
  echo "[hashcats] WARN: nvidia-smi missing — WebGPU may be software/slow."
  echo "[hashcats]      Rent a Desktop image with NVIDIA passthrough."
fi

FLAGS=(
  --enable-unsafe-webgpu
  --enable-features=Vulkan,UseSkiaRenderer,WebGPUService
  --ignore-gpu-blocklist
  --disable-gpu-driver-bug-workarounds
  --enable-gpu-rasterization
  --enable-zero-copy
  --disable-background-timer-throttling
  --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows
  --disable-ipc-flooding-protection
  --no-first-run
  --no-default-browser-check
)

URL="${1:-https://hashcats.fun/mine}"
echo "[hashcats] target URL: $URL"

CHROME=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium-browser || command -v chromium || true)
if [[ -z "$CHROME" ]]; then
  echo "[hashcats] ERROR: Install Google Chrome on the rental desktop first."
  echo "  e.g. download .deb from google.com/chrome or: sudo apt install -y chromium-browser"
  exit 1
fi

LOG=/tmp/hashcats-chrome.log
echo "[hashcats] launching: $CHROME (MAX GPU flags)"
"$CHROME" "${FLAGS[@]}" --new-window "$URL" >"$LOG" 2>&1 &
echo "[hashcats] Chrome PID $! · log $LOG"
echo
echo "[hashcats] CHECKLIST:"
echo "  1) Open chrome://gpu  → WebGPU must be Hardware accelerated"
echo "  2) Reject SwiftShader / llvmpipe / software"
echo "  3) Connect wallet → max GPU / start mining"
echo "  4) Or CLI: HASHCATS_PRIVATE_KEY=0x… node mine.mjs"
echo "  5) HIT → fund if needed → type yes → submit (never auto-spend)"
