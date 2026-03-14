process.chdir('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node');
const { Barretenberg, Fr } = await import('/Users/austingriffith/clawd/zk-api-credits/packages/api-server/node_modules/@aztec/bb.js/dest/node/index.js');
const bb = await Barretenberg.new({ threads: 1 });
const result = await bb.poseidon2Hash([new Fr(123n)]);
console.log('type:', typeof result, result.constructor.name);
console.log('proto methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(result)));
console.log('toString:', result.toString());
// Fr is usually a Uint8Array or has a value property
console.log('instanceof Uint8Array:', result instanceof Uint8Array);
if (result.value) console.log('value:', result.value);
await bb.destroy();
