/**
 * Verify that the merkle path from the server produces the same root as the circuit expects
 */
process.chdir('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node');
const { Barretenberg, Fr } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node/index.js');

const bb = await Barretenberg.new({ threads: 1 });
const frToBigInt = (fr) => BigInt('0x' + Buffer.from(fr.value).toString('hex'));

// Use the commitment we just registered
const commitment = 59957791034626740334n; // approximate — get real one from contract

// Actually fetch from API
const pathRes = await fetch('https://backend.zkllmapi.com/health');
const health = await pathRes.json();
console.log('Server health:', JSON.stringify(health));

// Get tree data directly from chain
const { ethers } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/hardhat/node_modules/ethers/lib.esm/index.js');
const provider = new ethers.JsonRpcProvider('https://base-mainnet.g.alchemy.com/v2/8GVG8WjDs-sGFRr6Rm839');
const api = new ethers.Contract(
  '0x234d536e1623546F394707D6dB700f9c8CD29476',
  ['function getTreeData() view returns (uint256,uint256,uint256)'],
  provider
);
const [size, depth, root] = await api.getTreeData();
console.log('On-chain root:', root.toString());
console.log('Tree size:', size.toString());

// Get the last registered event to find actual commitment
const events = await provider.getLogs({
  address: '0x234d536e1623546F394707D6dB700f9c8CD29476',
  topics: ['0x7de7691ba02c3c903aa6686e4a566130f54d23b424ef7ab590f865a6027e1056'],
  fromBlock: 0n,
  toBlock: 'latest'
});
console.log('Events found:', events.length);
for (const e of events) {
  console.log('  commitment:', BigInt(e.topics[1] || e.data).toString().slice(0,20)+'...');
}

// Get merkle path for the last commitment
if (events.length > 0) {
  const lastEvent = events[events.length - 1];
  // Decode the commitment from event data
  const iface = new ethers.Interface(['event CreditRegistered(address indexed user, uint256 indexed index, uint256 commitment, uint256 newStakedBalance)']);
  const decoded = iface.parseLog(lastEvent);
  const realCommitment = decoded.args.commitment;
  console.log('\nLast commitment:', realCommitment.toString());
  
  // Fetch full tree — path computed locally so server never sees which commitment we're using
  const _treeRes = await fetch(`https://backend.zkllmapi.com/tree`);
  const _treeData = await _treeRes.json();
  const _leafIdx = _treeData.leaves.findIndex(l => l === realCommitment.toString());
  const _sib = [], _ind = [];
  let _ci = _leafIdx;
  for (let i = 0; i < 16; i++) {
    _sib.push(_leafIdx !== -1 && i < _treeData.depth ? _treeData.levels[i][_ci ^ 1] : _treeData.zeros[i]);
    _ind.push(_leafIdx !== -1 ? (_leafIdx >> i) & 1 : 0);
    _ci >>= 1;
  }
  const pathData = _leafIdx === -1
    ? { error: 'Commitment not found in tree' }
    : { leafIndex: _leafIdx, siblings: _sib, indices: _ind, root: _treeData.root, depth: _treeData.depth };
  console.log('Path data:', JSON.stringify(pathData).slice(0, 200));
  
  // Manually verify the root using Barretenberg Poseidon2
  if (!pathData.error) {
    const { siblings, indices } = pathData;
    let current = realCommitment;
    for (let i = 0; i < 16; i++) {
      const sibling = BigInt(siblings[i]);
      const idx = indices[i];
      let left, right;
      if (idx === 0) {
        left = current; right = sibling;
      } else {
        left = sibling; right = current;
      }
      const hashFr = await bb.poseidon2Hash([new Fr(left), new Fr(right)]);
      current = frToBigInt(hashFr);
    }
    console.log('\nComputed root (Barretenberg Poseidon2):', current.toString());
    console.log('On-chain root:', root.toString());
    console.log('Match:', current.toString() === root.toString() ? '✅ YES' : '❌ NO');
  }
}

await bb.destroy();
