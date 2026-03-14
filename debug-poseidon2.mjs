/**
 * Debug script: Compare Poseidon2 implementations
 * 
 * 1. bb.js poseidon2Hash (matches Noir by definition)
 * 2. On-chain LibPoseidon2 (via getTreeData from contract)
 * 3. poseidon-lite (what API server uses for Merkle tree)
 * 
 * Key insight to test: poseidon-lite's `poseidon2` is original Poseidon with 2 inputs,
 * NOT Poseidon2 (a different algorithm used by Noir/Barretenberg).
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import { createPublicClient, http, parseAbiItem, parseAbi } from 'viem';
import { base } from 'viem/chains';

// Change CWD for bb.js WASM
process.chdir('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node');

const { Barretenberg, Fr } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node/index.js');

// poseidon-lite (what the API server uses) - CJS
const poseidonLite = require('/Users/austingriffith/clawd/zk-api-credits/node_modules/poseidon-lite/index.js');
const poseidon2_lite = poseidonLite.poseidon2;

const CONTRACT = '0x234d536e1623546F394707D6dB700f9c8CD29476';
const RPC = 'https://base-mainnet.g.alchemy.com/v2/8GVG8WjDs-sGFRr6Rm839';

const client = createPublicClient({
  chain: base,
  transport: http(RPC),
});

console.log('=== POSEIDON2 DEBUG ===\n');

// ─── Step 1: Simple hash comparison ─────────────────────────
console.log('--- Step 1: Compare single hash(1, 2) ---');

const bb = await Barretenberg.new({ threads: 1 });

const bbHash = await bb.poseidon2Hash([new Fr(1n), new Fr(2n)]);
console.log('bb.js poseidon2Hash(1,2):', bbHash.toString());

const plHash = poseidon2_lite([1n, 2n]);
console.log('poseidon-lite poseidon2(1,2):', plHash.toString());

console.log('Match?', bbHash.toString() === plHash.toString());
console.log('');
console.log('NOTE: poseidon-lite\'s "poseidon2" is ORIGINAL Poseidon with 2 inputs.');
console.log('      bb.js poseidon2Hash is POSEIDON2 (different algorithm, used by Noir).');
console.log('      These are entirely different hash functions!');

// ─── Step 2: Get on-chain tree data ─────────────────────────
console.log('\n--- Step 2: On-chain tree data ---');

const ABI = parseAbi([
  'function getTreeData() view returns (uint256 size, uint256 depth, uint256 root)',
]);

try {
  const [size, depth, root] = await client.readContract({
    address: CONTRACT,
    abi: ABI,
    functionName: 'getTreeData',
  });
  console.log('On-chain size:', size.toString());
  console.log('On-chain depth:', depth.toString());
  console.log('On-chain root:', root.toString());

  // ─── Step 3: Fetch all commitments ───────────────────────
  console.log('\n--- Step 3: Fetch commitments from events ---');

  const events = await client.getLogs({
    address: CONTRACT,
    event: parseAbiItem(
      'event CreditRegistered(address indexed user, uint256 indexed index, uint256 commitment, uint256 newStakedBalance)'
    ),
    fromBlock: 0n,
  });

  const leaves = events
    .sort((a, b) => Number(a.args.index) - Number(b.args.index))
    .map(e => e.args.commitment);

  console.log('Commitments found:', leaves.length);
  leaves.forEach((l, i) => console.log(`  [${i}]: ${l.toString()}`));

  // ─── Step 4: Build LeanIMT with bb.js Poseidon2 ──────────
  console.log('\n--- Step 4: Build LeanIMT with bb.js Poseidon2 ---');

  const sideNodesBB = {};
  let bbTreeDepth = 0;
  let bbTreeSize = 0;

  async function bbInsert(leaf) {
    const index = bbTreeSize;
    let treeDepth = bbTreeDepth;
    
    if (2 ** treeDepth < index + 1) {
      treeDepth++;
    }
    bbTreeDepth = treeDepth;
    
    let node = leaf;
    for (let level = 0; level < treeDepth; level++) {
      if ((index >> level) & 1 === 1) {
        const h = await bb.poseidon2Hash([new Fr(sideNodesBB[level]), new Fr(node)]);
        node = BigInt(h.toString());
      } else {
        sideNodesBB[level] = node;
      }
    }
    
    bbTreeSize = index + 1;
    sideNodesBB[treeDepth] = node;
    return node;
  }

  let bbRoot;
  for (const leaf of leaves) {
    bbRoot = await bbInsert(leaf);
  }
  console.log('bb.js tree root:', bbRoot?.toString());
  console.log('Matches on-chain?', bbRoot?.toString() === root.toString());

  // ─── Step 5: Build LeanIMT with poseidon-lite ────────────
  console.log('\n--- Step 5: Build LeanIMT with poseidon-lite ---');

  const sideNodesPL = {};
  let plTreeDepth = 0;
  let plTreeSize = 0;

  function plInsert(leaf) {
    const index = plTreeSize;
    let treeDepth = plTreeDepth;
    
    if (2 ** treeDepth < index + 1) {
      treeDepth++;
    }
    plTreeDepth = treeDepth;
    
    let node = leaf;
    for (let level = 0; level < treeDepth; level++) {
      if ((index >> level) & 1 === 1) {
        node = poseidon2_lite([sideNodesPL[level], node]);
      } else {
        sideNodesPL[level] = node;
      }
    }
    
    plTreeSize = index + 1;
    sideNodesPL[treeDepth] = node;
    return node;
  }

  let plRoot;
  for (const leaf of leaves) {
    plRoot = plInsert(leaf);
  }
  console.log('poseidon-lite tree root:', plRoot?.toString());
  console.log('Matches on-chain?', plRoot?.toString() === root.toString());

  // ─── Step 6: Also try @zk-kit/lean-imt ─────────────────
  console.log('\n--- Step 6: @zk-kit/lean-imt with poseidon-lite ---');
  const { LeanIMT } = require('/Users/austingriffith/clawd/zk-api-credits/node_modules/@zk-kit/lean-imt');
  
  const zkKitTree = new LeanIMT((a, b) => poseidon2_lite([a, b]), leaves);
  console.log('zk-kit LeanIMT root:', zkKitTree.root.toString());
  console.log('Matches on-chain?', zkKitTree.root.toString() === root.toString());

  // ─── Summary ────────────────────────────────────────────
  console.log('\n=== SUMMARY ===');
  console.log('On-chain root (LibPoseidon2):  ', root.toString());
  console.log('bb.js Poseidon2 tree root:     ', bbRoot?.toString());
  console.log('poseidon-lite (orig Poseidon):  ', plRoot?.toString());
  console.log('zk-kit IMT (poseidon-lite):     ', zkKitTree.root.toString());
  console.log('');
  console.log('bb.js matches on-chain?        ', bbRoot?.toString() === root.toString());
  console.log('poseidon-lite matches on-chain?', plRoot?.toString() === root.toString());
  console.log('bb.js matches poseidon-lite?   ', bbRoot?.toString() === plRoot?.toString());
  console.log('');
  if (bbRoot?.toString() === root.toString()) {
    console.log('✅ On-chain LibPoseidon2 matches bb.js/Noir Poseidon2');
    console.log('   → Fix: Replace poseidon-lite in API server with bb.js poseidon2Hash');
  } else if (plRoot?.toString() === root.toString()) {
    console.log('⚠️  On-chain uses ORIGINAL Poseidon (not Poseidon2!)');
    console.log('   → The LibPoseidon2 contract is NOT actually Poseidon2-compatible');
    console.log('   → Fix: Redeploy contract with correct Poseidon2, or fix Noir circuit');
  } else {
    console.log('❌ NEITHER matches on-chain! Something else is wrong.');
    console.log('   → Possible: different IV, padding, or constant differences');
  }

} catch (err) {
  console.error('Error:', err);
}

await bb.destroy();
