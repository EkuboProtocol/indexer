// The frozen ZeroSeedLaunch, ZeroSeedLaunchPeriphery and LaunchToken ABIs of
// EkuboProtocol/evm-contracts 853b608ec26d4c80bdad6e394cb8ba686e1ae615, as
// `as const` literals so viem types the decoded events. They are copies of
// the compiled JSON in src/evm/abis/zero-seed-launch/ (provenance in
// tests/fixtures/zero-seed-launch/freeze-853b608/PROVENANCE.md), and a test
// asserts each equals its JSON file entry for entry. Do not edit by hand.
export const ZERO_SEED_LAUNCH_SOURCE_COMMIT =
  "853b608ec26d4c80bdad6e394cb8ba686e1ae615";

export const ZERO_SEED_LAUNCH_ABI = [
  {
    inputs: [
      {
        internalType: "contract ICore",
        name: "core",
        type: "address",
      },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [],
    name: "BaseForwardeeAccountantOnly",
    type: "error",
  },
  {
    inputs: [],
    name: "BoundsOrder",
    type: "error",
  },
  {
    inputs: [],
    name: "BoundsTickSpacing",
    type: "error",
  },
  {
    inputs: [],
    name: "CallPointNotImplemented",
    type: "error",
  },
  {
    inputs: [],
    name: "ControllerOnly",
    type: "error",
  },
  {
    inputs: [],
    name: "CoreOnly",
    type: "error",
  },
  {
    inputs: [],
    name: "InitializeThroughCreateOnly",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidFeeSchedule",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidMetadata",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidSupply",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "int32",
        name: "tick",
        type: "int32",
      },
    ],
    name: "InvalidTick",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidTicks",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidTradingStart",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "token",
        type: "address",
      },
    ],
    name: "LaunchTokenExists",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "uint128",
        name: "liquidity",
        type: "uint128",
      },
      {
        internalType: "uint128",
        name: "cap",
        type: "uint128",
      },
    ],
    name: "LiquidityAboveTickCap",
    type: "error",
  },
  {
    inputs: [],
    name: "MinMaxBounds",
    type: "error",
  },
  {
    inputs: [],
    name: "PositionsThroughCreateOnly",
    type: "error",
  },
  {
    inputs: [],
    name: "StableswapMustBeFullRange",
    type: "error",
  },
  {
    inputs: [],
    name: "SwapsThroughForwardOnly",
    type: "error",
  },
  {
    inputs: [],
    name: "TradingNotStarted",
    type: "error",
  },
  {
    inputs: [],
    name: "UnknownForwardAction",
    type: "error",
  },
  {
    inputs: [],
    name: "UnknownLaunch",
    type: "error",
  },
  {
    inputs: [],
    name: "UnsupportedQuoteToken",
    type: "error",
  },
  {
    inputs: [],
    name: "ZeroLiquidity",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "PoolId",
        name: "poolId",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "address",
        name: "controller",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint128",
        name: "amount0",
        type: "uint128",
      },
      {
        indexed: false,
        internalType: "uint128",
        name: "amount1",
        type: "uint128",
      },
    ],
    name: "CreatorFeesClaimed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "PoolId",
        name: "poolId",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "address",
        name: "token",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "controller",
        type: "address",
      },
      {
        components: [
          {
            internalType: "address",
            name: "token0",
            type: "address",
          },
          {
            internalType: "address",
            name: "token1",
            type: "address",
          },
          {
            internalType: "PoolConfig",
            name: "config",
            type: "bytes32",
          },
        ],
        indexed: false,
        internalType: "struct PoolKey",
        name: "poolKey",
        type: "tuple",
      },
      {
        indexed: false,
        internalType: "PositionId",
        name: "positionId",
        type: "bytes32",
      },
      {
        indexed: false,
        internalType: "uint128",
        name: "liquidity",
        type: "uint128",
      },
      {
        components: [
          {
            internalType: "bytes32",
            name: "name",
            type: "bytes32",
          },
          {
            internalType: "bytes32",
            name: "symbol",
            type: "bytes32",
          },
          {
            internalType: "uint128",
            name: "supply",
            type: "uint128",
          },
          {
            internalType: "address",
            name: "quoteToken",
            type: "address",
          },
          {
            internalType: "int32",
            name: "askTick",
            type: "int32",
          },
          {
            internalType: "int32",
            name: "upperTick",
            type: "int32",
          },
          {
            internalType: "uint64",
            name: "tradingStart",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "decayRateX32",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "initialFee",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "finalFee",
            type: "uint64",
          },
          {
            internalType: "bytes32",
            name: "salt",
            type: "bytes32",
          },
        ],
        indexed: false,
        internalType: "struct IZeroSeedLaunch.LaunchParameters",
        name: "parameters",
        type: "tuple",
      },
      {
        indexed: false,
        internalType: "string",
        name: "logoUrl",
        type: "string",
      },
    ],
    name: "LaunchCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "PoolId",
        name: "poolId",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "address",
        name: "locker",
        type: "address",
      },
      {
        indexed: false,
        internalType: "int128",
        name: "delta0",
        type: "int128",
      },
      {
        indexed: false,
        internalType: "int128",
        name: "delta1",
        type: "int128",
      },
      {
        indexed: false,
        internalType: "uint64",
        name: "feeRate",
        type: "uint64",
      },
      {
        indexed: false,
        internalType: "uint128",
        name: "feeAmount",
        type: "uint128",
      },
      {
        indexed: false,
        internalType: "bool",
        name: "feeIsToken1",
        type: "bool",
      },
    ],
    name: "LaunchSwapped",
    type: "event",
  },
  {
    inputs: [
      {
        internalType: "Locker",
        name: "",
        type: "bytes32",
      },
      {
        components: [
          {
            internalType: "address",
            name: "token0",
            type: "address",
          },
          {
            internalType: "address",
            name: "token1",
            type: "address",
          },
          {
            internalType: "PoolConfig",
            name: "config",
            type: "bytes32",
          },
        ],
        internalType: "struct PoolKey",
        name: "",
        type: "tuple",
      },
      {
        internalType: "PositionId",
        name: "",
        type: "bytes32",
      },
      {
        internalType: "uint128",
        name: "",
        type: "uint128",
      },
      {
        internalType: "uint128",
        name: "",
        type: "uint128",
      },
    ],
    name: "afterCollectFees",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
      {
        components: [
          {
            internalType: "address",
            name: "token0",
            type: "address",
          },
          {
            internalType: "address",
            name: "token1",
            type: "address",
          },
          {
            internalType: "PoolConfig",
            name: "config",
            type: "bytes32",
          },
        ],
        internalType: "struct PoolKey",
        name: "",
        type: "tuple",
      },
      {
        internalType: "int32",
        name: "",
        type: "int32",
      },
      {
        internalType: "SqrtRatio",
        name: "",
        type: "uint96",
      },
    ],
    name: "afterInitializePool",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "Locker",
        name: "",
        type: "bytes32",
      },
      {
        components: [
          {
            internalType: "address",
            name: "token0",
            type: "address",
          },
          {
            internalType: "address",
            name: "token1",
            type: "address",
          },
          {
            internalType: "PoolConfig",
            name: "config",
            type: "bytes32",
          },
        ],
        internalType: "struct PoolKey",
        name: "",
        type: "tuple",
      },
      {
        internalType: "SwapParameters",
        name: "",
        type: "bytes32",
      },
      {
        internalType: "PoolBalanceUpdate",
        name: "",
        type: "bytes32",
      },
      {
        internalType: "PoolState",
        name: "",
        type: "bytes32",
      },
    ],
    name: "afterSwap",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "Locker",
        name: "",
        type: "bytes32",
      },
      {
        components: [
          {
            internalType: "address",
            name: "token0",
            type: "address",
          },
          {
            internalType: "address",
            name: "token1",
            type: "address",
          },
          {
            internalType: "PoolConfig",
            name: "config",
            type: "bytes32",
          },
        ],
        internalType: "struct PoolKey",
        name: "",
        type: "tuple",
      },
      {
        internalType: "PositionId",
        name: "",
        type: "bytes32",
      },
      {
        internalType: "int128",
        name: "",
        type: "int128",
      },
      {
        internalType: "PoolBalanceUpdate",
        name: "",
        type: "bytes32",
      },
      {
        internalType: "PoolState",
        name: "",
        type: "bytes32",
      },
    ],
    name: "afterUpdatePosition",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "Locker",
        name: "",
        type: "bytes32",
      },
      {
        components: [
          {
            internalType: "address",
            name: "token0",
            type: "address",
          },
          {
            internalType: "address",
            name: "token1",
            type: "address",
          },
          {
            internalType: "PoolConfig",
            name: "config",
            type: "bytes32",
          },
        ],
        internalType: "struct PoolKey",
        name: "",
        type: "tuple",
      },
      {
        internalType: "PositionId",
        name: "",
        type: "bytes32",
      },
    ],
    name: "beforeCollectFees",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
      {
        components: [
          {
            internalType: "address",
            name: "token0",
            type: "address",
          },
          {
            internalType: "address",
            name: "token1",
            type: "address",
          },
          {
            internalType: "PoolConfig",
            name: "config",
            type: "bytes32",
          },
        ],
        internalType: "struct PoolKey",
        name: "",
        type: "tuple",
      },
      {
        internalType: "int32",
        name: "",
        type: "int32",
      },
    ],
    name: "beforeInitializePool",
    outputs: [],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "Locker",
        name: "",
        type: "bytes32",
      },
      {
        components: [
          {
            internalType: "address",
            name: "token0",
            type: "address",
          },
          {
            internalType: "address",
            name: "token1",
            type: "address",
          },
          {
            internalType: "PoolConfig",
            name: "config",
            type: "bytes32",
          },
        ],
        internalType: "struct PoolKey",
        name: "",
        type: "tuple",
      },
      {
        internalType: "SwapParameters",
        name: "",
        type: "bytes32",
      },
    ],
    name: "beforeSwap",
    outputs: [],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "Locker",
        name: "",
        type: "bytes32",
      },
      {
        components: [
          {
            internalType: "address",
            name: "token0",
            type: "address",
          },
          {
            internalType: "address",
            name: "token1",
            type: "address",
          },
          {
            internalType: "PoolConfig",
            name: "config",
            type: "bytes32",
          },
        ],
        internalType: "struct PoolKey",
        name: "",
        type: "tuple",
      },
      {
        internalType: "PositionId",
        name: "",
        type: "bytes32",
      },
      {
        internalType: "int128",
        name: "",
        type: "int128",
      },
    ],
    name: "beforeUpdatePosition",
    outputs: [],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: "address",
            name: "token0",
            type: "address",
          },
          {
            internalType: "address",
            name: "token1",
            type: "address",
          },
          {
            internalType: "PoolConfig",
            name: "config",
            type: "bytes32",
          },
        ],
        internalType: "struct PoolKey",
        name: "poolKey",
        type: "tuple",
      },
    ],
    name: "creatorFees",
    outputs: [
      {
        internalType: "uint128",
        name: "",
        type: "uint128",
      },
      {
        internalType: "uint128",
        name: "",
        type: "uint128",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "PoolId",
        name: "poolId",
        type: "bytes32",
      },
      {
        internalType: "uint256",
        name: "timestamp",
        type: "uint256",
      },
    ],
    name: "feeAt",
    outputs: [
      {
        internalType: "uint64",
        name: "",
        type: "uint64",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "Locker",
        name: "original",
        type: "bytes32",
      },
    ],
    name: "forwarded_2374103877",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "PoolId",
        name: "poolId",
        type: "bytes32",
      },
    ],
    name: "getLaunch",
    outputs: [
      {
        components: [
          {
            internalType: "address",
            name: "controller",
            type: "address",
          },
          {
            internalType: "uint64",
            name: "tradingStart",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "decayRateX32",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "initialFee",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "finalFee",
            type: "uint64",
          },
          {
            internalType: "int32",
            name: "tickLower",
            type: "int32",
          },
          {
            internalType: "int32",
            name: "tickUpper",
            type: "int32",
          },
        ],
        internalType: "struct IZeroSeedLaunch.Launch",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "controller",
        type: "address",
      },
      {
        components: [
          {
            internalType: "bytes32",
            name: "name",
            type: "bytes32",
          },
          {
            internalType: "bytes32",
            name: "symbol",
            type: "bytes32",
          },
          {
            internalType: "uint128",
            name: "supply",
            type: "uint128",
          },
          {
            internalType: "address",
            name: "quoteToken",
            type: "address",
          },
          {
            internalType: "int32",
            name: "askTick",
            type: "int32",
          },
          {
            internalType: "int32",
            name: "upperTick",
            type: "int32",
          },
          {
            internalType: "uint64",
            name: "tradingStart",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "decayRateX32",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "initialFee",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "finalFee",
            type: "uint64",
          },
          {
            internalType: "bytes32",
            name: "salt",
            type: "bytes32",
          },
        ],
        internalType: "struct IZeroSeedLaunch.LaunchParameters",
        name: "parameters",
        type: "tuple",
      },
    ],
    name: "previewInstallation",
    outputs: [
      {
        components: [
          {
            internalType: "address",
            name: "token",
            type: "address",
          },
          {
            components: [
              {
                internalType: "address",
                name: "token0",
                type: "address",
              },
              {
                internalType: "address",
                name: "token1",
                type: "address",
              },
              {
                internalType: "PoolConfig",
                name: "config",
                type: "bytes32",
              },
            ],
            internalType: "struct PoolKey",
            name: "poolKey",
            type: "tuple",
          },
          {
            internalType: "PositionId",
            name: "positionId",
            type: "bytes32",
          },
          {
            internalType: "int32",
            name: "initialTick",
            type: "int32",
          },
          {
            internalType: "uint128",
            name: "liquidity",
            type: "uint128",
          },
          {
            internalType: "uint128",
            name: "installedSupply",
            type: "uint128",
          },
          {
            internalType: "uint32",
            name: "tickSpacing",
            type: "uint32",
          },
          {
            internalType: "int32",
            name: "askTick",
            type: "int32",
          },
          {
            internalType: "int32",
            name: "upperTick",
            type: "int32",
          },
        ],
        internalType: "struct IZeroSeedLaunch.Installation",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const ZERO_SEED_LAUNCH_PERIPHERY_ABI = [
  {
    inputs: [
      {
        internalType: "contract ICore",
        name: "core",
        type: "address",
      },
      {
        internalType: "contract IZeroSeedLaunch",
        name: "launch",
        type: "address",
      },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [],
    name: "BaseLockerAccountantOnly",
    type: "error",
  },
  {
    inputs: [],
    name: "ExpectedRevertWithinLock",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidOwner",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidRecipient",
    type: "error",
  },
  {
    inputs: [],
    name: "OwnerOnly",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "PoolId",
        name: "poolId",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "address",
        name: "owner",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "recipient",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint128",
        name: "amount0",
        type: "uint128",
      },
      {
        indexed: false,
        internalType: "uint128",
        name: "amount1",
        type: "uint128",
      },
    ],
    name: "LaunchFeesClaimed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "PoolId",
        name: "poolId",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "address",
        name: "previousOwner",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "newOwner",
        type: "address",
      },
    ],
    name: "LaunchOwnerChanged",
    type: "event",
  },
  {
    inputs: [],
    name: "LAUNCH",
    outputs: [
      {
        internalType: "contract IZeroSeedLaunch",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: "address",
            name: "token0",
            type: "address",
          },
          {
            internalType: "address",
            name: "token1",
            type: "address",
          },
          {
            internalType: "PoolConfig",
            name: "config",
            type: "bytes32",
          },
        ],
        internalType: "struct PoolKey",
        name: "poolKey",
        type: "tuple",
      },
      {
        internalType: "address",
        name: "recipient",
        type: "address",
      },
    ],
    name: "claimFees",
    outputs: [
      {
        internalType: "uint128",
        name: "amount0",
        type: "uint128",
      },
      {
        internalType: "uint128",
        name: "amount1",
        type: "uint128",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          {
            internalType: "bytes32",
            name: "name",
            type: "bytes32",
          },
          {
            internalType: "bytes32",
            name: "symbol",
            type: "bytes32",
          },
          {
            internalType: "uint128",
            name: "supply",
            type: "uint128",
          },
          {
            internalType: "address",
            name: "quoteToken",
            type: "address",
          },
          {
            internalType: "int32",
            name: "askTick",
            type: "int32",
          },
          {
            internalType: "int32",
            name: "upperTick",
            type: "int32",
          },
          {
            internalType: "uint64",
            name: "tradingStart",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "decayRateX32",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "initialFee",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "finalFee",
            type: "uint64",
          },
          {
            internalType: "bytes32",
            name: "salt",
            type: "bytes32",
          },
        ],
        internalType: "struct IZeroSeedLaunch.LaunchParameters",
        name: "parameters",
        type: "tuple",
      },
      {
        internalType: "string",
        name: "logoUrl",
        type: "string",
      },
    ],
    name: "create",
    outputs: [
      {
        components: [
          {
            internalType: "address",
            name: "token",
            type: "address",
          },
          {
            components: [
              {
                internalType: "address",
                name: "token0",
                type: "address",
              },
              {
                internalType: "address",
                name: "token1",
                type: "address",
              },
              {
                internalType: "PoolConfig",
                name: "config",
                type: "bytes32",
              },
            ],
            internalType: "struct PoolKey",
            name: "poolKey",
            type: "tuple",
          },
          {
            internalType: "PositionId",
            name: "positionId",
            type: "bytes32",
          },
          {
            internalType: "int32",
            name: "initialTick",
            type: "int32",
          },
          {
            internalType: "uint128",
            name: "liquidity",
            type: "uint128",
          },
          {
            internalType: "uint128",
            name: "installedSupply",
            type: "uint128",
          },
          {
            internalType: "uint32",
            name: "tickSpacing",
            type: "uint32",
          },
          {
            internalType: "int32",
            name: "askTick",
            type: "int32",
          },
          {
            internalType: "int32",
            name: "upperTick",
            type: "int32",
          },
        ],
        internalType: "struct IZeroSeedLaunch.Installation",
        name: "installation",
        type: "tuple",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "PoolId",
        name: "",
        type: "bytes32",
      },
    ],
    name: "launchOwner",
    outputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "uint256",
        name: "id",
        type: "uint256",
      },
    ],
    name: "locked_6416899205",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "owner",
        type: "address",
      },
      {
        components: [
          {
            internalType: "bytes32",
            name: "name",
            type: "bytes32",
          },
          {
            internalType: "bytes32",
            name: "symbol",
            type: "bytes32",
          },
          {
            internalType: "uint128",
            name: "supply",
            type: "uint128",
          },
          {
            internalType: "address",
            name: "quoteToken",
            type: "address",
          },
          {
            internalType: "int32",
            name: "askTick",
            type: "int32",
          },
          {
            internalType: "int32",
            name: "upperTick",
            type: "int32",
          },
          {
            internalType: "uint64",
            name: "tradingStart",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "decayRateX32",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "initialFee",
            type: "uint64",
          },
          {
            internalType: "uint64",
            name: "finalFee",
            type: "uint64",
          },
          {
            internalType: "bytes32",
            name: "salt",
            type: "bytes32",
          },
        ],
        internalType: "struct IZeroSeedLaunch.LaunchParameters",
        name: "parameters",
        type: "tuple",
      },
    ],
    name: "previewInstallation",
    outputs: [
      {
        components: [
          {
            internalType: "address",
            name: "token",
            type: "address",
          },
          {
            components: [
              {
                internalType: "address",
                name: "token0",
                type: "address",
              },
              {
                internalType: "address",
                name: "token1",
                type: "address",
              },
              {
                internalType: "PoolConfig",
                name: "config",
                type: "bytes32",
              },
            ],
            internalType: "struct PoolKey",
            name: "poolKey",
            type: "tuple",
          },
          {
            internalType: "PositionId",
            name: "positionId",
            type: "bytes32",
          },
          {
            internalType: "int32",
            name: "initialTick",
            type: "int32",
          },
          {
            internalType: "uint128",
            name: "liquidity",
            type: "uint128",
          },
          {
            internalType: "uint128",
            name: "installedSupply",
            type: "uint128",
          },
          {
            internalType: "uint32",
            name: "tickSpacing",
            type: "uint32",
          },
          {
            internalType: "int32",
            name: "askTick",
            type: "int32",
          },
          {
            internalType: "int32",
            name: "upperTick",
            type: "int32",
          },
        ],
        internalType: "struct IZeroSeedLaunch.Installation",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "PoolId",
        name: "poolId",
        type: "bytes32",
      },
      {
        internalType: "address",
        name: "newOwner",
        type: "address",
      },
    ],
    name: "transferLaunch",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export const LAUNCH_TOKEN_ABI = [
  {
    inputs: [
      {
        internalType: "bytes32",
        name: "name_",
        type: "bytes32",
      },
      {
        internalType: "bytes32",
        name: "symbol_",
        type: "bytes32",
      },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [],
    name: "AllowanceOverflow",
    type: "error",
  },
  {
    inputs: [],
    name: "AllowanceUnderflow",
    type: "error",
  },
  {
    inputs: [],
    name: "InsufficientAllowance",
    type: "error",
  },
  {
    inputs: [],
    name: "InsufficientBalance",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidPermit",
    type: "error",
  },
  {
    inputs: [],
    name: "MintClosed",
    type: "error",
  },
  {
    inputs: [],
    name: "Permit2AllowanceIsFixedAtInfinity",
    type: "error",
  },
  {
    inputs: [],
    name: "PermitExpired",
    type: "error",
  },
  {
    inputs: [],
    name: "TotalSupplyOverflow",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "owner",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "spender",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
    ],
    name: "Approval",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "from",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "to",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
    ],
    name: "Transfer",
    type: "event",
  },
  {
    inputs: [],
    name: "DOMAIN_SEPARATOR",
    outputs: [
      {
        internalType: "bytes32",
        name: "result",
        type: "bytes32",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "owner",
        type: "address",
      },
      {
        internalType: "address",
        name: "spender",
        type: "address",
      },
    ],
    name: "allowance",
    outputs: [
      {
        internalType: "uint256",
        name: "result",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "spender",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
    ],
    name: "approve",
    outputs: [
      {
        internalType: "bool",
        name: "",
        type: "bool",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "owner",
        type: "address",
      },
    ],
    name: "balanceOf",
    outputs: [
      {
        internalType: "uint256",
        name: "result",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [
      {
        internalType: "uint8",
        name: "",
        type: "uint8",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "recipient",
        type: "address",
      },
      {
        internalType: "uint128",
        name: "amount",
        type: "uint128",
      },
      {
        internalType: "uint128",
        name: "remainder",
        type: "uint128",
      },
    ],
    name: "mint",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [
      {
        internalType: "string",
        name: "",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "owner",
        type: "address",
      },
    ],
    name: "nonces",
    outputs: [
      {
        internalType: "uint256",
        name: "result",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "owner",
        type: "address",
      },
      {
        internalType: "address",
        name: "spender",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "value",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "deadline",
        type: "uint256",
      },
      {
        internalType: "uint8",
        name: "v",
        type: "uint8",
      },
      {
        internalType: "bytes32",
        name: "r",
        type: "bytes32",
      },
      {
        internalType: "bytes32",
        name: "s",
        type: "bytes32",
      },
    ],
    name: "permit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [
      {
        internalType: "string",
        name: "",
        type: "string",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [
      {
        internalType: "uint256",
        name: "result",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "to",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
    ],
    name: "transfer",
    outputs: [
      {
        internalType: "bool",
        name: "",
        type: "bool",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "from",
        type: "address",
      },
      {
        internalType: "address",
        name: "to",
        type: "address",
      },
      {
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
    ],
    name: "transferFrom",
    outputs: [
      {
        internalType: "bool",
        name: "",
        type: "bool",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
