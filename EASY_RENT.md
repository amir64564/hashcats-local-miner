# EASY_RENT — Clore / Vast Desktop + noVNC (honest GPU)

Goal: real NVIDIA WebGPU (or strong CPU CLI), **not** Jupyter SwiftShader.

## Why Desktop / noVNC (NOT Jupyter)

| Path | Result |
|------|--------|
| Jupyter / notebook-only rental | Often **SwiftShader / llvmpipe** → software WebGPU, tiny MH/s, looks “connected” but useless |
| Desktop / noVNC / full GUI + NVIDIA | Chrome can see real GPU → Hardware WebGPU → honest GH/s on site miner |
| This repo’s `mine.mjs` on any Linux box | CPU keccak workers — honest MH/s, no WebGPU required |

## Clore.ai (typical)

1. Create account → add credits.
2. Marketplace → filter **NVIDIA** GPU (RTX 3060+ recommended).
3. Choose image / template labeled **Desktop**, **Ubuntu Desktop**, **noVNC**, or **KDE/XFCE** — **avoid** pure JupyterLab-only images.
4. Rent → open **noVNC / Desktop** link (browser GUI).
5. Inside the desktop terminal:
   ```bash
   nvidia-smi -L          # must list a real GPU
   sudo apt update && sudo apt install -y git curl
   # install Node 20+ and Google Chrome if missing
   git clone https://github.com/amir64564/hashcats-local-miner.git
   cd hashcats-local-miner && npm i
   ./max-gpu-chrome.sh
   ```
6. In Chrome: open `chrome://gpu` → confirm **WebGPU: Hardware accelerated**.
7. Open https://hashcats.fun/mine **or** run CLI:
   ```bash
   HASHCATS_PRIVATE_KEY=0xYOUR_KEY node mine.mjs --threads $(($(nproc)*3))
   ```
8. On **HIT**: leave rental mining; fund wallet from phone if needed; type `yes` only when ready to spend.

## Vast.ai (typical)

1. Create account → add credits.
2. Search templates: **nvidia**, **desktop**, **novnc**, **ubuntu desktop**.
3. Pick instance with GPU + **Desktop/noVNC** entrypoint (not Jupyter-only).
4. Connect via the provided **noVNC** URL (or SSH + start desktop if template docs say so).
5. Same steps as Clore from `nvidia-smi` onward.
6. Optional: SSH for CLI-only mining (no browser needed for `mine.mjs`):
   ```bash
   ssh … 'cd hashcats-local-miner && HASHCATS_PRIVATE_KEY=0x… node mine.mjs'
   ```

## After connect (both)

- [ ] `nvidia-smi` shows GPU  
- [ ] `./max-gpu-chrome.sh` ran without “Install Google Chrome”  
- [ ] `chrome://gpu` → WebGPU Hardware accelerated (no SwiftShader)  
- [ ] Mining started; rate is not near-zero  
- [ ] Wallet algo: HIT → `last-solution.json` → fund → type **yes** → submit  

See also: [rent-checklist.md](./rent-checklist.md) · [REDMI.md](./REDMI.md)
