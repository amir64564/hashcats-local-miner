# rent-checklist — one screen, easy GPU connect

**Image:** Desktop / noVNC + NVIDIA · **NOT** Jupyter-only

```
[ ] Rent Clore or Vast — NVIDIA + Desktop/noVNC
[ ] Open Desktop (noVNC), not a notebook
[ ] nvidia-smi -L          → real GPU listed
[ ] git clone https://github.com/amir64564/hashcats-local-miner.git
[ ] cd hashcats-local-miner && npm i
[ ] ./max-gpu-chrome.sh
[ ] chrome://gpu           → WebGPU: Hardware accelerated
[ ] Reject SwiftShader / llvmpipe / software
[ ] Start mine: site OR  HASHCATS_PRIVATE_KEY=0x… node mine.mjs
[ ] HIT → last-solution.json → fund if needed → type yes → submit
```

CLI help: `node mine.mjs --gpu-rent`  
Full guide: EASY_RENT.md · Phone: REDMI.md
