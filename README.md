# Hashcats local miner (MAX speed + yes-to-submit)

Open-source PoW for [hashcats.fun](https://hashcats.fun) · Robinhood Chain (4663) · **no telemetry**.

Repo: https://github.com/amir64564/hashcats-local-miner

Contract: `0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721`

PoW: `keccak256(abi.encodePacked(miner, nonce, prevWork, anchor)) < targetFor(miner)`

## Wallet algorithm (fixed)
1. Mine at max threads (persistent worker pool)
2. **HIT** → save `last-solution.json` + terminal bell
3. If underfunded → prompt until funded (or abort)
4. Type **`yes`** → verify `workHash` still valid → **instant** `mine()` submit
5. Later: `node mine.mjs --submit-only` after you fund

Never auto-spend without `yes`. No cheats. No telemetry.

## Quick start (CPU / CLI — highest honest MH/s for this repo)
```bash
npm i
HASHCATS_PRIVATE_KEY=0x… node mine.mjs --threads $(($(nproc)*3))
# optional: --no-sab  if SharedArrayBuffer progress misbehaves
node mine.mjs --submit-only   # after fund
node mine.mjs --dry-run
node mine.mjs --gpu-rent      # print rental connect summary
```

## GPU rent (honest GH/s) — Desktop / noVNC only

**Do NOT use Jupyter-only rentals** (SwiftShader / software WebGPU → fake or tiny hashrate).

```bash
# 1) Rent on Clore or Vast: image = Desktop / noVNC / full Ubuntu desktop + NVIDIA
# 2) Open the rental Desktop (noVNC or RDP) — not a notebook
# 3) In a terminal on that desktop:
git clone https://github.com/amir64564/hashcats-local-miner.git
cd hashcats-local-miner && npm i
./max-gpu-chrome.sh                 # launches Chrome with MAX GPU flags
# 4) chrome://gpu → WebGPU must say Hardware accelerated (reject SwiftShader)
# 5) Mine on hashcats.fun/mine OR: HASHCATS_PRIVATE_KEY=0x… node mine.mjs
# 6) HIT → fund wallet (phone OK) → type yes → submit
```

One-screen checklist: **[rent-checklist.md](./rent-checklist.md)**  
Full Clore/Vast steps: **[EASY_RENT.md](./EASY_RENT.md)**  
Phone (Redmi) honesty: **[REDMI.md](./REDMI.md)**  
Status report: **[REPORT.md](./REPORT.md)**

Legitimate only: more MH/s = higher hit chance, **never a guarantee**.
