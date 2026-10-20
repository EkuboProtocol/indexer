// ZeroSeedLaunch and ZeroSeedLaunchPeriphery ABIs: EkuboProtocol/evm-contracts
// 4f1a3060b099e8a50469848118f44c0c65cfab9a (forward-only extension, native
// ETH quote, fixed-base fee table, separate periphery). Verbatim from the
// build artifacts. Each `*_ABI_SHA256` is the sha256 of `jq -cS .abi` output
// without a trailing newline (the protocol manifest's convention); a test
// recomputes it. Any change here is an interface change.
export const ZERO_SEED_LAUNCH_ABI_SHA256 =
  "21f9e2c0166ab28ce8573c481de5b0fc2f37dd7595d496d326f0a2d1a544254e";

export const ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256 =
  "5c563488b843aee923d0d819a66489eeee543dd20d1582de1f5df643f5d08a75";

export const ZERO_SEED_LAUNCH_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "core",
        type: "address",
        internalType: "contract ICore",
      },
      {
        name: "quote",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "afterCollectFees",
    inputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "Locker",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct PoolKey",
        components: [
          {
            name: "token0",
            type: "address",
            internalType: "address",
          },
          {
            name: "token1",
            type: "address",
            internalType: "address",
          },
          {
            name: "config",
            type: "bytes32",
            internalType: "PoolConfig",
          },
        ],
      },
      {
        name: "",
        type: "bytes32",
        internalType: "PositionId",
      },
      {
        name: "",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "afterInitializePool",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct PoolKey",
        components: [
          {
            name: "token0",
            type: "address",
            internalType: "address",
          },
          {
            name: "token1",
            type: "address",
            internalType: "address",
          },
          {
            name: "config",
            type: "bytes32",
            internalType: "PoolConfig",
          },
        ],
      },
      {
        name: "",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "",
        type: "uint96",
        internalType: "SqrtRatio",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "afterSwap",
    inputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "Locker",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct PoolKey",
        components: [
          {
            name: "token0",
            type: "address",
            internalType: "address",
          },
          {
            name: "token1",
            type: "address",
            internalType: "address",
          },
          {
            name: "config",
            type: "bytes32",
            internalType: "PoolConfig",
          },
        ],
      },
      {
        name: "",
        type: "bytes32",
        internalType: "SwapParameters",
      },
      {
        name: "",
        type: "bytes32",
        internalType: "PoolBalanceUpdate",
      },
      {
        name: "",
        type: "bytes32",
        internalType: "PoolState",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "afterUpdatePosition",
    inputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "Locker",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct PoolKey",
        components: [
          {
            name: "token0",
            type: "address",
            internalType: "address",
          },
          {
            name: "token1",
            type: "address",
            internalType: "address",
          },
          {
            name: "config",
            type: "bytes32",
            internalType: "PoolConfig",
          },
        ],
      },
      {
        name: "",
        type: "bytes32",
        internalType: "PositionId",
      },
      {
        name: "",
        type: "int128",
        internalType: "int128",
      },
      {
        name: "",
        type: "bytes32",
        internalType: "PoolBalanceUpdate",
      },
      {
        name: "",
        type: "bytes32",
        internalType: "PoolState",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "beforeCollectFees",
    inputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "Locker",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct PoolKey",
        components: [
          {
            name: "token0",
            type: "address",
            internalType: "address",
          },
          {
            name: "token1",
            type: "address",
            internalType: "address",
          },
          {
            name: "config",
            type: "bytes32",
            internalType: "PoolConfig",
          },
        ],
      },
      {
        name: "",
        type: "bytes32",
        internalType: "PositionId",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "beforeInitializePool",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct PoolKey",
        components: [
          {
            name: "token0",
            type: "address",
            internalType: "address",
          },
          {
            name: "token1",
            type: "address",
            internalType: "address",
          },
          {
            name: "config",
            type: "bytes32",
            internalType: "PoolConfig",
          },
        ],
      },
      {
        name: "",
        type: "int32",
        internalType: "int32",
      },
    ],
    outputs: [],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "beforeSwap",
    inputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "Locker",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct PoolKey",
        components: [
          {
            name: "token0",
            type: "address",
            internalType: "address",
          },
          {
            name: "token1",
            type: "address",
            internalType: "address",
          },
          {
            name: "config",
            type: "bytes32",
            internalType: "PoolConfig",
          },
        ],
      },
      {
        name: "",
        type: "bytes32",
        internalType: "SwapParameters",
      },
    ],
    outputs: [],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "beforeUpdatePosition",
    inputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "Locker",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct PoolKey",
        components: [
          {
            name: "token0",
            type: "address",
            internalType: "address",
          },
          {
            name: "token1",
            type: "address",
            internalType: "address",
          },
          {
            name: "config",
            type: "bytes32",
            internalType: "PoolConfig",
          },
        ],
      },
      {
        name: "",
        type: "bytes32",
        internalType: "PositionId",
      },
      {
        name: "",
        type: "int128",
        internalType: "int128",
      },
    ],
    outputs: [],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "creatorFees",
    inputs: [
      {
        name: "poolKey",
        type: "tuple",
        internalType: "struct PoolKey",
        components: [
          {
            name: "token0",
            type: "address",
            internalType: "address",
          },
          {
            name: "token1",
            type: "address",
            internalType: "address",
          },
          {
            name: "config",
            type: "bytes32",
            internalType: "PoolConfig",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "feeAt",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        internalType: "PoolId",
      },
      {
        name: "timestamp",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "forwarded_2374103877",
    inputs: [
      {
        name: "original",
        type: "bytes32",
        internalType: "Locker",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getLaunch",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        internalType: "PoolId",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct IZeroSeedLaunch.Launch",
        components: [
          {
            name: "controller",
            type: "address",
            internalType: "address",
          },
          {
            name: "tradingStart",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "feeDuration",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "initialFee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "finalFee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "tickLower",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "tickUpper",
            type: "int32",
            internalType: "int32",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "previewInstallation",
    inputs: [
      {
        name: "controller",
        type: "address",
        internalType: "address",
      },
      {
        name: "parameters",
        type: "tuple",
        internalType: "struct IZeroSeedLaunch.LaunchParameters",
        components: [
          {
            name: "name",
            type: "string",
            internalType: "string",
          },
          {
            name: "symbol",
            type: "string",
            internalType: "string",
          },
          {
            name: "decimals",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "supply",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "liquidity",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "askTick",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upperTick",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "tradingStart",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "feeDuration",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "initialFee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "finalFee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "salt",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct IZeroSeedLaunch.Installation",
        components: [
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "poolKey",
            type: "tuple",
            internalType: "struct PoolKey",
            components: [
              {
                name: "token0",
                type: "address",
                internalType: "address",
              },
              {
                name: "token1",
                type: "address",
                internalType: "address",
              },
              {
                name: "config",
                type: "bytes32",
                internalType: "PoolConfig",
              },
            ],
          },
          {
            name: "positionId",
            type: "bytes32",
            internalType: "PositionId",
          },
          {
            name: "initialTick",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "liquidity",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "installedSupply",
            type: "uint128",
            internalType: "uint128",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "quoteToken",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "CreatorFeesClaimed",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
        internalType: "PoolId",
      },
      {
        name: "controller",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount0",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
      {
        name: "amount1",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "LaunchCreated",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
        internalType: "PoolId",
      },
      {
        name: "token",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "controller",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "poolKey",
        type: "tuple",
        indexed: false,
        internalType: "struct PoolKey",
        components: [
          {
            name: "token0",
            type: "address",
            internalType: "address",
          },
          {
            name: "token1",
            type: "address",
            internalType: "address",
          },
          {
            name: "config",
            type: "bytes32",
            internalType: "PoolConfig",
          },
        ],
      },
      {
        name: "positionId",
        type: "bytes32",
        indexed: false,
        internalType: "PositionId",
      },
      {
        name: "liquidity",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
      {
        name: "parameters",
        type: "tuple",
        indexed: false,
        internalType: "struct IZeroSeedLaunch.LaunchParameters",
        components: [
          {
            name: "name",
            type: "string",
            internalType: "string",
          },
          {
            name: "symbol",
            type: "string",
            internalType: "string",
          },
          {
            name: "decimals",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "supply",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "liquidity",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "askTick",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upperTick",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "tradingStart",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "feeDuration",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "initialFee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "finalFee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "salt",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "LaunchSwapped",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
        internalType: "PoolId",
      },
      {
        name: "locker",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "delta0",
        type: "int128",
        indexed: false,
        internalType: "int128",
      },
      {
        name: "delta1",
        type: "int128",
        indexed: false,
        internalType: "int128",
      },
      {
        name: "feeRate",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
      {
        name: "feeAmount",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
      {
        name: "feeIsToken1",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "BaseForwardeeAccountantOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "BoundsOrder",
    inputs: [],
  },
  {
    type: "error",
    name: "BoundsTickSpacing",
    inputs: [],
  },
  {
    type: "error",
    name: "CallPointNotImplemented",
    inputs: [],
  },
  {
    type: "error",
    name: "ControllerOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "CoreOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "FeeTooHigh",
    inputs: [],
  },
  {
    type: "error",
    name: "InitializeThroughCreateOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidFeeSchedule",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidParameters",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidTick",
    inputs: [
      {
        name: "tick",
        type: "int32",
        internalType: "int32",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidTradingStart",
    inputs: [],
  },
  {
    type: "error",
    name: "LaunchTokenExists",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "LiquidityAboveTickCap",
    inputs: [
      {
        name: "liquidity",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "cap",
        type: "uint128",
        internalType: "uint128",
      },
    ],
  },
  {
    type: "error",
    name: "MetadataTooLong",
    inputs: [],
  },
  {
    type: "error",
    name: "MinMaxBounds",
    inputs: [],
  },
  {
    type: "error",
    name: "PositionsThroughCreateOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "StableswapMustBeFullRange",
    inputs: [],
  },
  {
    type: "error",
    name: "SupplyNotExactlyInstallable",
    inputs: [
      {
        name: "requested",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "installable",
        type: "uint128",
        internalType: "uint128",
      },
    ],
  },
  {
    type: "error",
    name: "SwapsThroughForwardOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "TradingNotStarted",
    inputs: [],
  },
  {
    type: "error",
    name: "UnknownForwardAction",
    inputs: [],
  },
  {
    type: "error",
    name: "UnknownLaunch",
    inputs: [],
  },
  {
    type: "error",
    name: "UnsupportedQuoteToken",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroLiquidity",
    inputs: [],
  },
] as const;

export const ZERO_SEED_LAUNCH_PERIPHERY_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "core",
        type: "address",
        internalType: "contract ICore",
      },
      {
        name: "launch",
        type: "address",
        internalType: "contract IZeroSeedLaunch",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "LAUNCH",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IZeroSeedLaunch",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "claimFees",
    inputs: [
      {
        name: "poolKey",
        type: "tuple",
        internalType: "struct PoolKey",
        components: [
          {
            name: "token0",
            type: "address",
            internalType: "address",
          },
          {
            name: "token1",
            type: "address",
            internalType: "address",
          },
          {
            name: "config",
            type: "bytes32",
            internalType: "PoolConfig",
          },
        ],
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "amount0",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "amount1",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "create",
    inputs: [
      {
        name: "parameters",
        type: "tuple",
        internalType: "struct IZeroSeedLaunch.LaunchParameters",
        components: [
          {
            name: "name",
            type: "string",
            internalType: "string",
          },
          {
            name: "symbol",
            type: "string",
            internalType: "string",
          },
          {
            name: "decimals",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "supply",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "liquidity",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "askTick",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upperTick",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "tradingStart",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "feeDuration",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "initialFee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "finalFee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "salt",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "installation",
        type: "tuple",
        internalType: "struct IZeroSeedLaunch.Installation",
        components: [
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "poolKey",
            type: "tuple",
            internalType: "struct PoolKey",
            components: [
              {
                name: "token0",
                type: "address",
                internalType: "address",
              },
              {
                name: "token1",
                type: "address",
                internalType: "address",
              },
              {
                name: "config",
                type: "bytes32",
                internalType: "PoolConfig",
              },
            ],
          },
          {
            name: "positionId",
            type: "bytes32",
            internalType: "PositionId",
          },
          {
            name: "initialTick",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "liquidity",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "installedSupply",
            type: "uint128",
            internalType: "uint128",
          },
        ],
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "launchOwner",
    inputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "PoolId",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "locked_6416899205",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "previewInstallation",
    inputs: [
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
      {
        name: "parameters",
        type: "tuple",
        internalType: "struct IZeroSeedLaunch.LaunchParameters",
        components: [
          {
            name: "name",
            type: "string",
            internalType: "string",
          },
          {
            name: "symbol",
            type: "string",
            internalType: "string",
          },
          {
            name: "decimals",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "supply",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "liquidity",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "askTick",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upperTick",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "tradingStart",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "feeDuration",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "initialFee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "finalFee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "salt",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct IZeroSeedLaunch.Installation",
        components: [
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "poolKey",
            type: "tuple",
            internalType: "struct PoolKey",
            components: [
              {
                name: "token0",
                type: "address",
                internalType: "address",
              },
              {
                name: "token1",
                type: "address",
                internalType: "address",
              },
              {
                name: "config",
                type: "bytes32",
                internalType: "PoolConfig",
              },
            ],
          },
          {
            name: "positionId",
            type: "bytes32",
            internalType: "PositionId",
          },
          {
            name: "initialTick",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "liquidity",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "installedSupply",
            type: "uint128",
            internalType: "uint128",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transferLaunch",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        internalType: "PoolId",
      },
      {
        name: "newOwner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "LaunchFeesClaimed",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
        internalType: "PoolId",
      },
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount0",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
      {
        name: "amount1",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "LaunchOwnerChanged",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: true,
        internalType: "PoolId",
      },
      {
        name: "previousOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "BaseLockerAccountantOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "ExpectedRevertWithinLock",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidOwner",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidRecipient",
    inputs: [],
  },
  {
    type: "error",
    name: "OwnerOnly",
    inputs: [],
  },
] as const;
