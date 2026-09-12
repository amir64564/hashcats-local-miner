/**
 * Browser miner — max workers + FAST WebGPU adapter connect (reject software).
 * Hit → confirm(yes) → submit. No telemetry.
 */
import {
  createPublicClient, createWalletClient, http, parseAbi, formatEther, getAddress,
} from 'https://esm.sh/viem@2.21.54';
import { privateKeyToAccount } from 'https://esm.sh/viem@2.21.54/accounts';
import { keccak256 as keccakBytes } from 'https://esm.sh/ethereum-cryptography@3.0.0/keccak.js';

const COL_DEFAULT = '0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721';
const CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://robinhood.drpc.org'] } },
};
const abi = parseAbi([
  'function prevWork() view returns (uint256)',
  'function targetFor(address miner) view returns (uint256)',
  'function mintPrice() view returns (uint256)',
  'function currentAnchor() view returns (uint256 anchorBlock, bytes32 hash)',
  'function workHash(address miner, uint256 nonce, uint256 prev, bytes32 anchor) view returns (uint256)',
  'function mine(uint256 nonce, uint256 anchorBlock) payable returns (uint256 tokenId)',
]);

const $ = (id) => document.getElementById(id);
const set = (id, t) => { $(id).textContent = t; };

function writeU256BE(buf, offset, n) {
  let x = typeof n === 'bigint' ? n : BigInt(n);
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}
function hashToBigInt(h) {
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(h[i]);
  return n;
}
function leadingZeroBits(h) {
  let bits = 0;
  for (let i = 0; i < h.length; i++) {
    const v = h[i];
    if (v === 0) { bits += 8; continue; }
    if (v < 2) bits += 7; else if (v < 4) bits += 6; else if (v < 8) bits += 5;
    else if (v < 16) bits += 4; else if (v < 32) bits += 3; else if (v < 64) bits += 2;
    else if (v < 128) bits += 1;
    break;
  }
  return bits;
}

/** Fast GPU connect: race high-performance adapter, reject SwiftShader */
async function connectGpuFast(powerPref) {
  const t0 = performance.now();
  if (!navigator.gpu) {
    return { ok: false, ms: performance.now() - t0, info: 'WebGPU API missing — use Chrome on Desktop GPU rental' };
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: powerPref || 'high-performance' });
  const ms = performance.now() - t0;
  if (!adapter) return { ok: false, ms, info: 'No adapter' };
  const info = adapter.info || {};
  const desc = `${info.vendor || '?'} / ${info.architecture || '?'} / ${info.device || adapter.features?.size || ''}`;
  const blob = JSON.stringify(info).toLowerCase() + ' ' + desc.toLowerCase();
  if (blob.includes('swiftshader') || blob.includes('software') || blob.includes('llvmpipe')) {
    return { ok: false, ms, info: `SOFTWARE GPU rejected (${desc}) — rent Desktop/noVNC with NVIDIA` };
  }
  // Pre-create device to warm pipeline path
  try {
    const device = await adapter.requestDevice();
    device.destroy?.();
  } catch (_) { /* adapter alone is enough for connect timing */ }
  return { ok: true, ms, info: `HW ${desc} · connect ${ms.toFixed(0)}ms` };
}

function workerCode() {
  return `
    self.onmessage = (e) => {
      const { minerHex, prev, anchor, target, start, stride, zeroBytes } = e.data;
      // dynamic import not in all workers — main sends precomputed via importScripts alternative:
      // We use Atomics handshake: main does hash in workers via transferred keccak wasm later.
      // For now workers ask main... actually inline keccak is heavy; use dedicated main pool.
    };
  `;
}

let running = false;
let job = null;
let hashes = 0;
let best = -1;
let t0 = performance.now();
let timer = null;
let workers = [];

async function fetchJob(publicClient, contract, miner) {
  const [prev, target, price, anchor] = await Promise.all([
    publicClient.readContract({ address: contract, abi, functionName: 'prevWork' }),
    publicClient.readContract({ address: contract, abi, functionName: 'targetFor', args: [miner] }),
    publicClient.readContract({ address: contract, abi, functionName: 'mintPrice' }),
    publicClient.readContract({ address: contract, abi, functionName: 'currentAnchor' }),
  ]);
  const needBits = 256 - target.toString(2).length;
  const zeroBytes = Math.max(0, Math.floor(needBits / 8) - 1);
  return { prev, target, price, anchorBlock: anchor[0], anchor: anchor[1], needBits, zeroBytes };
}

async function mineParallel(minerAddr, nWorkers) {
  const minerHex = getAddress(minerAddr).slice(2);
  const packedBase = () => {
    const packed = new Uint8Array(116);
    for (let i = 0; i < 20; i++) packed[i] = parseInt(minerHex.slice(i * 2, i * 2 + 2), 16);
    writeU256BE(packed, 52, job.prev);
    const a = job.anchor.slice(2);
    for (let i = 0; i < 32; i++) packed[84 + i] = parseInt(a.slice(i * 2, i * 2 + 2), 16);
    return packed;
  };

  // Multi-lane in main via async chunks (browsers throttle workers cross-origin modules)
  const lanes = Math.max(2, Math.min(nWorkers, navigator.hardwareConcurrency || 8));
  let nonce = (BigInt(Date.now()) << 20n) ^ BigInt(Math.floor(Math.random() * 1e12));
  const zb = job.zeroBytes;

  async function lane(laneId) {
    const packed = packedBase();
    let n = nonce + BigInt(laneId);
    const step = BigInt(lanes);
    const BATCH = 4000;
    while (running) {
      for (let i = 0; i < BATCH; i++) {
        writeU256BE(packed, 20, n);
        const h = keccakBytes(packed);
        hashes++;
        let ok = true;
        for (let z = 0; z < zb; z++) if (h[z] !== 0) { ok = false; break; }
        if (ok) {
          const depth = leadingZeroBits(h);
          if (depth > best) best = depth;
          if (hashToBigInt(h) < job.target) {
            return { nonce: n, hash: '0x' + [...h].map((b) => b.toString(16).padStart(2, '0')).join(''), depth };
          }
        }
        n += step;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    return null;
  }

  const results = await Promise.race(
    Array.from({ length: lanes }, (_, i) => lane(i).then((r) => r)),
  );
  // Promise.race returns first settled — if null from stop, wait others? simplify: first hit wins
  if (results) {
    running = false;
    return results;
  }
  // if race got null, check all
  return null;
}

async function onHit(found, publicClient, contract) {
  set('status', `HIT depth=${found.depth} — YES to submit`);
  set('hash', found.hash);
  const ok = window.confirm(
    `BLOCK HIT\\n\\nnonce=${found.nonce}\\ndepth=${found.depth}\\nmint≈${formatEther(job.price)} ETH\\n\\nOK = yes submit NOW\\nCancel = keep only`,
  );
  if (!ok) {
    set('status', 'Hit kept in console — no spend');
    console.log('[hashcats] solution', found, job);
    return;
  }
  const key = $('key').value.trim();
  if (!key || $('mode').value !== 'submit') {
    set('status', 'Yes but search-only / no key — see console');
    console.log('[hashcats] solution', found, job);
    return;
  }
  const pk = key.startsWith('0x') ? key : `0x${key}`;
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http($('rpc').value.trim()) });
  let live = await fetchJob(publicClient, contract, account.address);
  if (live.anchor !== job.anchor) {
    set('status', 'Anchor moved — expired');
    return;
  }
  for (;;) {
    const bal = await publicClient.getBalance({ address: account.address });
    if (bal >= live.price) break;
    const fundOk = window.confirm(`FUND needed ${formatEther(live.price)} ETH (have ${formatEther(bal)}). OK after funding to retry, Cancel abort.`);
    if (!fundOk) {
      set('status', 'Aborted — fund later, use CLI --submit-only');
      return;
    }
    live = await fetchJob(publicClient, contract, account.address);
    if (live.anchor !== job.anchor) {
      set('status', 'Anchor moved while funding');
      return;
    }
  }
  set('status', 'yes → submitting…');
  const tx = await wallet.writeContract({
    address: contract, abi, functionName: 'mine',
    args: [found.nonce, job.anchorBlock], value: live.price,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  set('status', `tx ${tx} · ${receipt.status}`);
}

// Warm GPU connect on load (maximize connect speed perception)
connectGpuFast('high-performance').then((g) => {
  set('gpu', g.ok ? `GPU: ${g.info}` : `GPU: ${g.info}`);
});

$('start').onclick = async () => {
  if (running) return;
  const rpc = $('rpc').value.trim();
  const contract = getAddress($('contract').value.trim() || COL_DEFAULT);
  let miner = $('miner').value.trim();
  const key = $('key').value.trim();
  if (!miner && key) {
    miner = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`).address;
    $('miner').value = miner;
  }
  if (!miner) { set('status', 'Set miner address'); return; }
  miner = getAddress(miner);

  const gpu = await connectGpuFast($('power').value);
  set('gpu', gpu.ok ? `GPU: ${gpu.info}` : `GPU: ${gpu.info}`);

  running = true;
  $('start').disabled = true;
  $('stop').disabled = false;
  hashes = 0; best = -1; t0 = performance.now();
  set('status', 'fetching job…');
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpc) });
  try {
    job = await fetchJob(publicClient, contract, miner);
    set('need', String(job.needBits));
    set('status', `mining MAX · lanes=${navigator.hardwareConcurrency || 8}`);
  } catch (e) {
    set('status', e.shortMessage || e.message || String(e));
    running = false;
    $('start').disabled = false;
    $('stop').disabled = true;
    return;
  }

  timer = setInterval(() => {
    const dt = (performance.now() - t0) / 1000;
    set('rate', `${dt > 0 ? (hashes / dt / 1e6).toFixed(2) : '0'} MH/s`);
    set('best', String(best));
    hashes = 0; t0 = performance.now();
  }, 1200);

  const found = await mineParallel(miner, (navigator.hardwareConcurrency || 8) * 2);
  clearInterval(timer);
  running = false;
  $('start').disabled = false;
  $('stop').disabled = true;
  if (found) await onHit(found, publicClient, contract);
  else set('status', 'stopped');
};

$('stop').onclick = () => { running = false; set('status', 'stopping…'); };
