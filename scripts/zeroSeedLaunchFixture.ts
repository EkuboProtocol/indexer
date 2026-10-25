// Generates tests/fixtures/zero-seed-launch/local-chain.json: logs and state
// that a local anvil chain actually emits for ZeroSeedLaunch launches created,
// claimed and transferred through ZeroSeedLaunchPeriphery, and swapped through
// the checkout's test/LaunchTestRouter.sol.
//
//   bun scripts/zeroSeedLaunchFixture.ts <evm-contracts checkout> [out.json]
//
// The checkout must be EkuboProtocol/evm-contracts at 853b608 (the final
// source freeze), built with `forge build`; it is only read, and its compiled
// launch ABIs must equal the frozen ABIs in src/evm/abis/zero-seed-launch/.
// Core is the main (Q0.64) runtime the build produces, set at the canonical
// address. One instance: the extension (constructor `(core)`, mined CREATE2
// salt carrying the call-point byte) and its periphery, both deployed through
// the deterministic deployer. Every launch names its own quote, and launches
// of both kinds share the instance:
//   native  quote address(0) (native ETH, always token0; launch is token1)
//   erc20   quote 0xff..ff, the checkout's plain 18-decimal test/TestToken.sol
//           runtime relocated there (launch is token0)
// The extension derives the spacing from the requested range, installs at
// most the requested supply and mints the remainder (the sink) to
// address(0). The script checks, per creation, the Installation that create
// returns against the preview, Core's PositionUpdated delta and the two mint
// Transfers against the installed supply and sink, totalSupply against the
// requested supply and balanceOf(address(0)) against the sink. The instance
// and its first launch share the deployment block, so a replay that starts
// one block late provably misses a launch.
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
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getContractAddress,
  http,
  keccak256,
  maxUint256,
  numberToHex,
  pad,
  slice,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { parsePoolBalanceUpdate } from "../src/evm/poolKey";

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
const CREATE2_FACTORY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
// beforeInitializePool (1) + beforeSwap (64) + beforeUpdatePosition (16)
const CALL_POINTS_BYTE = 0x51;
// anvil's default mnemonic, accounts 0..3
const TRADER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CREATOR: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FEE_RECIPIENT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const NEW_OWNER: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
// The router is TRADER's first CREATE.
const ROUTER: Address = getContractAddress({ from: TRADER, nonce: 0n });

const FEE_50 = 9223372036854775808n;
const FEE_5 = 922337203685477580n;
const FEE_03 = 55340232221128654n;
// The highest Q0.64 rate, 2^64 - 1: just under 100%.
const FEE_MAX = 2n ** 64n - 1n;
const SPACING = 100;
const WIDTH = 4605200;
const ASK_18_18 = -13815500;
const REQUESTED_SUPPLY = 1_000_000_000n * 10n ** 18n;
const GAS = 10_000_000n;
const NATIVE: Address = zeroAddress;
const ERC20_QUOTE: Address = "0xffffffffffffffffffffffffffffffffffffffff";
const SOURCE_COMMIT = "853b608ec26d4c80bdad6e394cb8ba686e1ae615";
// The one-day half-life default and the 600 s half-life rate (Q32.32 ticks
// per second).
const DECAY_RATE_DEFAULT = 68913100933n;
const DECAY_RATE_600 = 9923486534471n;

type Artifact = {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode: {
    object: Hex;
    immutableReferences?: Record<string, { start: number; length: number }[]>;
  };
};
const artifact = (path: string): Artifact =>
  JSON.parse(readFileSync(resolve(evmContracts, "out", path), "utf8"));

const LAUNCH = artifact("ZeroSeedLaunch.sol/ZeroSeedLaunch.json");
const PERIPHERY = artifact(
  "ZeroSeedLaunchPeriphery.sol/ZeroSeedLaunchPeriphery.json",
);
const CORE_BUILD = artifact("Core.sol/Core.json");
const ROUTER_BUILD = artifact("LaunchTestRouter.sol/LaunchTestRouter.json");
const QUOTE_BUILD = artifact("TestToken.sol/TestToken.json");
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
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
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
  if (typeof value === "bigint") return JSON.stringify(String(value));
  return JSON.stringify(value);
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", evmContracts, ...args], {
    encoding: "utf8",
  }).trim();
const FROZEN_ABI = (name: string): Abi =>
  JSON.parse(
    readFileSync(
      resolve(
        dirname(new URL(import.meta.url).pathname),
        `../src/evm/abis/zero-seed-launch/${name}.abi.json`,
      ),
      "utf8",
    ),
  ) as Abi;

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

type Action = { label: string; hash: Hex; verify?: () => Promise<void> };
type Block = {
  number: number;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  actions: string[];
};
type PoolKey = { token0: Address; token1: Address; config: Hex };
type Installation = {
  token: Address;
  poolKey: PoolKey;
  positionId: Hex;
  initialTick: number;
  liquidity: bigint;
  installedSupply: bigint;
  tickSpacing: number;
  askTick: number;
  upperTick: number;
};
type Launch = {
  label: string;
  instance: string;
  token: Address;
  quote: Address;
  quoteKind: "native" | "erc20";
  tokenIsToken1: boolean;
  extension: Address;
  periphery: Address;
  poolKey: PoolKey;
  poolId: Hex;
  positionId: Hex;
  userSalt: Hex;
  owner: Address;
  requestedSupply: string;
  installedSupply: string;
  sinkSupply: string;
  liquidity: string;
  initialTick: number;
  logoUrl: Hex;
  tickSpacing: number;
  alignedAskTick: number;
  alignedUpperTick: number;
};
type Branch = { blocks: Block[]; logs: unknown[]; states: unknown[] };
type Instance = {
  label: string;
  extension: Address;
  extensionSalt: Hex;
  periphery: Address;
  peripherySalt: Hex;
  extensionRuntimeKeccak: Hex;
  peripheryRuntimeKeccak: Hex;
  extensionRuntimeTemplateKeccak: Hex;
  peripheryRuntimeTemplateKeccak: Hex;
  deploymentBlock: number;
  scope: string;
};

const launches = new Map<string, Launch>();
const allLaunches = new Map<string, Launch>();
const instances = new Map<string, Instance>();
const installations = new Map<string, Record<string, unknown>>();
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
  for (const { verify } of sent) await verify?.();
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

async function launchReads(launch: Launch, block: bigint, timestamp: number) {
  const read = (
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<unknown> =>
    pub.readContract({ address, abi, functionName, args, blockNumber: block });
  return {
    poolStateWord: await pub.getStorageAt({
      address: CORE,
      slot: launch.poolId,
      blockNumber: block,
    }),
    fees: (await read(launch.extension, LAUNCH.abi, "creatorFees", [
      launch.poolKey,
    ])) as readonly [bigint, bigint],
    owner: (await read(launch.periphery, PERIPHERY.abi, "launchOwner", [
      launch.poolId,
    ])) as Address,
    stored: (await read(launch.extension, LAUNCH.abi, "getLaunch", [
      launch.poolId,
    ])) as { controller: Address },
    feeAt: (await read(launch.extension, LAUNCH.abi, "feeAt", [
      launch.poolId,
      BigInt(timestamp),
    ])) as bigint,
    totalSupply: (await read(launch.token, ERC20_ABI, "totalSupply")) as bigint,
    sinkBalance: (await read(launch.token, ERC20_ABI, "balanceOf", [
      zeroAddress,
    ])) as bigint,
  };
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
    const r = await launchReads(
      launch,
      block,
      current.blocks.at(-1)!.timestamp,
    );
    if (
      String(r.totalSupply) !== launch.requestedSupply ||
      String(r.sinkBalance) !== launch.sinkSupply
    )
      throw new Error(`${launch.label}: totalSupply or sink balance moved`);
    pools.push({
      label: launch.label,
      poolId: launch.poolId,
      poolStateWord: r.poolStateWord,
      creatorFees: r.fees.map(String),
      launchOwner: r.owner,
      controller: r.stored.controller,
      feeAtBlockTime: String(r.feeAt),
      totalSupply: String(r.totalSupply),
      sinkBalance: String(r.sinkBalance),
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

/** The runtime with every immutable zero-filled: the manifest's template. */
function templateOf(code: Hex, build: Artifact): Hex {
  const bytes = Buffer.from(code.slice(2), "hex");
  for (const refs of Object.values(
    build.deployedBytecode.immutableReferences ?? {},
  ))
    for (const { start, length } of refs) bytes.fill(0, start, start + length);
  return toHex(bytes);
}

/** Deploys the extension at a mined call-point salt and its periphery at salt 0, in one block. */
function deployInstance(label: string) {
  const initCode = concat([
    LAUNCH.bytecode.object,
    encodeAbiParameters([{ type: "address" }], [CORE]),
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
    extension,
    extensionSalt,
    periphery,
    peripherySalt,
    extensionRuntimeKeccak: "0x",
    peripheryRuntimeKeccak: "0x",
    extensionRuntimeTemplateKeccak: "0x",
    peripheryRuntimeTemplateKeccak: "0x",
    deploymentBlock: 0,
    scope:
      "one extension and periphery for every quote (native ETH and the relocated plain test ERC-20 here), local only",
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

const deployRouter = async (): Promise<Action> => ({
  label: "deploy LaunchTestRouter",
  hash: await send(
    TRADER,
    null,
    concat([
      ROUTER_BUILD.bytecode.object,
      encodeAbiParameters([{ type: "address" }], [CORE]),
    ]),
  ),
});

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
        args: [ROUTER, maxUint256],
      }),
    ),
  });

type Spec = {
  label: string;
  instance: string;
  quote: Address;
  owner: Address;
  // Q32.32 ticks per second (default: the one-day half-life)
  decayRateX32?: bigint;
  initialFee: bigint;
  finalFee?: bigint;
  tradingStart: number;
  // defaults: REQUESTED_SUPPLY over [ASK_18_18, ASK_18_18 + WIDTH]
  supply?: bigint;
  askTick?: number;
  upperTick?: number;
  // LaunchCreated.logoUrl as raw bytes (default: empty)
  logo?: Hex;
  // raw name content (default: "Zero Seed <label>")
  name?: Hex;
};

/** A canonical Solady LibString.packOne word: length byte, content, zeros. */
function packOne(content: Hex): Hex {
  const length = (content.length - 2) / 2;
  if (length < 1 || length > 31) throw new Error("packOne length");
  return pad(concat([toHex(length, { size: 1 }), content]), {
    dir: "right",
    size: 32,
  });
}

const poolIdOf = (key: PoolKey) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
      [key.token0, key.token1, key.config],
    ),
  );

const sameInstallation = (a: Installation, b: Installation) =>
  canonicalJson(a) === canonicalJson(b);

/**
 * The requested parameters, the periphery preview (checked against the
 * extension preview with the owner-namespaced salt) and the Installation that
 * create returns when simulated on the pending block. The requested supply is
 * submitted unchanged; the extension computes the liquidity.
 */
function launchParameters(spec: Spec, userSalt: Hex) {
  const askTick = spec.askTick ?? ASK_18_18;
  return {
    name: packOne(spec.name ?? toHex(`Zero Seed ${spec.label}`)),
    symbol: packOne(toHex(spec.label.toUpperCase())),
    supply: spec.supply ?? REQUESTED_SUPPLY,
    quoteToken: spec.quote,
    askTick,
    upperTick: spec.upperTick ?? askTick + WIDTH,
    tradingStart: BigInt(spec.tradingStart),
    decayRateX32: spec.decayRateX32 ?? DECAY_RATE_DEFAULT,
    initialFee: spec.initialFee,
    finalFee: spec.finalFee ?? FEE_03,
    salt: userSalt,
  };
}

// create(parameters, logoUrl) with logoUrl typed as bytes: the same ABI
// encoding, so a logo of arbitrary bytes (invalid UTF-8, NUL) can be sent.
const CREATE_WITH_RAW_LOGO = [
  {
    ...(PERIPHERY.abi.find(
      (item) => item.type === "function" && item.name === "create",
    ) as Extract<Abi[number], { type: "function" }>),
  },
].map((item) => ({
  ...item,
  inputs: item.inputs.map((input) =>
    input.name === "logoUrl" ? { ...input, type: "bytes" } : input,
  ),
})) as Abi;
const CREATE_SELECTOR = toFunctionSelector(
  PERIPHERY.abi.find(
    (item) => item.type === "function" && item.name === "create",
  ) as Extract<Abi[number], { type: "function" }>,
);
if (CREATE_SELECTOR !== "0x9a09bd5d") throw new Error("create selector");

async function prepareLaunch(spec: Spec) {
  const instance = instances.get(spec.instance)!;
  const userSalt = keccak256(toHex(spec.label));
  const parameters = launchParameters(spec, userSalt);
  const requested = parameters.supply;
  const preview = (await pub.readContract({
    address: instance.periphery,
    abi: PERIPHERY.abi,
    functionName: "previewInstallation",
    args: [spec.owner, parameters],
    // pending: the deployment block previews against its own queued deployment
    blockTag: "pending",
  })) as Installation;
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
  })) as Installation;
  if (!sameInstallation(direct, preview))
    throw new Error("periphery preview does not namespace the salt");
  const logoUrl = spec.logo ?? "0x";
  // The bytes variant has another selector; the argument encoding is the
  // same, so it is sent under create(LaunchParameters,string).
  const data = concat([
    CREATE_SELECTOR,
    slice(
      encodeFunctionData({
        abi: CREATE_WITH_RAW_LOGO,
        functionName: "create",
        args: [parameters, logoUrl],
      }),
      4,
    ),
  ]);
  const { data: returned } = await pub.call({
    account: spec.owner,
    to: instance.periphery,
    data,
    blockTag: "pending",
    gas: GAS,
  });
  const created = decodeFunctionResult({
    abi: PERIPHERY.abi,
    functionName: "create",
    data: returned!,
  }) as Installation;
  if (!sameInstallation(created, preview))
    throw new Error(`${spec.label}: create returns another installation`);
  const tokenIsToken1 = BigInt(preview.token) > BigInt(spec.quote);
  if (tokenIsToken1 !== (spec.quote === NATIVE))
    throw new Error(`unexpected token order for ${spec.label}`);
  const installed = preview.installedSupply;
  if (installed <= 0n || installed > requested)
    throw new Error(`${spec.label}: installed supply out of range`);
  const launch: Launch = {
    label: spec.label,
    instance: spec.instance,
    token: preview.token,
    quote: spec.quote,
    quoteKind: spec.quote === NATIVE ? "native" : "erc20",
    tokenIsToken1,
    extension: instance.extension,
    periphery: instance.periphery,
    poolKey: preview.poolKey,
    poolId: poolIdOf(preview.poolKey),
    positionId: preview.positionId,
    userSalt,
    owner: spec.owner,
    requestedSupply: String(requested),
    installedSupply: String(installed),
    sinkSupply: String(requested - installed),
    liquidity: String(preview.liquidity),
    initialTick: preview.initialTick,
    logoUrl,
    tickSpacing: preview.tickSpacing,
    alignedAskTick: preview.askTick,
    alignedUpperTick: preview.upperTick,
  };
  installations.set(spec.label, {
    requestedSupply: launch.requestedSupply,
    installedSupply: launch.installedSupply,
    sinkSupply: launch.sinkSupply,
    liquidity: launch.liquidity,
    quote: spec.quote,
    quoteKind: launch.quoteKind,
    tradingStart: spec.tradingStart,
    previewBlock: Number(await pub.getBlockNumber()),
    owner: spec.owner,
    userSalt,
    extensionSalt: namespaced,
    predictedToken: preview.token,
    instance: spec.instance,
    // what previewInstallation and the simulated create returned (identical)
    installation: {
      token: preview.token,
      poolKey: preview.poolKey,
      positionId: preview.positionId,
      initialTick: preview.initialTick,
      liquidity: String(preview.liquidity),
      installedSupply: String(installed),
      tickSpacing: preview.tickSpacing,
      askTick: preview.askTick,
      upperTick: preview.upperTick,
    },
  });
  return { data, launch };
}

/**
 * After the creation is mined: LaunchCreated carries the requested supply and
 * the quote, Core's PositionUpdated of the extension added exactly the
 * computed liquidity for exactly the installed supply and no quote, the sink
 * was minted to address(0), and totalSupply is the requested supply.
 */
async function verifyCreation(launch: Launch, hash: Hex) {
  const receipt = await pub.getTransactionReceipt({ hash });
  const decoded = receipt.logs.flatMap((log) => {
    for (const abi of [LAUNCH.abi, CORE_BUILD.abi, ERC20_ABI as Abi])
      try {
        return [
          {
            address: log.address.toLowerCase(),
            ...decodeEventLog({ abi, topics: log.topics, data: log.data }),
          },
        ];
      } catch {
        // another contract's event
      }
    return [];
  }) as { address: string; eventName: string; args: never }[];
  const created = decoded.filter((l) => l.eventName === "LaunchCreated");
  const positions = decoded.filter(
    (l) =>
      l.eventName === "PositionUpdated" &&
      l.address === CORE.toLowerCase() &&
      (l.args as { poolId: Hex }).poolId === launch.poolId,
  );
  if (created.length !== 1 || positions.length !== 1)
    throw new Error(`${launch.label}: not one creation and one position`);
  const event = created[0].args as {
    liquidity: bigint;
    parameters: { supply: bigint; quoteToken: Address };
  };
  const position = positions[0].args as {
    locker: Address;
    positionId: Hex;
    liquidityDelta: bigint;
    balanceUpdate: Hex;
  };
  const { delta0, delta1 } = parsePoolBalanceUpdate(position.balanceUpdate);
  const [tokenDelta, quoteDelta] = launch.tokenIsToken1
    ? [delta1, delta0]
    : [delta0, delta1];
  const mints = decoded.filter(
    (l) =>
      l.eventName === "Transfer" &&
      l.address === launch.token.toLowerCase() &&
      BigInt((l.args as { from: Address }).from) === 0n,
  ) as unknown as { args: { to: Address; amount: bigint } }[];
  const sinkMints = mints.filter((l) => BigInt(l.args.to) === 0n);
  const coreMints = mints.filter((l) => BigInt(l.args.to) === BigInt(CORE));
  const block = receipt.blockNumber;
  const totalSupply = await pub.readContract({
    address: launch.token,
    abi: ERC20_ABI,
    functionName: "totalSupply",
    blockNumber: block,
  });
  const sinkBalance = await quoteBalance(launch.token, zeroAddress, block);
  const checks: [boolean, string][] = [
    [String(event.parameters.supply) === launch.requestedSupply, "supply"],
    [BigInt(event.parameters.quoteToken) === BigInt(launch.quote), "quote"],
    [String(event.liquidity) === launch.liquidity, "liquidity"],
    [BigInt(position.locker) === BigInt(launch.extension), "locker"],
    [position.positionId === launch.positionId, "position"],
    [String(position.liquidityDelta) === launch.liquidity, "Core liquidity"],
    [String(tokenDelta) === launch.installedSupply, "Core installed delta"],
    [quoteDelta === 0n, "Core quote delta"],
    [String(totalSupply) === launch.requestedSupply, "totalSupply"],
    [String(sinkBalance) === launch.sinkSupply, "balanceOf(0)"],
    [
      BigInt(launch.sinkSupply) === 0n
        ? sinkMints.length === 0
        : sinkMints.length === 1 &&
          String((sinkMints[0].args as { amount: bigint }).amount) ===
            launch.sinkSupply,
      "Transfer(0, 0, sink)",
    ],
    [
      coreMints.length === 1 &&
        String(coreMints[0].args.amount) === launch.installedSupply &&
        mints.length === coreMints.length + sinkMints.length,
      "Transfer(0, Core, installed)",
    ],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([what]) => what);
  if (failed.length > 0)
    throw new Error(`${launch.label} creation: ${failed.join(", ")}`);
  Object.assign(installations.get(launch.label)!, {
    creationBlock: Number(block),
    creationTransaction: hash,
    coreInstalledDelta: String(tokenDelta),
    coreQuoteDelta: String(quoteDelta),
    coreLiquidityDelta: String(position.liquidityDelta),
    totalSupply: String(totalSupply),
    sinkBalance: String(sinkBalance),
  });
}

const create = (spec: Spec) => async (): Promise<Action> => {
  const { data, launch } = await prepareLaunch(spec);
  launches.set(spec.label, launch);
  allLaunches.set(spec.label, launch);
  const hash = await send(spec.owner, launch.periphery, data);
  return {
    label: `create ${spec.label}`,
    hash,
    verify: () => verifyCreation(launch, hash),
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

const MAX_NATIVE_IN = 10n ** 24n;

/**
 * amount > 0: exact input of the token being sold; amount < 0: exact output
 * of the token being bought. The threshold is a positive minimum output (or a
 * negative maximum input); zero is only used for the deliberate no-bid fill,
 * the only swap that allows a partial fill. A native buy attaches the exact
 * input, or a maximum input the router refunds.
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
    const minOut = threshold ?? (amount > 0n ? 1n : -(10n ** 30n));
    const [specified, calculated] =
      sell === amount > 0n
        ? [launch.token, launch.quote]
        : [launch.quote, launch.token];
    return {
      label: `${sell ? "sell" : "buy"} ${label} ${amount > 0n ? "exact-in" : "exact-out"} ${amount}`,
      hash: await send(
        TRADER,
        ROUTER,
        encodeFunctionData({
          abi: ROUTER_BUILD.abi,
          functionName: "swap",
          args: [
            launch.poolKey,
            specified,
            calculated,
            amount,
            minOut,
            minOut === 0n,
            deadline,
          ],
        }),
        value,
      ),
    };
  };

const approveLaunchToken = (label: string) => async () =>
  approve(TRADER, launches.get(label)!.token, `approve ${label} token`)();

const START = T0 + 1_000;
const E18 = 10n ** 18n;
const INSTANCE = "local";

async function prefix() {
  const L1: Spec = {
    label: "l1",
    instance: INSTANCE,
    quote: NATIVE,
    owner: CREATOR,
    logo: toHex("https://example.invalid/l1.svg"),
    decayRateX32: DECAY_RATE_600,
    initialFee: FEE_50,
    tradingStart: START,
  };
  const L2: Spec = {
    label: "l2",
    instance: INSTANCE,
    quote: ERC20_QUOTE,
    owner: CREATOR,
    initialFee: FEE_5,
    tradingStart: START,
  };
  // Deployment block: the instance, then a native launch in the same block.
  const deploymentBlock = await mine(T0 + 10, [
    ...deployInstance(INSTANCE),
    create(L1),
  ]);
  for (const instance of instances.values())
    instance.deploymentBlock = deploymentBlock;
  await mine(T0 + 20, [create(L2), approveLaunchToken("l1")]);
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
    instance: INSTANCE,
    quote: NATIVE,
    owner: NEW_OWNER,
    decayRateX32: 1n << 30n,
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
    instance: INSTANCE,
    quote: ERC20_QUOTE,
    owner: TRADER,
    // not UTF-8, with a NUL: stored as bytes only
    logo: "0x68747470733a2f2fff00",
    decayRateX32: 0n,
    initialFee: FEE_5,
    tradingStart: START + 400,
  };
  // Two launches at the highest rate, created normally through the periphery:
  // native max -> 0.3% over 3,600 s and ERC-20 flat at the maximum.
  const L5: Spec = {
    label: "l5",
    instance: INSTANCE,
    quote: NATIVE,
    owner: CREATOR,
    logo: toHex("ipfs://bafy\u00e9logo \ud83d\ude80"),
    name: toHex("Z\u00e9ro \ud83d\ude80"),
    // 2^64 - 1 ticks/s: at the floor from the first second
    decayRateX32: FEE_MAX,
    initialFee: FEE_MAX,
    tradingStart: START + 400,
  };
  const L6: Spec = {
    label: "l6",
    instance: INSTANCE,
    quote: ERC20_QUOTE,
    owner: TRADER,
    // not UTF-8: the name is kept as its packed word only
    name: "0x5aff00",
    decayRateX32: 1n,
    initialFee: FEE_MAX,
    finalFee: FEE_MAX,
    tradingStart: START + 400,
  };
  await mine(START + 310, [
    swap("l1", false, 2n * E18, START + 310),
    claim("l2", NEW_OWNER, NEW_OWNER),
    create(L4),
    create(L5),
    create(L6),
  ]);
  // At 2^64 - 1 an exact-input buy nets floor(gross / 2^64) launch tokens and
  // an exact-output buy pays calculated * 2^64 quote.
  await mine(START + 400, [
    approveLaunchToken("l4"),
    swap("l4", true, E18, START + 400, 0n),
    swap("l4", false, 7n * E18, START + 400),
    approveLaunchToken("l5"),
    approveLaunchToken("l6"),
    swap("l5", false, E18, START + 400),
    swap("l5", false, -(10n ** 10n), START + 400),
    swap("l6", false, E18, START + 400),
    swap("l6", false, -(10n ** 10n), START + 400),
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
    swap("l5", false, E18, START + 1800),
    claim("l6", TRADER, FEE_RECIPIENT),
  ]);
  await mine(START + 3599, [swap("l1", false, E18, START + 3599)]);
  await mine(START + 3600, [
    swap("l1", false, E18, START + 3600),
    claim("l4", TRADER, FEE_RECIPIENT),
  ]);
  // l5 has decayed from the maximum to its 0.3% final rate.
  await mine(START + 4000, [
    swap("l5", true, 10n ** 10n, START + 4000),
    swap("l5", false, E18, START + 4000),
    claim("l5", CREATOR, FEE_RECIPIENT),
  ]);
  // Two ERC-20 (token0) launches at low prices, where the exact token0
  // inverse installs more than the shared helper: 1e30 over the narrow range
  // near the bottom of the tick space (helper L 106052588672, sink about
  // 7.84%; exact L 115073586432) and int128-scale supply over the full width
  // at spacing 1 (exact L installs the requested supply, no sink mint).
  const L7: Spec = {
    label: "l7",
    instance: INSTANCE,
    quote: ERC20_QUOTE,
    owner: CREATOR,
    initialFee: FEE_50,
    tradingStart: START + 4200,
    supply: 10n ** 30n,
    askTick: -88080384,
    upperTick: -85983232,
  };
  const L8: Spec = {
    label: "l8",
    instance: INSTANCE,
    quote: ERC20_QUOTE,
    owner: TRADER,
    initialFee: FEE_50,
    tradingStart: START + 4200,
    supply: 10n ** 30n,
    askTick: -88722835,
    upperTick: 88722835,
  };
  await mine(START + 4100, [create(L7), create(L8)]);
  await mine(START + 4200, [
    swap("l7", false, -(10n ** 20n), START + 4200),
    swap("l8", false, -(10n ** 20n), START + 4200),
  ]);
  const tenYears = START + 10 * 365 * 86_400;
  await mine(tenYears, [
    swap("l1", true, 10n ** 23n, tenYears),
    claim("l1", FEE_RECIPIENT, NEW_OWNER),
    claim("l1", FEE_RECIPIENT, NEW_OWNER),
  ]);
}

/** Entries in a stable order, so ABIs compare regardless of compiler order. */
const sortedAbi = (abi: Abi) => abi.map((entry) => canonicalJson(entry)).sort();

function validateFixtureBuild() {
  if (
    git("rev-parse", "HEAD") !== SOURCE_COMMIT ||
    git(
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--ignore-submodules=all",
    ) !== ""
  )
    throw new Error(`fixture requires the clean source at ${SOURCE_COMMIT}`);
  for (const [name, build] of [
    ["ZeroSeedLaunch", LAUNCH],
    ["ZeroSeedLaunchPeriphery", PERIPHERY],
  ] as const)
    if (
      canonicalJson(sortedAbi(build.abi)) !==
      canonicalJson(sortedAbi(FROZEN_ABI(name)))
    )
      throw new Error(`${name} build ABI differs from the frozen ABI`);
}

/** Solady ERC20 balance slot: keccak256(owner ++ 8 zero bytes ++ 0x87a211a2). */
const soladyBalanceSlot = (owner: Address) =>
  keccak256(
    encodePacked(["address", "uint64", "uint32"], [owner, 0n, 0x87a211a2]),
  );
const SOLADY_TOTAL_SUPPLY_SLOT = pad("0x05345cdf77eb68f44c", { size: 32 });

/**
 * The checkout's plain test ERC-20 (TestToken: Solady ERC20, 18 decimals, no
 * immutables, no hooks) at 0xff..ff, so a launch token always sorts below it.
 * Its constructor would mint 2^256-1 to a recipient; the same state is
 * written directly for TRADER and read back through the token.
 */
async function relocateQuote() {
  await test.setCode({
    address: ERC20_QUOTE,
    bytecode: QUOTE_BUILD.deployedBytecode.object,
  });
  const max = toHex(maxUint256, { size: 32 });
  await test.setStorageAt({
    address: ERC20_QUOTE,
    index: soladyBalanceSlot(TRADER),
    value: max,
  });
  await test.setStorageAt({
    address: ERC20_QUOTE,
    index: SOLADY_TOTAL_SUPPLY_SLOT,
    value: max,
  });
  const [balance, supply] = await Promise.all([
    quoteBalance(ERC20_QUOTE, TRADER, await pub.getBlockNumber()),
    pub.readContract({
      address: ERC20_QUOTE,
      abi: ERC20_ABI,
      functionName: "totalSupply",
    }),
  ]);
  if (balance !== maxUint256 || supply !== maxUint256)
    throw new Error("relocated ERC-20 quote state mismatch");
}

async function bindInstances() {
  for (const instance of instances.values()) {
    const extensionCode = (await pub.getCode({ address: instance.extension }))!;
    const peripheryCode = (await pub.getCode({ address: instance.periphery }))!;
    instance.extensionRuntimeKeccak = keccak256(extensionCode);
    instance.peripheryRuntimeKeccak = keccak256(peripheryCode);
    instance.extensionRuntimeTemplateKeccak = keccak256(
      templateOf(extensionCode, LAUNCH),
    );
    instance.peripheryRuntimeTemplateKeccak = keccak256(
      templateOf(peripheryCode, PERIPHERY),
    );
    if (
      instance.extensionRuntimeTemplateKeccak !==
        keccak256(templateOf(LAUNCH.deployedBytecode.object, LAUNCH)) ||
      instance.peripheryRuntimeTemplateKeccak !==
        keccak256(templateOf(PERIPHERY.deployedBytecode.object, PERIPHERY))
    )
      throw new Error("deployed runtime is not the pinned template");
    const actualLaunch = (await pub.readContract({
      address: instance.periphery,
      abi: PERIPHERY.abi,
      functionName: "LAUNCH",
    })) as Address;
    if (BigInt(actualLaunch) !== BigInt(instance.extension))
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
  await relocateQuote();
  const coreCodehash = keccak256((await pub.getCode({ address: CORE }))!);
  const quoteCodehash = keccak256(
    (await pub.getCode({ address: ERC20_QUOTE }))!,
  );

  const branches: Record<string, Branch> = {};
  current = branches.prefix = { blocks: [], logs: [], states: [] };
  await test.setBalance({ address: TRADER, value: 10n ** 32n });
  await mine(T0 + 5, [
    deployRouter,
    approve(TRADER, ERC20_QUOTE, "approve erc20 quote"),
  ]);
  const routerCode = (await pub.getCode({ address: ROUTER }))!;
  const routerCodehash = keccak256(routerCode);
  if (
    keccak256(templateOf(routerCode, ROUTER_BUILD)) !==
    keccak256(ROUTER_BUILD.deployedBytecode.object)
  )
    throw new Error("router runtime is not the compiled LaunchTestRouter");
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
      "Logs and state emitted by a local anvil chain (no fork) running one ZeroSeedLaunch extension and its ZeroSeedLaunchPeriphery over the main Core runtime, with native-ETH and plain-ERC-20 quote launches on the same extension and swaps through the compiled test/LaunchTestRouter.sol. Supplies are raw launch-token units as decimal strings: requestedSupply = LaunchParameters.supply = totalSupply, installedSupply = Core PositionUpdated launch-token delta of the creation, sinkSupply = requested - installed = balanceOf(address(0)). Local fixture, not live evidence.",
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
      routerCreationKeccak: keccak256(ROUTER_BUILD.bytecode.object),
      erc20QuoteRuntimeKeccak: quoteCodehash,
      erc20QuoteSource: "test/TestToken.sol (Solady ERC20), relocated",
      launchAbiSha256: sha256(canonicalJson(LAUNCH.abi)),
      peripheryAbiSha256: sha256(canonicalJson(PERIPHERY.abi)),
      launchCreationKeccak: keccak256(LAUNCH.bytecode.object),
      peripheryCreationKeccak: keccak256(PERIPHERY.bytecode.object),
      launchRuntimeTemplateKeccak: keccak256(
        templateOf(LAUNCH.deployedBytecode.object, LAUNCH),
      ),
      peripheryRuntimeTemplateKeccak: keccak256(
        templateOf(PERIPHERY.deployedBytecode.object, PERIPHERY),
      ),
      buildSubmodules:
        "excluded from git dirty check; canonical ABI, creation code and runtime template checked independently",
    },
    chainId: CHAIN_ID,
    instances: [...instances.values()],
    addresses: {
      core: CORE,
      router: ROUTER,
      erc20Quote: ERC20_QUOTE,
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
  writeFileSync(
    OUT,
    `${JSON.stringify(fixture, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v), 1)}\n`,
  );
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
