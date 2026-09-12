# Hashcats local miner (MAX speed + yes-to-submit)

Open-source PoW for [hashcats.fun](https://hashcats.fun) · Robinhood Chain · **no telemetry**.

## Wallet algorithm (fixed)
1. Mine at max threads  
2. **HIT** → save `last-solution.json` + bell  
3. If underfunded → prompt until funded (or abort)  
4. Type **`yes`** → verify `workHash` still valid → **instant** `mine()` submit  
5. Later: `node mine.mjs --submit-only` after you fund  

Never auto-spend without `yes`.

## Max mining / GPU connect speed
```bash
npm i
# CPU max (best for this open CLI)
HASHCATS_PRIVATE_KEY=0x… node mine.mjs --threads $(($(nproc)*3))

# On GPU rental Desktop/noVNC (NOT Jupyter):
./max-gpu-chrome.sh
# chrome://gpu must show WebGPU Hardware accelerated — reject SwiftShader
# Then use site miner OR this HTML page for search; CLI for yes→submit
```

Legitimate only: more MH/s = higher hit chance, never a guarantee. No cheats.

Contract: `0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721`
