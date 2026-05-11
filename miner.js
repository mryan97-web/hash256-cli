require("dotenv").config();

const { ethers } = require("ethers");
const http       = require("http");
const os         = require("os");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

// ─────────────────────────────────────────────────────────────────────────────
// WORKER THREAD
// ─────────────────────────────────────────────────────────────────────────────
if (!isMainThread) {
  const { solidityPackedKeccak256 } = require("ethers");
  const { challenge, difficultyHex, startNonce } = workerData;
  const diffBig = BigInt("0x" + difficultyHex);

  let nonce   = BigInt(startNonce);
  let counter = 0;

  while (true) {
    const hash    = solidityPackedKeccak256(["bytes32", "uint256"], [challenge, nonce]);
    const hashBig = BigInt(hash);
    counter++;

    if (hashBig < diffBig) {
      parentPort.postMessage({ found: true, nonce: nonce.toString(), count: counter });
      break;
    }

    nonce++;

    if (counter % 5_000 === 0) {
      parentPort.postMessage({ found: false, count: 5_000 });
    }
  }
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN THREAD
// ─────────────────────────────────────────────────────────────────────────────

// Batasi max 4 worker agar tidak OOM/crash di Railway
const MAX_WORKERS = Math.min(os.cpus().length, 8);
const START_TIME  = Date.now();
let totalHashes     = 0;
let totalFound      = 0;
let windowHashes    = 0;
let windowStart     = Date.now();
let currentHashrate = 0;

function formatDuration(ms) {
  const s   = Math.floor(ms / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
}

function formatHashrate(hps) {
  if (hps >= 1_000_000) return (hps / 1_000_000).toFixed(2) + " MH/s";
  if (hps >= 1_000)     return (hps / 1_000).toFixed(2)     + " KH/s";
  return hps.toFixed(0) + " H/s";
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(
    `HASH256 Miner\n` +
    `Workers  : ${MAX_WORKERS}\n` +
    `Uptime   : ${formatDuration(Date.now() - START_TIME)}\n` +
    `Hashrate : ${formatHashrate(currentHashrate)}\n` +
    `Total    : ${totalHashes.toLocaleString()} hashes\n` +
    `Found    : ${totalFound} nonces\n`
  );
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

setInterval(() => {
  const now     = Date.now();
  const elapsed = (now - windowStart) / 1000;
  if (elapsed > 0) {
    currentHashrate = windowHashes / elapsed;
    windowHashes    = 0;
    windowStart     = now;
  }
  console.log(
    `[STATS] Hashrate: ${formatHashrate(currentHashrate)} | ` +
    `Total: ${totalHashes.toLocaleString()} | ` +
    `Found: ${totalFound} | ` +
    `Uptime: ${formatDuration(Date.now() - START_TIME)} | ` +
    `Workers: ${MAX_WORKERS}`
  );
}, 5000);

const RPC_URL          = process.env.RPC_URL;
const PRIVATE_KEY      = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochLoadLeft_)",
  "function mine(uint256 nonce)"
];

function requireEnv() {
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Isi RPC_URL dan PRIVATE_KEY di file .env dulu.");
    process.exit(1);
  }
  if (!PRIVATE_KEY.startsWith("0x")) {
    console.error("PRIVATE_KEY harus diawali 0x.");
    process.exit(1);
  }
}

function runWorkers(challenge, difficultyHex) {
  return new Promise((resolve, reject) => {
    const workers = [];
    let resolved  = false;

    for (let i = 0; i < MAX_WORKERS; i++) {
      const startNonce = (
        BigInt(Math.floor(Math.random() * 1_000_000_000)) +
        BigInt(i) * 10_000_000_000n
      ).toString();

      const w = new Worker(__filename, {
        workerData: { challenge, difficultyHex, startNonce }
      });

      w.on("message", (msg) => {
        const c = msg.count || 0;
        windowHashes += c;
        totalHashes  += c;

        if (msg.found && !resolved) {
          resolved = true;
          workers.forEach(ww => { try { ww.terminate(); } catch(_) {} });
          resolve(msg.nonce);
        }
      });

      w.on("error", (err) => {
        console.error("Worker error:", err.message);
        if (!resolved) reject(err);
      });

      workers.push(w);
    }
  });
}

async function main() {
  requireEnv();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log(`Wallet  : ${wallet.address}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Workers : ${MAX_WORKERS} threads`);

  while (true) {
    const state         = await contract.miningState();
    const difficulty    = BigInt(state.difficulty.toString());
    const challenge     = await contract.getChallenge(wallet.address);
    const difficultyHex = difficulty.toString(16).padStart(64, "0");

    console.log("-------------------------------------------");
    console.log("Era       :", state.era.toString());
    console.log("Reward    :", ethers.formatUnits(state.reward, 18), "HASH");
    console.log("Difficulty:", difficulty.toString());
    console.log("Epoch     :", state.epoch.toString());
    console.log("Challenge :", challenge);
    console.log("-------------------------------------------");
    console.log(`Mining dengan ${MAX_WORKERS} worker...`);

    const nonceFound = await runWorkers(challenge, difficultyHex);

    totalFound++;
    console.log("FOUND nonce :", nonceFound);
    console.log("Total hashes:", totalHashes.toLocaleString());
    console.log("Hashrate    :", formatHashrate(currentHashrate));

    try {
      const tx = await contract.mine(BigInt(nonceFound));
      console.log("TX sent     :", tx.hash);
      const receipt = await tx.wait();
      console.log("Success block:", receipt.blockNumber);
    } catch (err) {
      console.error("TX failed   :", err.shortMessage || err.message);
    }
  }
}

main().catch((err) => {
  console.error(err.shortMessage || err.message || err);
  process.exit(1);
});
