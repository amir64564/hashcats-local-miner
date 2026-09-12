# REPORT.md — Hashcats local miner status

**Date:** 2026-09-12  
**Repo:** https://github.com/amir64564/hashcats-local-miner  
**Local path:** `/workspace/hashcats-webgpu-miner`  
**Contract:** `0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721`  
**Chain:** Robinhood Chain · id **4663**

## What we built

Open-source local miner for [hashcats.fun](https://hashcats.fun):

| Piece | Role |
|-------|------|
| `mine.mjs` | Max-speed Node CLI: multi-thread keccak PoW, hit→fund→yes→submit |
| `miner.js` + `index.html` | Browser miner: fast WebGPU connect probe, rejects SwiftShader; search / yes-submit |
| `max-gpu-chrome.sh` | Launch Chrome with MAX GPU flags on Desktop rentals |
| `EASY_RENT.md` | Clore/Vast Desktop/noVNC steps |
| `rent-checklist.md` | One-screen connect checklist |
| `REDMI.md` | Redmi/Android honesty + fund-from-phone workflow |
| `REPORT.md` | This status report |

**Guarantees:** no telemetry, no auto-spend, no cheats — honest PoW only.

## Protocol

```
keccak256(abi.encodePacked(miner, nonce, prevWork, anchor)) < targetFor(miner)
```

On-chain helpers used: `prevWork`, `targetFor`, `mintPrice`, `currentAnchor`, `workHash`, `mine(nonce, anchorBlock)`.

CLI self-check compares local pack+keccak to `workHash` before mining.

## Wallet algorithm

1. Mine at max threads  
2. **HIT** → write `last-solution.json` + bell  
3. If balance &lt; `mintPrice` → prompt until funded (or abort); re-check anchor  
4. User types **`yes`** → re-verify `workHash` &lt; live target → `mine()` with value=`mintPrice`  
5. `--submit-only` resumes from `last-solution.json` after funding  

Never auto-spend. `--dry-run` / empty key = search-only.

## Hit odds honesty

- More honest hashrate ⇒ higher chance of finding a valid nonce; **never a guarantee**
- Difficulty ≈ `needBits` from `targetFor(miner)` (printed each report line)
- Phone / software WebGPU ⇒ very low MH/s ⇒ poor odds  
- Rented NVIDIA Desktop or strong multi-core CLI ⇒ better odds, still probabilistic  

## GPU rent path

1. Clore or Vast → **Desktop / noVNC + NVIDIA** (not Jupyter-only)  
2. `./max-gpu-chrome.sh` → `chrome://gpu` Hardware WebGPU  
3. Site miner and/or `node mine.mjs`  
4. Details: `EASY_RENT.md`, `rent-checklist.md`, `node mine.mjs --gpu-rent`

## Redmi path

- Phone = **search-only low MH/s** and/or **fund + approve** while rental mines  
- Real GH/s **not** available on Redmi alone — see `REDMI.md`

## Known failures

| Failure | Cause | Fix |
|---------|-------|-----|
| SwiftShader / software WebGPU | Jupyter-only or no GPU passthrough | Desktop/noVNC NVIDIA image; reject in `miner.js` |
| Anchor moved after HIT | Chain progressed | Re-mine; fund wait also re-checks anchor |
| Underfunded submit | balance &lt; mintPrice | Fund Robinhood Chain ETH → `--submit-only` or type yes after fund |
| Pack mismatch | Bug / wrong ABI pack | CLI exits with FATAL self-check |

## Key optimizations (mine.mjs)

- **Persistent worker pool** — workers reused across chain job updates (no terminate/respawn storm)
- **Optional SharedArrayBuffer progress** — Atomics hash/best counters cut IPC (`--no-sab` to disable)
- Fast leading-zero-byte reject before bigint compare  
- Default threads = `nproc * 3`  
- Faster job refresh (4s) to cut wasted hashes after chain move  
- `--gpu-rent` prints rental connect summary  

## How to run

```bash
npm i
HASHCATS_PRIVATE_KEY=0x… node mine.mjs --threads $(($(nproc)*3))
node mine.mjs --submit-only
node mine.mjs --dry-run
./max-gpu-chrome.sh          # on Desktop GPU rental
```

## Repo URL

https://github.com/amir64564/hashcats-local-miner
