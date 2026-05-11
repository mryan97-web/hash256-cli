require("dotenv").config();

const { ethers } = require("ethers");
const http = require("http");

// ── Stats ─────────────────────────────────────────────────────────────────────
const START_TIME    = Date.now();
let totalHashes     = 0;
let totalFound      = 0;
let windowHashes    = 0;
let windowStart     = Date.now();
let currentHashrate = 0;
// ─────────────────────────────────────────────────────────────────────────────

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

// ── Dummy HTTP server ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(
    `HASH256 Miner\n` +
    `Uptime   : ${formatDuration(Date.now() - START_TIME)}\n` +
    `Hashrate : ${formatHashrate(currentHashrate)}\n` +
    `Total    : ${totalHashes.toLocaleString()} hashes\n` +
    `Found    : ${totalFound} nonces\n`
  );
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});
// ─────────────────────────────────────────────────────────────────────────────

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

function randomNonce() {
  return BigInt(Math.floor(Math.random() * 1_000_000_000));
}

// ── Mining dalam batch kecil agar event loop tidak terblok ───────────────────
// Setiap BATCH_SIZE hash, yield ke event loop supaya setInterval bisa jalan
const BATCH_SIZE = 50000;

function mineOneBatch(challenge, difficulty, nonce) {
  return new Promise((resolve) => {
    let i = 0;
    function step() {
      const end = Math.min(i + BATCH_SIZE, BATCH_SIZE * 1000); // max per step
      while (i < BATCH_SIZE) {
        const hash    = ethers.solidityPackedKeccak256(["bytes32", "uint256"], [challenge, nonce]);
        const hashNum = BigInt(hash);
        totalHashes++;
        windowHashes++;
        i++;

        if (hashNum < difficulty) {
          return resolve({ found: true, nonce, hash });
        }
        nonce++;
      }
      // Yield ke event loop, lanjut batch berikutnya
      resolve({ found: false, nonce });
    }
    setImmediate(step);
  });
}
// ─────────────────────────────────────────────────────────────────────────────

// Print stats tiap 10 detik
function startStatsLogger() {
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
      `Total: ${totalHashes.toLocaleString()} hashes | ` +
      `Found: ${totalFound} | ` +
      `Uptime: ${formatDuration(Date.now() - START_TIME)}`
    );
  }, 10000);
}

async function main() {
  requireEnv();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log("Wallet  :", wallet.address);
  console.log("Contract:", CONTRACT_ADDRESS);

  startStatsLogger();

  while (true) {
    const state      = await contract.miningState();
    const difficulty = BigInt(state.difficulty.toString());
    const challenge  = await contract.getChallenge(wallet.address);

    console.log("-------------------------------------------");
    console.log("Era       :", state.era.toString());
    console.log("Reward    :", ethers.formatUnits(state.reward, 18), "HASH");
    console.log("Difficulty:", difficulty.toString());
    console.log("Epoch     :", state.epoch.toString());
    console.log("Challenge :", challenge);
    console.log("-------------------------------------------");
    console.log("Mining...");

    let nonce = randomNonce();
    let found = false;

    while (!found) {
      const result = await mineOneBatch(challenge, difficulty, nonce);
      if (result.found) {
        found = true;
        totalFound++;
        console.log("FOUND nonce :", result.nonce.toString());
        console.log("Hash        :", result.hash);
        console.log("Total hashes:", totalHashes.toLocaleString());
        console.log("Hashrate    :", formatHashrate(currentHashrate));

        try {
          const tx = await contract.mine(result.nonce);
          console.log("TX sent     :", tx.hash);
          const receipt = await tx.wait();
          console.log("Success block:", receipt.blockNumber);
        } catch (err) {
          console.error("TX failed   :", err.shortMessage || err.message);
        }
      } else {
        nonce = result.nonce;
      }
    }
  }
}

main().catch((err) => {
  console.error(err.shortMessage || err.message || err);
  process.exit(1);
});
