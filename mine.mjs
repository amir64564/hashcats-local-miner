#!/usr/bin/env node
/**
 * Hashcats local miner — MAX hashrate + wallet: hit → yes → submit
 * Optimizations: persistent worker pool (reuse), optional SharedArrayBuffer progress.
 * No telemetry. Legitimate PoW only.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createInterface } from 'node:readline';
import { cpus } from 'node:os';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import {
  createPublicClient, createWalletClient, http, parseAbi, formatEther,
  getAddress, fallback,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const COL = '0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721';
const RPCS = [
  process.env.HASHCATS_RPC,
  'https://robinhood.drpc.org',
  'https://rpc.mainnet.chain.robinhood.com',
].filter(Boolean);

const CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: RPCS } },
};

const abi = parseAbi([
  'function workHash(address miner, uint256 nonce, uint256 prev, bytes32 anchor) view returns (uint256)',
  'function prevWork() view returns (uint256)',
  'function targetFor(address miner) view returns (uint256)',
  'function mintPrice() view returns (uint256)',
  'function currentAnchor() view returns (uint256 anchorBlock, bytes32 hash)',
  'function mine(uint256 nonce, uint256 anchorBlock) payable returns (uint256 tokenId)',
]);

function parseArgs(argv) {
  const ncpu = cpus().length || 4;
  const out = {
    // Aggressive default: 3× cores for max MH/s (CPU-bound keccak)
    threads: Math.max(1, Number(process.env.HASHCATS_THREADS) || ncpu * 3),
    dryRun: false,
    submitOnly: false,
    key: process.env.HASHCATS_PRIVATE_KEY || '',
    reportMs: 1500,
    refreshMs: 4000, // faster job refresh = less wasted hashes after chain move
    waitFund: true,
    // SharedArrayBuffer progress (default on; --no-sab to force postMessage)
    useSab: process.env.HASHCATS_NO_SAB !== '1',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--submit-only') out.submitOnly = true;
    else if (a === '--no-wait-fund') out.waitFund = false;
    else if (a === '--no-sab') out.useSab = false;
    else if (a === '--sab') out.useSab = true;
    else if (a === '--threads') out.threads = Math.max(1, Number(argv[++i]) || out.threads);
    else if (a === '--key') out.key = argv[++i];
    else if (a === '--gpu-rent' || a === '--help-rent') out.gpuRent = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function makeTransport() {
  return fallback(RPCS.map((url) => http(url, { retryCount: 5, retryDelay: 250, timeout: 12_000 })));
}

function writeU256BE(buf, offset, n) {
  let x = typeof n === 'bigint' ? n : BigInt(n);
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}

function leadingZeroBits(h) {
  let bits = 0;
  for (let i = 0; i < h.length; i++) {
    const v = h[i];
    if (v === 0) { bits += 8; continue; }
    if (v < 2) bits += 7;
    else if (v < 4) bits += 6;
    else if (v < 8) bits += 5;
    else if (v < 16) bits += 4;
    else if (v < 32) bits += 3;
    else if (v < 64) bits += 2;
    else if (v < 128) bits += 1;
    break;
  }
  return bits;
}

function hashToBigInt(h) {
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(h[i]);
  return n;
}

function askYes(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      const a = String(ans || '').trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared progress/control: Int32[0]=hash delta, [1]=bestDepth, [2]=active job gen
// Workers poll gen to abort without waiting for IPC; Atomics cuts progress IPC.
function makeProgressSab() {
  const sab = new SharedArrayBuffer(12);
  const view = new Int32Array(sab);
  Atomics.store(view, 0, 0);
  Atomics.store(view, 1, -1);
  Atomics.store(view, 2, 0);
  return { sab, view };
}

if (!isMainThread) {
  // HOT PATH — persistent worker: reuse across job updates (no respawn cost)
  const { workerIndex, stride, useSab } = workerData;
  const packed = Buffer.allocUnsafe(116);
  let sabView = null; // Int32Array: [0]=hashes, [1]=bestDepth
  let gen = 0; // job generation — ignore stale found after job swap

  function applyJob(job) {
    Buffer.from(job.minerHex, 'hex').copy(packed, 0);
    writeU256BE(packed, 52, BigInt(job.prev));
    Buffer.from(job.anchor.slice(2), 'hex').copy(packed, 84);
    return {
      targetBn: BigInt(job.target),
      zb: job.zeroBytes | 0,
      nonce: BigInt(job.startNonce),
      step: BigInt(stride),
      gen: job.gen,
    };
  }

  let state = null;
  let mining = false;
  let localHashes = 0;
  let localBest = -1;

  function yieldEventLoop() {
    return new Promise((r) => setImmediate(r));
  }

  async function mineLoop() {
    while (true) {
      while (!state) await sleep(5);
      const s = state;
      mining = true;
      localHashes = 0;
      localBest = -1;
      const targetBn = s.targetBn;
      const zb = s.zb;
      let nonce = s.nonce;
      const step = s.step;
      const myGen = s.gen;

      while (mining && state && state.gen === myGen) {
        writeU256BE(packed, 20, nonce);
        const h = keccak256(packed);
        localHashes++;

        let okPrefix = true;
        for (let i = 0; i < zb; i++) {
          if (h[i] !== 0) { okPrefix = false; break; }
        }
        if (okPrefix) {
          const depth = leadingZeroBits(h);
          if (depth > localBest) {
            localBest = depth;
            if (sabView) {
              let cur = Atomics.load(sabView, 1);
              while (depth > cur) {
                const prev = Atomics.compareExchange(sabView, 1, cur, depth);
                if (prev === cur) break;
                cur = prev;
              }
            }
          }
          if (hashToBigInt(h) < targetBn) {
            if (state && state.gen === myGen) {
              parentPort.postMessage({
                type: 'found',
                nonce: nonce.toString(),
                hash: '0x' + Buffer.from(h).toString('hex'),
                depth,
                gen: myGen,
              });
            }
            mining = false;
            break;
          }
        }
        nonce += step;

        // Flush every 64k hashes: responsive MH/s + yield for job reuse IPC
        if ((localHashes & 0xffff) === 0) {
          if (sabView) {
            Atomics.add(sabView, 0, localHashes);
            localHashes = 0;
            // SAB gen flag: parent bumped gen → abort without waiting for postMessage
            if (Atomics.load(sabView, 2) !== myGen) break;
          } else {
            parentPort.postMessage({ type: 'progress', hashes: localHashes, bestDepth: localBest });
            localHashes = 0;
          }
          // Yield so job/stop messages can be applied (worker reuse)
          await yieldEventLoop();
          if (!mining || !state || state.gen !== myGen) break;
        }
      }
      // Flush remaining hashes on job switch / stop
      if (localHashes && sabView) {
        Atomics.add(sabView, 0, localHashes);
        localHashes = 0;
      } else if (localHashes) {
        parentPort.postMessage({ type: 'progress', hashes: localHashes, bestDepth: localBest });
        localHashes = 0;
      }
      // Wait for next job if stopped mid-loop
      if (!state || state.gen !== myGen) {
        // spun out due to job change — loop continues with new state
        await yieldEventLoop();
      } else if (!mining) {
        // found or idle — wait for new job message
        state = null;
      }
    }
  }

  parentPort.on('message', (msg) => {
    if (msg.type === 'job') {
      if (msg.sab) {
        sabView = new Int32Array(msg.sab);
      } else {
        sabView = null;
      }
      gen = msg.gen;
      state = applyJob(msg);
      mining = true;
    } else if (msg.type === 'stop') {
      mining = false;
      state = null;
    } else if (msg.type === 'ping') {
      parentPort.postMessage({ type: 'pong', workerIndex });
    }
  });

  // Ready signal
  parentPort.postMessage({ type: 'ready', workerIndex });
  mineLoop().catch((e) => parentPort.postMessage({ type: 'error', message: e.message }));
} else {
  const args = parseArgs(process.argv);
  if (args.gpuRent) {
    console.log(`GPU rent (honest GH/s) — see EASY_RENT.md + rent-checklist.md

Quick path:
  1. Rent Clore/Vast **Desktop / noVNC** image with NVIDIA (NOT Jupyter)
  2. On the rental desktop: git clone → npm i → ./max-gpu-chrome.sh
  3. chrome://gpu → WebGPU must be Hardware accelerated (reject SwiftShader)
  4. Mine with site miner or: HASHCATS_PRIVATE_KEY=0x… node mine.mjs
  5. HIT → fund on phone if needed → type yes → submit

Redmi phone alone = search-only low MH/s (see REDMI.md).`);
    process.exit(0);
  }
  if (args.help) {
    console.log(`Hashcats MAX-speed local miner

  HASHCATS_PRIVATE_KEY=0x... node mine.mjs
  node mine.mjs --threads $(($(nproc)*3))
  node mine.mjs --submit-only          # after fund: yes→submit last-solution.json
  node mine.mjs --dry-run
  node mine.mjs --gpu-rent             # print GPU rental connect steps
  node mine.mjs --no-sab               # disable SharedArrayBuffer progress

Wallet: HIT → save → type yes → instant mine()
  Underfunded: waits/polls then re-asks yes (unless --no-wait-fund)

Workers are reused across chain updates (no respawn). Optional SAB progress
cuts IPC. Docs: EASY_RENT.md · REDMI.md · rent-checklist.md · REPORT.md

No telemetry.`);
    process.exit(0);
  }

  if (!args.key && !args.dryRun && !args.submitOnly) {
    console.error('Need HASHCATS_PRIVATE_KEY / --key (or --dry-run / --submit-only)');
    process.exit(1);
  }

  const publicClient = createPublicClient({ chain: CHAIN, transport: makeTransport() });
  let account = null;
  let walletClient = null;
  if (args.key) {
    const pk = args.key.startsWith('0x') ? args.key : `0x${args.key}`;
    account = privateKeyToAccount(pk);
    walletClient = createWalletClient({ account, chain: CHAIN, transport: makeTransport() });
  }
  const miner = account?.address || '0x1111111111111111111111111111111111111111';
  const minerHex = getAddress(miner).slice(2);

  async function withRetry(fn, label) {
    let last;
    for (let i = 0; i < 10; i++) {
      try { return await fn(); }
      catch (e) {
        last = e;
        console.error(`[hashcats] ${label} retry ${i + 1}: ${(e.shortMessage || e.message || '').slice(0, 90)}`);
        await sleep(300 * (i + 1));
      }
    }
    throw last;
  }

  async function fetchJob() {
    return withRetry(async () => {
      const [prev, target, price, anchor] = await Promise.all([
        publicClient.readContract({ address: COL, abi, functionName: 'prevWork' }),
        publicClient.readContract({ address: COL, abi, functionName: 'targetFor', args: [miner] }),
        publicClient.readContract({ address: COL, abi, functionName: 'mintPrice' }),
        publicClient.readContract({ address: COL, abi, functionName: 'currentAnchor' }),
      ]);
      const needBits = 256 - target.toString(2).length;
      const zeroBytes = Math.max(0, Math.floor(needBits / 8) - 1); // safe prefix filter
      return { prev, target, price, anchorBlock: anchor[0], anchor: anchor[1], needBits, zeroBytes };
    }, 'job');
  }

  async function submitSolution(sol, jobSnap) {
    if (!walletClient || !account) {
      console.error('[hashcats] no key — cannot submit');
      return 1;
    }
    // Loud wallet gate
    process.stdout.write('\n*** BLOCK HIT / SUBMIT READY ***\n');
    process.stdout.write('\x07'); // terminal bell

    let live = await fetchJob();
    if (live.anchor !== sol.anchor && live.anchor !== jobSnap?.anchor) {
      // compare stored
    }
    if (live.anchor !== sol.anchor) {
      console.error('[hashcats] anchor moved — hit expired. Re-mine.');
      return 4;
    }

    // Fund wait loop (wallet algo)
    for (;;) {
      const bal = await publicClient.getBalance({ address: account.address });
      const price = live.price;
      if (bal >= price) break;
      console.error(`[hashcats] FUND: need ${formatEther(price)} ETH · have ${formatEther(bal)}`);
      if (!args.waitFund) return 6;
      const again = await askYes('Fund wallet, then type yes to recheck (or no to abort): ');
      if (!again) {
        console.log('[hashcats] aborted — last-solution.json kept');
        return 0;
      }
      live = await fetchJob();
      if (live.anchor !== sol.anchor) {
        console.error('[hashcats] anchor moved while waiting — re-mine');
        return 4;
      }
    }

    const yes = await askYes('Type yes to SUBMIT NOW (spend mintPrice): ');
    if (!yes) {
      console.log('[hashcats] skipped — last-solution.json saved');
      return 0;
    }

    // Final validity: on-chain workHash
    const wh = await withRetry(
      () => publicClient.readContract({
        address: COL, abi, functionName: 'workHash',
        args: [miner, BigInt(sol.nonce), BigInt(sol.prev), sol.anchor],
      }),
      'workHash',
    );
    if (wh >= live.target) {
      console.error('[hashcats] solution no longer under target — re-mine');
      return 4;
    }

    console.log(`[hashcats] yes → mine(${sol.nonce}) value=${formatEther(live.price)} ETH`);
    const tx = await walletClient.writeContract({
      address: COL,
      abi,
      functionName: 'mine',
      args: [BigInt(sol.nonce), BigInt(sol.anchorBlock)],
      value: live.price,
    });
    console.log(`[hashcats] tx ${tx}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`[hashcats] status=${receipt.status} block=${receipt.blockNumber}`);
    return receipt.status === 'success' ? 0 : 5;
  }

  if (args.submitOnly) {
    if (!existsSync('last-solution.json')) {
      console.error('No last-solution.json');
      process.exit(1);
    }
    const sol = JSON.parse(readFileSync('last-solution.json', 'utf8'));
    console.log(`[hashcats] submit-only · miner=${miner}`);
    process.exit(await submitSolution(sol, null));
  }

  console.log(`[hashcats] MAX-speed miner · threads=${args.threads} · miner=${miner}`);
  console.log(`[hashcats] wallet: HIT → fund if needed → type yes → instant submit`);
  console.log(`[hashcats] workers: persistent reuse · progress=${args.useSab ? 'SharedArrayBuffer' : 'postMessage'}`);

  // self-check
  {
    const j0 = await fetchJob();
    const nonce = 777001n;
    const onchain = await withRetry(
      () => publicClient.readContract({ address: COL, abi, functionName: 'workHash', args: [miner, nonce, j0.prev, j0.anchor] }),
      'workHash',
    );
    const packed = Buffer.allocUnsafe(116);
    Buffer.from(minerHex, 'hex').copy(packed, 0);
    writeU256BE(packed, 20, nonce);
    writeU256BE(packed, 52, j0.prev);
    Buffer.from(j0.anchor.slice(2), 'hex').copy(packed, 84);
    if (onchain !== hashToBigInt(keccak256(packed))) {
      console.error('[hashcats] FATAL: pack mismatch');
      process.exit(2);
    }
    console.log(`[hashcats] self-check OK · ~${j0.needBits} bits · price=${formatEther(j0.price)} ETH · hits possible`);
  }

  let job = await fetchJob();
  let workers = [];
  let windowHashes = 0;
  let windowT0 = Date.now();
  let bestDepth = -1;
  let found = null;
  let stop = false;
  let jobGen = 0;
  let progressSab = null;
  let sabView = null;
  const workerFile = fileURLToPath(import.meta.url);

  function killWorkers() {
    for (const w of workers) {
      try { w.postMessage({ type: 'stop' }); } catch {}
      try { w.terminate(); } catch {}
    }
    workers = [];
  }

  function ensureProgressSab() {
    if (!args.useSab) {
      progressSab = null;
      sabView = null;
      return;
    }
    try {
      const p = makeProgressSab();
      progressSab = p.sab;
      sabView = p.view;
    } catch {
      console.warn('[hashcats] SharedArrayBuffer unavailable — falling back to postMessage');
      progressSab = null;
      sabView = null;
    }
  }

  function resetSabCounters() {
    if (!sabView) return;
    Atomics.store(sabView, 0, 0);
    Atomics.store(sabView, 1, -1);
  }

  function pushJobToWorkers() {
    jobGen++;
    found = null;
    resetSabCounters();
    if (sabView) Atomics.store(sabView, 2, jobGen);
    const base = (BigInt(Date.now()) << 32n) ^ BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    for (let i = 0; i < workers.length; i++) {
      workers[i].postMessage({
        type: 'job',
        gen: jobGen,
        minerHex,
        prev: job.prev.toString(),
        anchor: job.anchor,
        target: job.target.toString(),
        startNonce: (base + BigInt(i)).toString(),
        zeroBytes: job.zeroBytes,
        sab: progressSab || undefined,
      });
    }
    console.log(`[hashcats] mining @ MAX · ${workers.length} workers (reused) · zfilter=${job.zeroBytes} · gen=${jobGen}`);
  }

  async function spawnWorkerPool() {
    killWorkers();
    ensureProgressSab();
    const ready = [];
    for (let i = 0; i < args.threads; i++) {
      const w = new Worker(workerFile, {
        workerData: {
          workerIndex: i,
          stride: args.threads,
          useSab: !!progressSab,
        },
      });
      w.on('message', (msg) => {
        if (msg.type === 'ready') {
          ready.push(i);
        } else if (msg.type === 'progress') {
          windowHashes += msg.hashes;
          if (msg.bestDepth > bestDepth) bestDepth = msg.bestDepth;
        } else if (msg.type === 'found' && !found) {
          if (msg.gen !== jobGen) return; // stale
          found = msg;
          if (sabView) Atomics.store(sabView, 2, -1); // abort peers via SAB
          for (const ww of workers) {
            try { ww.postMessage({ type: 'stop' }); } catch {}
          }
        } else if (msg.type === 'error') {
          console.error('[worker]', msg.message);
        }
      });
      w.on('error', (e) => console.error('[worker]', e.message));
      workers.push(w);
    }
    // Wait briefly for ready signals (non-blocking soft wait)
    const tWait = Date.now();
    while (ready.length < args.threads && Date.now() - tWait < 3000) await sleep(10);
    pushJobToWorkers();
  }

  const report = setInterval(() => {
    if (sabView) {
      windowHashes += Atomics.exchange(sabView, 0, 0);
      const b = Atomics.load(sabView, 1);
      if (b > bestDepth) bestDepth = b;
    }
    const dt = (Date.now() - windowT0) / 1000;
    if (dt <= 0) return;
    const mhs = (windowHashes / dt / 1e6).toFixed(2);
    console.log(`[hashcats] ${mhs} MH/s · best=${bestDepth} · need~${job.needBits}`);
    windowHashes = 0;
    windowT0 = Date.now();
  }, args.reportMs);

  const refresher = setInterval(async () => {
    if (stop || found) return;
    try {
      const next = await fetchJob();
      if (next.prev !== job.prev || next.anchor !== job.anchor || next.target !== job.target) {
        console.log('[hashcats] chain moved — hot job swap (workers reused)');
        job = next;
        pushJobToWorkers();
      }
    } catch (e) {
      console.error('[hashcats] refresh', e.shortMessage || e.message);
    }
  }, args.refreshMs);

  await spawnWorkerPool();
  process.on('SIGINT', () => {
    stop = true;
    clearInterval(report);
    clearInterval(refresher);
    killWorkers();
    console.log('\n[hashcats] stopped');
    process.exit(0);
  });

  while (!found && !stop) await sleep(50);
  clearInterval(report);
  clearInterval(refresher);
  if (!found) {
    killWorkers();
    process.exit(0);
  }

  console.log('\n========== BLOCK HIT ==========');
  console.log(`nonce=${found.nonce}`);
  console.log(`depth=${found.depth}`);
  console.log(`hash=${found.hash}`);
  console.log(`mintPrice≈${formatEther(job.price)} ETH`);
  console.log('================================\n');

  const sol = {
    nonce: found.nonce,
    hash: found.hash,
    depth: found.depth,
    prev: job.prev.toString(),
    anchor: job.anchor,
    anchorBlock: job.anchorBlock.toString(),
    mintPriceWei: job.price.toString(),
    miner,
  };
  writeFileSync('last-solution.json', JSON.stringify(sol, null, 2));
  killWorkers();

  if (args.dryRun || !walletClient) {
    console.log('[hashcats] dry-run / no key — saved last-solution.json');
    process.exit(0);
  }

  process.exit(await submitSolution(sol, job));
}
