require("dotenv").config();

const { ethers }  = require("ethers");
const http        = require("http");
const os          = require("os");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

// ─────────────────────────────────────────────────────────────────────────────
// WORKER THREAD
// ─────────────────────────────────────────────────────────────────────────────
if (!isMainThread) {
  const { keccak256 } = require("ethers");

  const { challenge, difficultyHex, startNonce } = workerData;
  const challengeBuf = Buffer.from(challenge.slice(2), "hex");
  const difficulty   = BigInt("0x" + difficultyHex);

  function packAndHash(nonce) {
    const buf = Buffer.alloc(64);
    challengeBuf.copy(buf, 0);
    let n = nonce;
    for (let i = 63; i >= 32; i--) {
      buf[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return BigInt(keccak256(buf));
  }

  let nonce    = BigInt(startNonce);
  let reported = 0n;
  const REPORT_EVERY = 10_000n; // kirim update tiap 10k hash

  while (true) {
    const hashNum = packAndHash(nonce);

    if (hashNum < difficulty) {
      parentPort.postMessage({ found: true, nonce: nonce.toString(), extra: Number(nonce - BigInt(startNonce) - reported) });
      break;
    }

    nonce++;

    if ((nonce - BigInt(startNonce)) % REPORT_EVERY === 0n) {
      parentPort.postMessage({ found: false, count: Number(REPORT_EVERY) });
      reported += REPORT_EVERY;
    }
  }
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN THREAD
// ─────────────────────────────────────────────────────────────────────────────

const NUM_CORES = os.cpus().length;

const START_TIME    = Date.now();
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

// Dummy HTTP server
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(
    `HASH256 Miner (${NUM_CORES} cores)\n` +
    `Uptime   : ${formatDuration(Date.now() - START_TIME)}\n` +
    `Hashrate : ${formatHashrate(currentHashrate)}\n` +
    `Total    : ${totalHashes.toLocaleString()} hashes\n` +
    `Found    : ${totalFound} nonces\n`
  );
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// Stats logger tiap 5 detik
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
    `Cores: ${NUM_CORES}`
  );
}, 5000);

const RPC_URL          = process.env.RPC_URL;
const PRIVATE_KEY      = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
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

    for (let i = 0; i < NUM_CORES; i++) {
      const startNonce = (
        BigInt(Math.floor(Math.random() * 1_000_000_000)) +
        BigInt(i) * 10_000_000_000n
      ).toString();

      const w = new Worker(__filename, {
        workerData: { challenge, difficultyHex, startNonce }
      });

      w.on("message", (msg) => {
        const count = msg.count || msg.extra || 0;
        windowHashes += count;
        totalHashes  += count;

        if (msg.found && !resolved) {
          resolved = true;
          workers.forEach(ww => ww.terminate());
          resolve(msg.nonce);
        }
      });

      w.on("error", reject);
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
  console.log(`Cores   : ${NUM_CORES} worker threads`);

  while (true) {
    const state      = await contract.miningState();
    const difficulty = BigInt(state.difficulty.toString());
    const challenge  = await contract.getChallenge(wallet.address);
    const difficultyHex = difficulty.toString(16).padStart(64, "0");

    console.log("-------------------------------------------");
    console.log("Era       :", state.era.toString());
    console.log("Reward    :", ethers.formatUnits(state.reward, 18), "HASH");
    console.log("Difficulty:", difficulty.toString());
    console.log("Epoch     :", state.epoch.toString());
    console.log("Challenge :", challenge);
    console.log("-------------------------------------------");
    console.log(`Mining dengan ${NUM_CORES} core...`);

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
