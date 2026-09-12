#!/usr/bin/env node
/**
 * Hashcats local miner — MAX hashrate + wallet: hit → yes → submit
 * No telemetry. Legitimate PoW only.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createInterface } from 'node:readline';
import { cpus } from 'node:os';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
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
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--submit-only') out.submitOnly = true;
    else if (a === '--no-wait-fund') out.waitFund = false;
    else if (a === '--threads') out.threads = Math.max(1, Number(argv[++i]) || out.threads);
    else if (a === '--key') out.key = argv[++i];
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

if (!isMainThread) {
  // HOT PATH — minimize branches until near target
  const { minerHex, prev, anchor, target, startNonce, stride, zeroBytes } = workerData;
  const packed = Buffer.allocUnsafe(116);
  Buffer.from(minerHex, 'hex').copy(packed, 0);
  writeU256BE(packed, 52, BigInt(prev));
  Buffer.from(anchor.slice(2), 'hex').copy(packed, 84);
  const targetBn = BigInt(target);
  const zb = zeroBytes | 0;
  let nonce = BigInt(startNonce);
  const step = BigInt(stride);
  let hashes = 0;
  let bestDepth = -1;
  while (true) {
    writeU256BE(packed, 20, nonce);
    const h = keccak256(packed);
    hashes++;
    // Fast reject: if difficulty needs leading zero bytes, skip bigint when first bytes nonzero
    let okPrefix = true;
    for (let i = 0; i < zb; i++) {
      if (h[i] !== 0) { okPrefix = false; break; }
    }
    if (okPrefix) {
      const depth = leadingZeroBits(h);
      if (depth > bestDepth) bestDepth = depth;
      if (hashToBigInt(h) < targetBn) {
        parentPort.postMessage({
          type: 'found',
          nonce: nonce.toString(),
          hash: '0x' + Buffer.from(h).toString('hex'),
          depth,
        });
        break;
      }
    }
    nonce += step;
    // Progress less often → less IPC overhead → higher MH/s
    if ((hashes & 0x3ffff) === 0) {
      parentPort.postMessage({ type: 'progress', hashes, bestDepth });
      hashes = 0;
    }
  }
} else {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Hashcats MAX-speed local miner

  HASHCATS_PRIVATE_KEY=0x... node mine.mjs
  node mine.mjs --threads $(($(nproc)*3))
  node mine.mjs --submit-only          # after fund: yes→submit last-solution.json
  node mine.mjs --dry-run

Wallet: HIT → save → type yes → instant mine()
  Underfunded: waits/polls then re-asks yes (unless --no-wait-fund)

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

  function killWorkers() {
    for (const w of workers) { try { w.terminate(); } catch {} }
    workers = [];
  }

  function spawnWorkers() {
    killWorkers();
    found = null;
    const base = (BigInt(Date.now()) << 32n) ^ BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    for (let i = 0; i < args.threads; i++) {
      const w = new Worker(new URL(import.meta.url), {
        workerData: {
          minerHex,
          prev: job.prev.toString(),
          anchor: job.anchor,
          target: job.target.toString(),
          startNonce: (base + BigInt(i)).toString(),
          stride: args.threads,
          zeroBytes: job.zeroBytes,
        },
      });
      w.on('message', (msg) => {
        if (msg.type === 'progress') {
          windowHashes += msg.hashes;
          if (msg.bestDepth > bestDepth) bestDepth = msg.bestDepth;
        } else if (msg.type === 'found' && !found) {
          found = msg;
          killWorkers();
        }
      });
      w.on('error', (e) => console.error('[worker]', e.message));
      workers.push(w);
    }
    console.log(`[hashcats] mining @ MAX · ${args.threads} workers · zfilter=${job.zeroBytes}`);
  }

  const report = setInterval(() => {
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
        console.log('[hashcats] chain moved — hot restart');
        job = next;
        spawnWorkers();
      }
    } catch (e) {
      console.error('[hashcats] refresh', e.shortMessage || e.message);
    }
  }, args.refreshMs);

  spawnWorkers();
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
  if (!found) process.exit(0);

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

  if (args.dryRun || !walletClient) {
    console.log('[hashcats] dry-run / no key — saved last-solution.json');
    process.exit(0);
  }

  process.exit(await submitSolution(sol, job));
}
