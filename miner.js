// Dummy server biar Railway tidak SIGTERM
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Mining...')).listen(PORT);
require("dotenv").config();

const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)"
];

function requireEnv() {
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Isi RPC_URL dan PRIVATE_KEY di file .env dulu.");
    console.error("Contoh: cp .env.example .env lalu edit PRIVATE_KEY.");
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

async function main() {
  requireEnv();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log("Wallet:", wallet.address);
  console.log("Contract:", CONTRACT_ADDRESS);

  while (true) {
    const state = await contract.miningState();
    const difficulty = BigInt(state.difficulty.toString());
    const challenge = await contract.getChallenge(wallet.address);

    console.log("");
    console.log("Era:", state.era.toString());
    console.log("Reward:", ethers.formatUnits(state.reward, 18), "HASH");
    console.log("Difficulty:", difficulty.toString());
    console.log("Epoch:", state.epoch.toString());
    console.log("Challenge:", challenge);

    let nonce = randomNonce();

    while (true) {
      const hash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256"],
        [challenge, nonce]
      );

      const hashNum = BigInt(hash);

      if (hashNum < difficulty) {
        console.log("");
        console.log("FOUND nonce:", nonce.toString());
        console.log("Hash:", hash);

        try {
          const tx = await contract.mine(nonce);
          console.log("TX sent:", tx.hash);

          const receipt = await tx.wait();
          console.log("Success block:", receipt.blockNumber);
        } catch (err) {
          console.error("TX failed:", err.shortMessage || err.message);
        }

        break;
      }

      nonce++;

      if (nonce % 100000n === 0n) {
        process.stdout.write(".");
      }
    }
  }
}

main().catch((err) => {
  console.error(err.shortMessage || err.message || err);
  process.exit(1);
});
