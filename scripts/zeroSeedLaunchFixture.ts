// Generates tests/fixtures/zero-seed-launch/local-chain.json: logs and state
// that a local anvil chain actually emits for ZeroSeedLaunch launches created,
// claimed and transferred through ZeroSeedLaunchPeriphery, and swaps through
// the Base 0x03c8 Yul router runtime.
//
//   bun scripts/zeroSeedLaunchFixture.ts <evm-contracts checkout> [out.json]
//
// The checkout must be EkuboProtocol/evm-contracts at the pinned head, built
// with `forge build`. Core is the main (Q0.64) runtime the build produces, set
// at the canonical address; the router runtime is the checkout's Base fixture.
// Two instances, each an extension (mined CREATE2 salt carrying the call-point
// byte) plus its periphery, both deployed through the deterministic deployer:
//   native  quote address(0) (native ETH, always token0; launch is token1)
//   weth    quote 0xff..ff, the Base WETH9 runtime relocated (launch is token0)
// The native instance and its first launch share the deployment block, so a
// replay that starts one block late provably misses a launch.
//
// Nothing here leaves the machine: anvil runs locally with no fork URL.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  http,
  keccak256,
  numberToHex,
  pad,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";

const [evmContracts, outArg] = process.argv.slice(2);
if (!evmContracts)
  throw new Error("usage: zeroSeedLaunchFixture.ts <evm-contracts> [out]");
const OUT = resolve(
  outArg ?? "tests/fixtures/zero-seed-launch/local-chain.json",
);

const PORT = 18545 + (process.pid % 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31337;
const T0 = 1_800_000_000;

const CORE: Address = "0x00000000000014aA86C5d3c41765bb24e11bd701";
const ROUTER: Address = "0x03c8B90854b90AA22448b11e885F692972DA441C";
const CREATE2_FACTORY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
// beforeInitializePool (1) + beforeSwap (64) + beforeUpdatePosition (16)
const CALL_POINTS_BYTE = 0x51;
// anvil's default mnemonic, accounts 0..3
const TRADER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CREATOR: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FEE_RECIPIENT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const NEW_OWNER: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

const FEE_50 = 9223372036854775808n;
const FEE_5 = 922337203685477580n;
const FEE_03 = 55340232221128654n;
const SPACING = 100;
const WIDTH = 4605200;
const ASK_18_18 = -13815500;
const REQUESTED_SUPPLY = 1_000_000_000n * 10n ** 18n;
const GAS = 6_000_000n;
const NATIVE: Address = zeroAddress;
const WETH: Address = "0xffffffffffffffffffffffffffffffffffffffff";
const PINNED_HEAD = "4f1a3060b099e8a50469848118f44c0c65cfab9a";
// sha256 of `jq -cS .abi` output without a trailing newline, as in the
// protocol manifest
const PINNED_ABIS: Record<string, string> = {
  ZeroSeedLaunch:
    "21f9e2c0166ab28ce8573c481de5b0fc2f37dd7595d496d326f0a2d1a544254e",
  ZeroSeedLaunchPeriphery:
    "5c563488b843aee923d0d819a66489eeee543dd20d1582de1f5df643f5d08a75",
};
const PINNED_CREATION: Record<string, Hex> = {
  ZeroSeedLaunch:
    "0x50dc9c4148f4c81f8f689a2b62ed70c9590366fdb963072b4f2b89361f1dcd7c",
  ZeroSeedLaunchPeriphery:
    "0x79a8ef83d84f8110f6fec96a2d964a39913f81ab23a304fb19fb577fe29ef56c",
};
const readHex = (path: string): Hex =>
  `0x${readFileSync(resolve(evmContracts, path), "utf8")
    .trim()
    .replace(/^0x/, "")}`;
const WETH_RUNTIME = readHex("test/fixtures/weth9-0x4200-base-52449112.hex");
const ROUTER_RUNTIME = readHex(
  "test/fixtures/yul-router-0x03c8-base-52449112.hex",
);

type Artifact = {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex };
};
const artifact = (path: string): Artifact =>
  JSON.parse(readFileSync(resolve(evmContracts, "out", path), "utf8"));

const LAUNCH = artifact("ZeroSeedLaunch.sol/ZeroSeedLaunch.json");
const PERIPHERY = artifact(
  "ZeroSeedLaunchPeriphery.sol/ZeroSeedLaunchPeriphery.json",
);
const CORE_BUILD = artifact("Core.sol/Core.json");
const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "s", type: "address" },
      { name: "a", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// jq -cS: keys sorted recursively, no whitespace.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", evmContracts, ...args], {
    encoding: "utf8",
  }).trim();

const anvil = spawn(
  "anvil",
  [
    "--port",
    String(PORT),
    "--chain-id",
    String(CHAIN_ID),
    "--hardfork",
    "osaka",
    "--timestamp",
    String(T0),
    "--no-mining",
    "--silent",
    "--gas-limit",
    "60000000",
  ],
  { stdio: "ignore" },
);

const transport = http(RPC);
const chain = {
  id: CHAIN_ID,
  name: "anvil",
  nativeCurrency: { name: "E", symbol: "E", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
// Every read must reflect the explicitly mined block.
const pub = createPublicClient({ chain, transport, cacheTime: 0 });
const test = createTestClient({ chain, transport, mode: "anvil" });
const wallet = createWalletClient({ chain, transport });

type Action = { label: string; hash: Hex };
type Block = {
  number: number;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  actions: string[];
};
type PoolKey = { token0: Address; token1: Address; config: Hex };
type Launch = {
  label: string;
  instance: string;
  token: Address;
  quote: Address;
  extension: Address;
  periphery: Address;
  poolKey: PoolKey;
  poolId: Hex;
  userSalt: Hex;
};
type Branch = { blocks: Block[]; logs: unknown[]; states: unknown[] };
type Instance = {
  label: string;
  quote: Address;
  quoteKind: "native" | "erc20";
  extension: Address;
  extensionSalt: Hex;
  periphery: Address;
  extensionRuntimeKeccak: Hex;
  peripheryRuntimeKeccak: Hex;
  quoteRuntimeKeccak: Hex | null;
  deploymentBlock: number;
  scope: string;
};

const launches = new Map<string, Launch>();
const allLaunches = new Map<string, Launch>();
const instances = new Map<string, Instance>();
const installations = new Map<string, unknown>();
let current: Branch;

async function waitForAnvil() {
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
}

async function send(
  from: Address,
  to: Address | null,
  data: Hex,
  value = 0n,
): Promise<Hex> {
  return wallet.sendTransaction({
    account: from,
    to: to ?? undefined,
    data,
    value,
    gas: GAS,
    chain,
  });
}

/** Mines one block at `timestamp` containing the given transactions, in order. */
async function mine(timestamp: number, actions: Array<() => Promise<Action>>) {
  const sent: Action[] = [];
  for (const act of actions) sent.push(await act());
  await test.setNextBlockTimestamp({ timestamp: BigInt(timestamp) });
  await test.mine({ blocks: 1 });
  for (const { label, hash } of sent) {
    const receipt = await pub.getTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted`);
  }
  const block = await pub.getBlock({ blockTag: "latest" });
  if (block.transactions.length !== sent.length)
    throw new Error("block lost a transaction");
  current.blocks.push({
    number: Number(block.number),
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: Number(block.timestamp),
    actions: sent.map((a) => a.label),
  });
  await snapshotState(Number(block.number));
  return Number(block.number);
}

async function quoteBalance(token: Address, who: Address, block: bigint) {
  if (token === NATIVE)
    return pub.getBalance({ address: who, blockNumber: block });
  return pub.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [who],
    blockNumber: block,
  });
}

async function snapshotState(blockNumber: number) {
  const block = BigInt(blockNumber);
  const tokens = new Set<Address>();
  const pools = [];
  for (const launch of launches.values()) {
    const code = await pub.getCode({
      address: launch.token,
      blockNumber: block,
    });
    if (!code || code === "0x") continue;
    tokens.add(launch.token);
    tokens.add(launch.quote);
    const word = await pub.getStorageAt({
      address: CORE,
      slot: launch.poolId,
      blockNumber: block,
    });
    const fees = (await pub.readContract({
      address: launch.extension,
      abi: LAUNCH.abi,
      functionName: "creatorFees",
      args: [launch.poolKey],
      blockNumber: block,
    })) as readonly [bigint, bigint];
    const owner = (await pub.readContract({
      address: launch.periphery,
      abi: PERIPHERY.abi,
      functionName: "launchOwner",
      args: [launch.poolId],
      blockNumber: block,
    })) as Address;
    const stored = (await pub.readContract({
      address: launch.extension,
      abi: LAUNCH.abi,
      functionName: "getLaunch",
      args: [launch.poolId],
      blockNumber: block,
    })) as { controller: Address };
    const feeAt = (await pub.readContract({
      address: launch.extension,
      abi: LAUNCH.abi,
      functionName: "feeAt",
      args: [launch.poolId, BigInt(current.blocks.at(-1)!.timestamp)],
      blockNumber: block,
    })) as bigint;
    pools.push({
      label: launch.label,
      poolId: launch.poolId,
      poolStateWord: word,
      creatorFees: fees.map(String),
      launchOwner: owner,
      controller: stored.controller,
      feeAtBlockTime: String(feeAt),
    });
  }
  const coreBalances: Record<string, string> = {};
  for (const token of [...tokens].sort())
    coreBalances[token.toLowerCase()] = String(
      await quoteBalance(token, CORE, block),
    );
  current.states.push({ blockNumber, pools, coreBalances });
}

async function collectLogs(fromBlock: number) {
  const logs = (await pub.request({
    method: "eth_getLogs",
    params: [{ fromBlock: numberToHex(fromBlock), toBlock: "latest" }],
  })) as { blockNumber: Hex }[];
  if (logs.some((log) => Number(log.blockNumber) < fromBlock))
    throw new Error("branch logs precede the fork point");
  current.logs = logs;
}

/** Deploys the extension at a mined call-point salt and its periphery at salt 0, in one block. */
function deployInstance(label: string, quote: Address) {
  const initCode = concat([
    LAUNCH.bytecode.object,
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }],
      [CORE, quote],
    ),
  ]);
  const bytecodeHash = keccak256(initCode);
  let extension!: Address;
  let extensionSalt!: Hex;
  for (let i = 0n; ; i++) {
    extensionSalt = pad(toHex(i), { size: 32 });
    extension = getContractAddress({
      opcode: "CREATE2",
      from: CREATE2_FACTORY,
      salt: extensionSalt,
      bytecodeHash,
    });
    if (parseInt(extension.slice(2, 4), 16) === CALL_POINTS_BYTE) break;
  }
  const peripheryInit = concat([
    PERIPHERY.bytecode.object,
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }],
      [CORE, extension],
    ),
  ]);
  const peripherySalt = pad("0x", { size: 32 });
  const periphery = getContractAddress({
    opcode: "CREATE2",
    from: CREATE2_FACTORY,
    salt: peripherySalt,
    bytecodeHash: keccak256(peripheryInit),
  });
  instances.set(label, {
    label,
    quote,
    quoteKind: quote === NATIVE ? "native" : "erc20",
    extension,
    extensionSalt,
    periphery,
    extensionRuntimeKeccak: "0x",
    peripheryRuntimeKeccak: "0x",
    quoteRuntimeKeccak: null,
    deploymentBlock: 0,
    scope:
      quote === NATIVE
        ? "native ETH quote, local only"
        : "relocated plain WETH quote, local only",
  });
  return [
    async (): Promise<Action> => ({
      label: `deploy ZeroSeedLaunch ${label}`,
      hash: await send(
        TRADER,
        CREATE2_FACTORY,
        concat([extensionSalt, initCode]),
      ),
    }),
    async (): Promise<Action> => ({
      label: `deploy ZeroSeedLaunchPeriphery ${label}`,
      hash: await send(
        TRADER,
        CREATE2_FACTORY,
        concat([peripherySalt, peripheryInit]),
      ),
    }),
  ];
}

const approve =
  (from: Address, token: Address, label: string) =>
  async (): Promise<Action> => ({
    label,
    hash: await send(
      from,
      token,
      encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [ROUTER, 2n ** 256n - 1n],
      }),
    ),
  });

type Spec = {
  label: string;
  instance: string;
  owner: Address;
  duration: number;
  initialFee: bigint;
  tradingStart: number;
};

const poolIdOf = (key: PoolKey) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
      [key.token0, key.token1, key.config],
    ),
  );

/** Binds a single periphery preview's (liquidity, installedSupply) pair for the owner. */
async function prepareLaunch(spec: Spec) {
  const instance = instances.get(spec.instance)!;
  const userSalt = keccak256(toHex(spec.label));
  const parameters = {
    name: `Zero Seed ${spec.label}`,
    symbol: spec.label.toUpperCase(),
    decimals: 18,
    supply: REQUESTED_SUPPLY,
    liquidity: 0n,
    askTick: ASK_18_18,
    upperTick: ASK_18_18 + WIDTH,
    tickSpacing: SPACING,
    tradingStart: BigInt(spec.tradingStart),
    feeDuration: spec.duration,
    initialFee: spec.initialFee,
    finalFee: FEE_03,
    salt: userSalt,
  };
  const preview = (await pub.readContract({
    address: instance.periphery,
    abi: PERIPHERY.abi,
    functionName: "previewInstallation",
    args: [spec.owner, parameters],
    // pending: the deployment block previews against its own queued deployment
    blockTag: "pending",
  })) as {
    token: Address;
    poolKey: PoolKey;
    liquidity: bigint;
    installedSupply: bigint;
  };
  // The periphery preview equals the extension preview with the owner-namespaced salt.
  const namespaced = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [spec.owner, userSalt],
    ),
  );
  const direct = (await pub.readContract({
    address: instance.extension,
    abi: LAUNCH.abi,
    functionName: "previewInstallation",
    args: [instance.periphery, { ...parameters, salt: namespaced }],
    blockTag: "pending",
  })) as { token: Address };
  if (direct.token !== preview.token)
    throw new Error("periphery preview does not namespace the salt");
  if (
    BigInt(preview.token) > BigInt(instance.quote) !==
    (instance.quote === NATIVE)
  )
    throw new Error(`unexpected token order for ${spec.label}`);
  parameters.liquidity = preview.liquidity;
  parameters.supply = preview.installedSupply;
  installations.set(spec.label, {
    requestedSupply: String(REQUESTED_SUPPLY),
    actualInstalledSupply: String(preview.installedSupply),
    actualLiquidity: String(preview.liquidity),
    tradingStart: spec.tradingStart,
    previewBlock: Number(await pub.getBlockNumber()),
    owner: spec.owner,
    userSalt,
    extensionSalt: namespaced,
    predictedToken: preview.token,
    instance: spec.instance,
  });
  return {
    parameters,
    launch: {
      label: spec.label,
      instance: spec.instance,
      token: preview.token,
      quote: instance.quote,
      extension: instance.extension,
      periphery: instance.periphery,
      poolKey: preview.poolKey,
      poolId: poolIdOf(preview.poolKey),
      userSalt,
    },
  };
}

const create = (spec: Spec) => async (): Promise<Action> => {
  const { parameters, launch } = await prepareLaunch(spec);
  launches.set(spec.label, launch);
  allLaunches.set(spec.label, launch);
  return {
    label: `create ${spec.label}`,
    hash: await send(
      spec.owner,
      launch.periphery,
      encodeFunctionData({
        abi: PERIPHERY.abi,
        functionName: "create",
        args: [parameters],
      }),
    ),
  };
};

const claim =
  (label: string, owner: Address, recipient: Address) =>
  async (): Promise<Action> => ({
    label: `claim ${label} by ${owner} to ${recipient}`,
    hash: await send(
      owner,
      launches.get(label)!.periphery,
      encodeFunctionData({
        abi: PERIPHERY.abi,
        functionName: "claimFees",
        args: [launches.get(label)!.poolKey, recipient],
      }),
    ),
  });

const transfer =
  (label: string, from: Address, to: Address) => async (): Promise<Action> => ({
    label: `transfer ${label} ${from} -> ${to}`,
    hash: await send(
      from,
      launches.get(label)!.periphery,
      encodeFunctionData({
        abi: PERIPHERY.abi,
        functionName: "transferLaunch",
        args: [launches.get(label)!.poolId, to],
      }),
    ),
  });

const int128 = (v: bigint) => pad(toHex(BigInt.asUintN(128, v)), { size: 16 });

/** yul-router v0.8 packed route, one forwarded hop, inclusive uint32 deadline (see ZeroSeedLaunchYulRouterTest). */
function route(
  launch: Launch,
  sell: boolean,
  amount: bigint,
  threshold: bigint,
  deadline: number,
): Hex {
  // threshold 0 marks the deliberate zero fill, which only an explicit partial route accepts
  const allowPartial = threshold === 0n;
  const [specified, calculated] =
    sell === amount > 0n
      ? [launch.token, launch.quote]
      : [launch.quote, launch.token];
  return concat([
    "0x03",
    "0x00",
    specified,
    calculated,
    int128(threshold),
    TRADER,
    pad(toHex(deadline), { size: 4 }),
    int128(amount),
    "0x00",
    "0x01",
    launch.extension,
    launch.poolKey.token0,
    launch.poolKey.token1,
    launch.poolKey.config,
    pad("0x", { size: 12 }),
    allowPartial ? "0x80000000" : "0x00000000",
  ]);
}

const MAX_NATIVE_IN = 10n ** 24n;

/**
 * amount > 0: exact input of the token being sold; amount < 0: exact output
 * of the token being bought. The threshold is a positive minimum output (or a
 * negative maximum input); zero is only used for the deliberate no-bid fill.
 * A native buy attaches the exact input, or a maximum input the router refunds.
 */
const swap =
  (
    label: string,
    sell: boolean,
    amount: bigint,
    deadline: number,
    threshold?: bigint,
  ) =>
  async (): Promise<Action> => {
    const launch = launches.get(label)!;
    const value =
      launch.quote === NATIVE && !sell
        ? amount > 0n
          ? amount
          : MAX_NATIVE_IN
        : 0n;
    return {
      label: `${sell ? "sell" : "buy"} ${label} ${amount > 0n ? "exact-in" : "exact-out"} ${amount}`,
      hash: await send(
        TRADER,
        ROUTER,
        route(
          launch,
          sell,
          amount,
          threshold ?? (amount > 0n ? 1n : -(10n ** 30n)),
          deadline,
        ),
        value,
      ),
    };
  };

const approveLaunchToken = (label: string) => async () =>
  approve(TRADER, launches.get(label)!.token, `approve ${label} token`)();

const START = T0 + 1_000;
const E18 = 10n ** 18n;

async function prefix() {
  const L1: Spec = {
    label: "l1",
    instance: "native",
    owner: CREATOR,
    duration: 3600,
    initialFee: FEE_50,
    tradingStart: START,
  };
  const L2: Spec = {
    label: "l2",
    instance: "weth",
    owner: CREATOR,
    duration: 600,
    initialFee: FEE_5,
    tradingStart: START,
  };
  // Deployment block: both instances, then a native launch in the same block.
  const deploymentBlock = await mine(T0 + 10, [
    ...deployInstance("native", NATIVE),
    ...deployInstance("weth", WETH),
    create(L1),
  ]);
  for (const instance of instances.values())
    instance.deploymentBlock = deploymentBlock;
  await mine(T0 + 20, [
    approve(TRADER, WETH, "approve weth"),
    create(L2),
    approveLaunchToken("l1"),
  ]);
  await mine(T0 + 30, [approveLaunchToken("l2")]);
  // A no-bid sell before any buy fills nothing (threshold 0 is deliberate here).
  await mine(START, [
    swap("l1", true, E18, START, 0n),
    swap("l1", false, E18, START),
    swap("l2", false, -(10n ** 24n), START),
  ]);
  await mine(START + 60, [
    swap("l1", false, -(10n ** 25n), START + 60),
    swap("l1", true, 10n ** 24n, START + 60),
    swap("l2", false, 5n * E18, START + 60),
    claim("l1", CREATOR, FEE_RECIPIENT),
  ]);
  await mine(START + 120, [
    transfer("l2", CREATOR, NEW_OWNER),
    swap("l2", true, -(10n ** 15n), START + 120),
  ]);
}

/** The orphaned branch: different transfers, claims and a creation. */
async function forkA() {
  const L3: Spec = {
    label: "l3",
    instance: "native",
    owner: NEW_OWNER,
    duration: 3600,
    initialFee: FEE_50,
    tradingStart: START + 300,
  };
  await mine(START + 300, [
    transfer("l1", CREATOR, NEW_OWNER),
    claim("l1", NEW_OWNER, NEW_OWNER),
    create(L3),
  ]);
  await mine(START + 360, [
    swap("l3", false, 3n * E18, START + 360),
    transfer("l2", NEW_OWNER, CREATOR),
    claim("l2", CREATOR, FEE_RECIPIENT),
  ]);
}

async function canonical() {
  const L4: Spec = {
    label: "l4",
    instance: "weth",
    owner: TRADER,
    duration: 600,
    initialFee: FEE_5,
    tradingStart: START + 400,
  };
  await mine(START + 310, [
    swap("l1", false, 2n * E18, START + 310),
    claim("l2", NEW_OWNER, NEW_OWNER),
    create(L4),
  ]);
  await mine(START + 400, [
    approveLaunchToken("l4"),
    swap("l4", true, E18, START + 400, 0n),
    swap("l4", false, 7n * E18, START + 400),
  ]);
  await mine(START + 700, [
    swap("l4", false, -(10n ** 23n), START + 700),
    swap("l2", false, 3n * E18, START + 700),
    transfer("l1", CREATOR, NEW_OWNER),
  ]);
  await mine(START + 756, [
    swap("l1", false, E18, START + 756),
    transfer("l1", NEW_OWNER, FEE_RECIPIENT),
  ]);
  await mine(START + 1800, [
    swap("l1", false, E18, START + 1800),
    swap("l4", true, 10n ** 22n, START + 1800),
    claim("l1", FEE_RECIPIENT, FEE_RECIPIENT),
  ]);
  await mine(START + 3599, [swap("l1", false, E18, START + 3599)]);
  await mine(START + 3600, [
    swap("l1", false, E18, START + 3600),
    claim("l4", TRADER, FEE_RECIPIENT),
  ]);
  const tenYears = START + 10 * 365 * 86_400;
  await mine(tenYears, [
    swap("l1", true, 10n ** 23n, tenYears),
    claim("l1", FEE_RECIPIENT, NEW_OWNER),
    claim("l1", FEE_RECIPIENT, NEW_OWNER),
  ]);
}

function validateFixtureBuild() {
  if (
    git("rev-parse", "HEAD") !== PINNED_HEAD ||
    git(
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--ignore-submodules=all",
    ) !== ""
  )
    throw new Error("fixture requires the clean pinned source");
  for (const [name, build] of [
    ["ZeroSeedLaunch", LAUNCH],
    ["ZeroSeedLaunchPeriphery", PERIPHERY],
  ] as const) {
    if (sha256(canonicalJson(build.abi)) !== PINNED_ABIS[name])
      throw new Error(`${name} ABI differs from the pinned build`);
    if (keccak256(build.bytecode.object) !== PINNED_CREATION[name])
      throw new Error(`${name} creation code differs from the pinned build`);
  }
  if (
    keccak256(WETH_RUNTIME) !==
    "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c"
  )
    throw new Error("WETH fixture runtime mismatch");
}

async function bindInstances() {
  for (const instance of instances.values()) {
    instance.extensionRuntimeKeccak = keccak256(
      (await pub.getCode({ address: instance.extension }))!,
    );
    instance.peripheryRuntimeKeccak = keccak256(
      (await pub.getCode({ address: instance.periphery }))!,
    );
    if (instance.quote !== NATIVE)
      instance.quoteRuntimeKeccak = keccak256(
        (await pub.getCode({ address: instance.quote }))!,
      );
    const actualQuote = (await pub.readContract({
      address: instance.extension,
      abi: LAUNCH.abi,
      functionName: "quoteToken",
    })) as Address;
    const actualLaunch = (await pub.readContract({
      address: instance.periphery,
      abi: PERIPHERY.abi,
      functionName: "LAUNCH",
    })) as Address;
    if (
      BigInt(actualQuote) !== BigInt(instance.quote) ||
      BigInt(actualLaunch) !== BigInt(instance.extension)
    )
      throw new Error("constructor immutables mismatch");
  }
}

async function main() {
  validateFixtureBuild();
  await waitForAnvil();
  await test.setCode({
    address: CORE,
    bytecode: CORE_BUILD.deployedBytecode.object,
  });
  await test.setCode({ address: ROUTER, bytecode: ROUTER_RUNTIME });
  await test.setCode({ address: WETH, bytecode: WETH_RUNTIME });
  const coreCodehash = keccak256((await pub.getCode({ address: CORE }))!);
  const routerCodehash = keccak256((await pub.getCode({ address: ROUTER }))!);

  const branches: Record<string, Branch> = {};
  current = branches.prefix = { blocks: [], logs: [], states: [] };
  await test.setBalance({ address: TRADER, value: 10n ** 32n });
  await mine(T0 + 5, [
    async () => ({
      label: "deposit plain WETH",
      hash: await send(TRADER, WETH, "0xd0e30db0", 10n ** 30n),
    }),
  ]);
  await prefix();
  await bindInstances();
  await collectLogs(1);
  const forkPoint = Number(await pub.getBlockNumber());
  const snapshot = await test.snapshot();

  const launchesBeforeFork = new Map(launches);
  current = branches.alternate = { blocks: [], logs: [], states: [] };
  await forkA();
  await collectLogs(forkPoint + 1);

  await test.revert({ id: snapshot });
  launches.clear();
  for (const [k, v] of launchesBeforeFork) launches.set(k, v);
  current = branches.canonical = { blocks: [], logs: [], states: [] };
  await canonical();
  await collectLogs(forkPoint + 1);

  const fixture = {
    description:
      "Logs and state emitted by a local anvil chain (no fork) running ZeroSeedLaunch and ZeroSeedLaunchPeriphery over the main Core runtime and the Base 0x03c8 Yul router runtime. Local fixture, not live evidence.",
    generator: "scripts/zeroSeedLaunchFixture.ts",
    provenance: {
      evmContractsHead: git("rev-parse", "HEAD"),
      evmContractsTree: git("rev-parse", "HEAD^{tree}"),
      evmContractsDirty: false,
      anvil: execFileSync("anvil", ["--version"], { encoding: "utf8" }).split(
        "\n",
      )[0],
      coreRuntimeKeccak: coreCodehash,
      routerRuntimeKeccak: routerCodehash,
      launchAbiSha256: sha256(canonicalJson(LAUNCH.abi)),
      peripheryAbiSha256: sha256(canonicalJson(PERIPHERY.abi)),
      launchCreationKeccak: keccak256(LAUNCH.bytecode.object),
      peripheryCreationKeccak: keccak256(PERIPHERY.bytecode.object),
      wethRuntimeKeccak: keccak256(WETH_RUNTIME),
      buildSubmodules:
        "excluded from git dirty check; canonical ABI and creation code checked independently",
    },
    chainId: CHAIN_ID,
    instances: [...instances.values()],
    addresses: {
      core: CORE,
      router: ROUTER,
      creator: CREATOR,
      trader: TRADER,
      feeRecipient: FEE_RECIPIENT,
      newOwner: NEW_OWNER,
    },
    launches: Object.fromEntries(
      [...allLaunches.values()].map((l) => [l.label, l]),
    ),
    installations: Object.fromEntries(installations),
    forkPoint,
    branches,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(
    `wrote ${OUT}: ${[...instances.values()]
      .map(
        (i) =>
          `${i.label} extension ${i.extension} (${i.extensionRuntimeKeccak}) periphery ${i.periphery} (${i.peripheryRuntimeKeccak})`,
      )
      .join("; ")}`,
  );
}

try {
  await main();
} finally {
  anvil.kill();
}
