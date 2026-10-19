// Generates tests/fixtures/zero-seed-launch/local-chain.json: logs and state
// that a local anvil chain actually emits for ZeroSeedLaunch launches, swaps
// through the Base 0x03c8 Yul router runtime, and creator fee claims.
//
//   bun scripts/zeroSeedLaunchFixture.ts <evm-contracts checkout> [out.json]
//
// The checkout must be EkuboProtocol/evm-contracts at the pinned head, built
// with `forge build`. Core is the main (Q0.64) runtime the build produces, set
// at the canonical address; the router runtime is the checkout's Base fixture.
// Each quote has its own constructor-bound instance, deployed through the
// deterministic deployer at a mined salt carrying the call-point byte.
// Relocated WETH is supported-path LOCAL evidence; the synthetic 6-decimal
// instance is arithmetic evidence only, never a service-supported asset pin.
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
// anvil's default mnemonic, accounts 0..2
const TRADER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CREATOR: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FEE_RECIPIENT: Address = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

const FEE_5 = 922337203685477580n;
const FEE_03 = 55340232221128654n;
// Study per-second decay factors (Q0.64) for the two fixture durations, not selected parameters.
const DECAY_FACTORS: Record<number, bigint> = {
  600: 18319323104848571946n,
  3600: 18425445863997925462n,
};
const SPACING = 100;
const WIDTH = 4605200;
const ASK_18_18 = -13815500;
const ASK_18_6 = -41446500;
const REQUESTED_SUPPLY = 1_000_000_000n * 10n ** 18n;
const GAS = 6_000_000n;
const QUOTE_18: Address = "0xffffffffffffffffffffffffffffffffffffffff";
const QUOTE_18_LOW: Address = "0x0000000000000000000000000000000000010000";
const PINNED_HEAD = "b1cbb1c1a9a00de62072a63a8f4aab4d97065573";
const PINNED_TREE = "3f9196ebe47ebbff04459d08d645f8ca3168244a";
const PINNED_ABI =
  "bc51b39284a5a2a0970d3a804420762ce291dc01f9c21ddf31840e354a3792bb";
const WETH_RUNTIME: Hex = `0x${readFileSync(
  resolve(evmContracts, "test/fixtures/weth9-0x4200-base-52449112.hex"),
  "utf8",
)
  .trim()
  .replace(/^0x/, "")}`;

type Artifact = {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex };
};
const artifact = (path: string): Artifact =>
  JSON.parse(readFileSync(resolve(evmContracts, "out", path), "utf8"));

const LAUNCH = artifact("ZeroSeedLaunch.sol/ZeroSeedLaunch.json");
const TOKEN = artifact("ZeroSeedLaunch.t.sol/DecimalsToken.json");
const CORE_BUILD = artifact("Core.sol/Core.json");
const ROUTER_RUNTIME: Hex = `0x${readFileSync(
  resolve(evmContracts, "test/fixtures/yul-router-0x03c8-base-52449112.hex"),
  "utf8",
)
  .trim()
  .replace(/^0x/, "")}`;
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
// Every read must reflect the explicitly mined block, including fast creations
// whose address order does not need a long salt search.
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
type Launch = {
  label: string;
  token: Address;
  quote: Address;
  extension: Address;
  poolKey: { token0: Address; token1: Address; config: Hex };
  poolId: Hex;
};
type Branch = { blocks: Block[]; logs: unknown[]; states: unknown[] };

const launches = new Map<string, Launch>();
const allLaunches = new Map<string, Launch>();
const instances = new Map<
  Address,
  { address: Address; quote: Address; runtimeKeccak: Hex; scope: string }
>();
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
): Promise<Hex> {
  return wallet.sendTransaction({
    account: from,
    to: to ?? undefined,
    data,
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
  return sent;
}

async function snapshotState(blockNumber: number) {
  const tokens = new Set<Address>();
  const pools = [];
  for (const launch of launches.values()) {
    const code = await pub.getCode({
      address: launch.token,
      blockNumber: BigInt(blockNumber),
    });
    if (!code || code === "0x") continue;
    tokens.add(launch.token);
    tokens.add(launch.quote);
    const word = await pub.getStorageAt({
      address: CORE,
      slot: launch.poolId,
      blockNumber: BigInt(blockNumber),
    });
    const fees = (await pub.readContract({
      address: launch.extension,
      abi: LAUNCH.abi,
      functionName: "creatorFees",
      args: [launch.poolKey],
      blockNumber: BigInt(blockNumber),
    })) as readonly [bigint, bigint];
    pools.push({
      label: launch.label,
      poolId: launch.poolId,
      poolStateWord: word,
      creatorFees: fees.map(String),
    });
  }
  const coreBalances: Record<string, string> = {};
  for (const token of [...tokens].sort()) {
    coreBalances[token.toLowerCase()] = String(
      await pub.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [CORE],
        blockNumber: BigInt(blockNumber),
      }),
    );
  }
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

async function deployLaunch(quote: Address): Promise<Action> {
  const initCode = concat([
    LAUNCH.bytecode.object,
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }],
      [CORE, quote],
    ),
  ]);
  const bytecodeHash = keccak256(initCode);
  for (let i = 0n; ; i++) {
    const salt = pad(toHex(i), { size: 32 });
    const address = getContractAddress({
      opcode: "CREATE2",
      from: CREATE2_FACTORY,
      salt,
      bytecodeHash,
    });
    if (parseInt(address.slice(2, 4), 16) !== CALL_POINTS_BYTE) continue;
    instances.set(quote, {
      address,
      quote,
      runtimeKeccak: "0x",
      scope:
        quote === QUOTE_18 || quote === QUOTE_18_LOW
          ? "relocated plain WETH, local only"
          : "synthetic 6-decimal arithmetic only; unsupported asset",
    });
    return {
      label: `deploy ZeroSeedLaunch salt ${i}`,
      hash: await send(TRADER, CREATE2_FACTORY, concat([salt, initCode])),
    };
  }
}

async function deployQuote(
  decimals: number,
): Promise<{ action: Action; address: Address }> {
  const nonce = await pub.getTransactionCount({
    address: TRADER,
    blockTag: "pending",
  });
  const data = concat([
    TOKEN.bytecode.object,
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint8" }],
      [TRADER, decimals],
    ),
  ]);
  const address = getContractAddress({ from: TRADER, nonce: BigInt(nonce) });
  return {
    address,
    action: {
      label: `deploy quote ${decimals} decimals`,
      hash: await send(TRADER, null, data),
    },
  };
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
  quote: Address;
  quoteDecimals: number;
  tokenIs0: boolean;
  duration: number;
  tradingStart: number;
};

/** Binds a single preview's (liquidity, installedSupply) pair; the salt is chosen for the wanted token order. */
async function prepareLaunch(spec: Spec) {
  const extension = instances.get(spec.quote)!.address;
  for (let salt = 1n; salt <= 10_000n; salt++) {
    const parameters = {
      quoteToken: spec.quote,
      name: `Zero Seed ${spec.label}`,
      symbol: spec.label.toUpperCase(),
      decimals: 18,
      supply: REQUESTED_SUPPLY,
      liquidity: 0n,
      askTick: spec.quoteDecimals === 18 ? ASK_18_18 : ASK_18_6,
      upperTick: (spec.quoteDecimals === 18 ? ASK_18_18 : ASK_18_6) + WIDTH,
      tickSpacing: SPACING,
      tradingStart: BigInt(spec.tradingStart),
      feeDuration: spec.duration,
      initialFee: FEE_5,
      finalFee: FEE_03,
      decayFactor: DECAY_FACTORS[spec.duration],
      salt: pad(toHex(salt), { size: 32 }),
    };
    const preview = (await pub.readContract({
      address: extension,
      abi: LAUNCH.abi,
      functionName: "previewInstallation",
      args: [CREATOR, parameters],
    })) as {
      token: Address;
      poolKey: Launch["poolKey"];
      liquidity: bigint;
      installedSupply: bigint;
    };
    if (BigInt(preview.token) < BigInt(spec.quote) !== spec.tokenIs0) continue;
    parameters.liquidity = preview.liquidity;
    parameters.supply = preview.installedSupply;
    installations.set(spec.label, {
      requestedSupply: String(REQUESTED_SUPPLY),
      actualInstalledSupply: String(preview.installedSupply),
      actualLiquidity: String(preview.liquidity),
      tradingStart: spec.tradingStart,
      previewBlock: Number(await pub.getBlockNumber()),
      extension,
      quote: spec.quote,
    });
    const poolId = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
        [
          preview.poolKey.token0,
          preview.poolKey.token1,
          preview.poolKey.config,
        ],
      ),
    );
    return {
      parameters,
      launch: {
        label: spec.label,
        token: preview.token,
        quote: spec.quote,
        extension,
        poolKey: preview.poolKey,
        poolId,
      },
    };
  }
  throw new Error(`could not find the requested token order for ${spec.label}`);
}

const create = (spec: Spec) => async (): Promise<Action> => {
  const { parameters, launch } = await prepareLaunch(spec);
  launches.set(spec.label, launch);
  allLaunches.set(spec.label, launch);
  return {
    label: `create ${spec.label}`,
    hash: await send(
      CREATOR,
      launch.extension,
      encodeFunctionData({
        abi: LAUNCH.abi,
        functionName: "create",
        args: [parameters],
      }),
    ),
  };
};

const claim = (label: string) => async (): Promise<Action> => ({
  label: `claim ${label}`,
  hash: await send(
    CREATOR,
    launches.get(label)!.extension,
    encodeFunctionData({
      abi: LAUNCH.abi,
      functionName: "claimFees",
      args: [launches.get(label)!.poolKey, FEE_RECIPIENT],
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

/**
 * amount > 0: exact input of the token being sold; amount < 0: exact output
 * of the token being bought. The threshold is a positive minimum output (or a
 * negative maximum input); zero is only used for the deliberate no-bid fill.
 */
const swap =
  (
    label: string,
    sell: boolean,
    amount: bigint,
    deadline: number,
    threshold?: bigint,
  ) =>
  async (): Promise<Action> => ({
    label: `${sell ? "sell" : "buy"} ${label} ${amount > 0n ? "exact-in" : "exact-out"} ${amount}`,
    hash: await send(
      TRADER,
      ROUTER,
      route(
        launches.get(label)!,
        sell,
        amount,
        threshold ?? (amount > 0n ? 1n : -(10n ** 30n)),
        deadline,
      ),
    ),
  });

const approveLaunchToken = (label: string) => async () =>
  approve(TRADER, launches.get(label)!.token, `approve ${label} token`)();

const START = T0 + 1_000;

async function prefix(quote18: Address, quote6: Address) {
  const L1: Spec = {
    label: "l1",
    quote: quote18,
    quoteDecimals: 18,
    tokenIs0: true,
    duration: 3600,
    tradingStart: START,
  };
  const L2: Spec = {
    label: "l2",
    quote: quote6,
    quoteDecimals: 6,
    tokenIs0: false,
    duration: 600,
    tradingStart: START,
  };
  await mine(T0 + 20, [
    approve(TRADER, quote18, "approve quote18"),
    approve(TRADER, QUOTE_18_LOW, "approve quote18 low"),
    approve(TRADER, quote6, "approve quote6"),
  ]);
  await mine(T0 + 30, [create(L1)]);
  await mine(T0 + 40, [create(L2), approveLaunchToken("l1")]);
  await mine(T0 + 50, [approveLaunchToken("l2")]);
  // A no-bid sell before any buy fills nothing (threshold 0 is deliberate here).
  await mine(START, [
    swap("l1", true, 10n ** 18n, START, 0n),
    swap("l1", false, 10n ** 18n, START),
    swap("l2", false, -(10n ** 24n), START),
  ]);
  await mine(START + 60, [
    swap("l1", false, 5n * 10n ** 18n, START + 60),
    swap("l1", true, 10n ** 24n, START + 60),
    claim("l1"),
  ]);
  await mine(START + 120, [
    swap("l2", false, 25n * 10n ** 6n, START + 120),
    swap("l2", true, -(10n ** 6n), START + 120),
  ]);
}

async function forkA(quote18: Address) {
  const L3: Spec = {
    label: "l3",
    quote: quote18,
    quoteDecimals: 18,
    tokenIs0: false,
    duration: 3600,
    tradingStart: START + 300,
  };
  await mine(START + 300, [
    create(L3),
    swap("l1", false, 2n * 10n ** 18n, START + 300),
    claim("l2"),
  ]);
  await mine(START + 360, [
    swap("l3", false, 3n * 10n ** 18n, START + 360),
    swap("l1", false, -(10n ** 25n), START + 360),
  ]);
  await mine(START + 420, [claim("l1"), claim("l3")]);
}

async function canonical(quote6: Address) {
  const L4: Spec = {
    label: "l4",
    quote: quote6,
    quoteDecimals: 6,
    tokenIs0: true,
    duration: 600,
    tradingStart: START + 400,
  };
  await mine(START + 310, [
    swap("l1", true, -(10n ** 15n), START + 310),
    create(L4),
  ]);
  await mine(START + 400, [
    approveLaunchToken("l4"),
    swap("l4", true, 10n ** 18n, START + 400, 0n),
    swap("l4", false, 7n * 10n ** 6n, START + 400),
  ]);
  await mine(START + 700, [
    swap("l4", false, -(10n ** 23n), START + 700),
    swap("l2", false, 3n * 10n ** 6n, START + 700),
    claim("l2"),
  ]);
  await mine(START + 1800, [
    swap("l1", false, 10n ** 18n, START + 1800),
    swap("l4", true, 10n ** 22n, START + 1800),
  ]);
  await mine(START + 3599, [swap("l1", false, 10n ** 18n, START + 3599)]);
  await mine(START + 3600, [
    swap("l1", false, 10n ** 18n, START + 3600),
    claim("l4"),
  ]);
  const tenYears = START + 10 * 365 * 86_400;
  await mine(tenYears, [
    swap("l1", true, 10n ** 23n, tenYears),
    claim("l1"),
    claim("l1"),
  ]);
}

function validateFixtureBuild() {
  if (
    git("rev-parse", "HEAD") !== PINNED_HEAD ||
    git("rev-parse", "HEAD^{tree}") !== PINNED_TREE ||
    git(
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--ignore-submodules=all",
    ) !== ""
  )
    throw new Error("fixture requires the clean pinned draft source");
  if (sha256(`${canonicalJson(LAUNCH.abi)}\n`) !== PINNED_ABI)
    throw new Error("build ABI differs from the pinned draft");
  if (
    keccak256(WETH_RUNTIME) !==
    "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c"
  )
    throw new Error("WETH fixture runtime mismatch");
}

async function main() {
  validateFixtureBuild();
  await waitForAnvil();
  await test.setCode({
    address: CORE,
    bytecode: CORE_BUILD.deployedBytecode.object,
  });
  await test.setCode({ address: ROUTER, bytecode: ROUTER_RUNTIME });
  const coreCodehash = keccak256((await pub.getCode({ address: CORE }))!);
  const routerCodehash = keccak256((await pub.getCode({ address: ROUTER }))!);

  const branches: Record<string, Branch> = {};
  current = branches.prefix = { blocks: [], logs: [], states: [] };
  const quote18 = QUOTE_18;
  let quote6!: Address;
  for (const address of [quote18, QUOTE_18_LOW])
    await test.setCode({ address, bytecode: WETH_RUNTIME });
  await test.setBalance({ address: TRADER, value: 10n ** 32n });
  await mine(T0 + 5, [
    async () => {
      return {
        label: "deposit plain WETH",
        hash: await wallet.sendTransaction({
          account: TRADER,
          to: quote18,
          data: "0xd0e30db0",
          value: 10n ** 30n,
          gas: GAS,
          chain,
        }),
      };
    },
    async () => {
      return {
        label: "deposit low plain WETH",
        hash: await wallet.sendTransaction({
          account: TRADER,
          to: QUOTE_18_LOW,
          data: "0xd0e30db0",
          value: 10n ** 30n,
          gas: GAS,
          chain,
        }),
      };
    },
    async () => {
      const q = await deployQuote(6);
      quote6 = q.address;
      return q.action;
    },
  ]);
  await mine(T0 + 10, [
    () => deployLaunch(quote18),
    () => deployLaunch(QUOTE_18_LOW),
    () => deployLaunch(quote6),
  ]);
  for (const instance of instances.values()) {
    instance.runtimeKeccak = keccak256(
      (await pub.getCode({ address: instance.address }))!,
    );
    const actualQuote = await pub.readContract({
      address: instance.address,
      abi: LAUNCH.abi,
      functionName: "quoteToken",
    });
    if (BigInt(actualQuote as Address) !== BigInt(instance.quote))
      throw new Error("constructor quote mismatch");
  }
  if (
    instances.get(quote18)!.runtimeKeccak !==
    "0x8fb360bb48006819049e6b9a53679ccaa01264e61465ce8e8cd2e8b185d3a8d1"
  )
    throw new Error("executed WETH instance runtime differs from the pin");
  if (
    instances.get(QUOTE_18_LOW)!.runtimeKeccak !==
    "0xa951db07ad354ea45df3ff1b720b69c7cc588c4feb44aaea79cd79639da61f6e"
  )
    throw new Error("executed low WETH instance runtime differs from the pin");
  await prefix(quote18, quote6);
  await collectLogs(1);
  const forkPoint = Number(await pub.getBlockNumber());
  const snapshot = await test.snapshot();

  const launchesBeforeFork = new Map(launches);
  current = branches.alternate = { blocks: [], logs: [], states: [] };
  await forkA(QUOTE_18_LOW);
  await collectLogs(forkPoint + 1);

  await test.revert({ id: snapshot });
  launches.clear();
  for (const [k, v] of launchesBeforeFork) launches.set(k, v);
  current = branches.canonical = { blocks: [], logs: [], states: [] };
  await canonical(quote6);
  await collectLogs(forkPoint + 1);

  const LAUNCH_ADDRESS = instances.get(quote18)!.address;
  const launchCodehash = instances.get(quote18)!.runtimeKeccak;
  // as `jq -cS . abi.json | sha256sum`, trailing newline included
  const abiSha256 = sha256(`${canonicalJson(LAUNCH.abi)}\n`);
  const fixture = {
    description:
      "Logs and state emitted by a local anvil chain (no fork) running ZeroSeedLaunch over the main Core runtime and the Base 0x03c8 Yul router runtime. Local fixture, not live evidence.",
    generator: "scripts/zeroSeedLaunchFixture.ts",
    provenance: {
      evmContractsHead: git("rev-parse", "HEAD"),
      evmContractsTree: git("rev-parse", "HEAD^{tree}"),
      evmContractsDirty:
        git(
          "status",
          "--porcelain",
          "--untracked-files=no",
          "--ignore-submodules=all",
        ) !== "",
      anvil: execFileSync("anvil", ["--version"], { encoding: "utf8" }).split(
        "\n",
      )[0],
      coreRuntimeKeccak: coreCodehash,
      routerRuntimeKeccak: routerCodehash,
      launchRuntimeKeccak: launchCodehash,
      launchAbiSha256: abiSha256,
      wethRuntimeKeccak: keccak256(WETH_RUNTIME),
      buildSubmodules:
        "excluded from git dirty check; canonical ABI and constructor-executed runtime pins checked independently",
    },
    chainId: CHAIN_ID,
    instances: [...instances.values()].map((instance) => ({
      ...instance,
      constructorArguments: encodeAbiParameters(
        [{ type: "address" }, { type: "address" }],
        [CORE, instance.quote],
      ),
    })),
    addresses: {
      core: CORE,
      router: ROUTER,
      launch: LAUNCH_ADDRESS,
      quote18,
      quote6,
      creator: CREATOR,
      trader: TRADER,
      feeRecipient: FEE_RECIPIENT,
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
    `wrote ${OUT}: launch ${LAUNCH_ADDRESS} codehash ${launchCodehash} abi ${abiSha256}`,
  );
}

try {
  await main();
} finally {
  anvil.kill();
}
