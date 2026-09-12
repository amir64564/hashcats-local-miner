# REDMI.md — Run / assist Hashcats from a Redmi phone (honesty checklist)

## Short truth

| What | On Redmi (Brave/Chrome Android) |
|------|----------------------------------|
| Search-only mining in browser | **Works at low MH/s** (CPU / weak GPU). Useful for learning UI, **not** competing hashrate |
| Real GH/s / serious hit odds | **Does NOT work** on phone alone. Need rented Desktop GPU or a PC |
| Wallet fund / approve / type-yes flow | **Yes** — phone is good for funding + confirming spend while a rental mines |
| CLI `mine.mjs` in Termux | **Limited / often impractical** (CPU only, thermal throttle, battery). Optional |

## What you need

### Apps
- **Brave** or **Chrome** (Android) — for hashcats.fun wallet / fund / explorer
- **Rabby** or MetaMask (mobile) — only if you manage the same miner address on-chain; optional if you fund an address whose key lives on the rental
- **Termux** — optional for CLI; may be limited (no full Node GPU, storage prompts, background kill)
- Clore/Vast **noVNC in mobile browser** — to watch/control rented Desktop (awkward but possible)

### Network
- Stable Wi‑Fi preferred (RPC + noVNC are chatty)
- Robinhood Chain **4663** RPC must be reachable (e.g. `https://robinhood.drpc.org`)

### ETH on Robinhood Chain
- You need **ETH on chain id 4663** (Robinhood Chain), enough for `mintPrice()` + gas
- Bridging / withdrawing depends on your exchange — confirm you send to **Robinhood Chain**, not Ethereum mainnet by mistake
- Contract: `0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721`

### Private key safety
- Prefer: key only on the **rental/PC** running `mine.mjs`; phone only **sends ETH** to that address
- Never paste your key into random Telegram/Discord “helpers”
- Never commit `.env` / key into git (`last-solution.json` and `.env` are gitignored)
- On HIT, phone can fund; rental terminal asks you to type **`yes`** before `mine()` — no auto-spend

## Recommended split workflow (honest)

1. **Rent GPU Desktop/noVNC** (see EASY_RENT.md) — mine there  
2. **Redmi**: send Robinhood-Chain ETH to the miner address when HIT needs funds  
3. On rental: type `yes` (or `node mine.mjs --submit-only` after fund)  
4. Phone alone = search-only / monitoring — do **not** expect GH/s

## What works on phone (search-only)

- Open local `index.html` via a served page or the official site miner in Brave/Chrome
- Expect **low MH/s**, thermal throttle, screen-off pause
- Hit odds are honest but tiny vs rented GPU

## What does NOT work (real GH/s)

- Claiming phone WebGPU equals desktop NVIDIA
- Jupyter rentals opened only in phone browser (SwiftShader trap)
- Leaving Termux mining overnight as a “GH/s” strategy

## Termux notes (optional)

```bash
# If you insist on CLI on phone — expect low MH/s only
pkg install nodejs git
git clone https://github.com/amir64564/hashcats-local-miner.git
cd hashcats-local-miner && npm i
HASHCATS_PRIVATE_KEY=0x… node mine.mjs --threads 4
```

Android may kill background Node. Use rental for serious mining.
