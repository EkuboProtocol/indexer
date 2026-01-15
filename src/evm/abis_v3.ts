export const CORE_ABI = [
  {
    type: "receive",
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "accumulateAsFees",
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
        name: "_amount0",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "_amount1",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "collectFees",
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
        name: "positionId",
        type: "bytes32",
        internalType: "PositionId",
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
    name: "completePayments",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "forward",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getPoolFeesPerLiquidityInside",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        internalType: "PoolId",
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
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct FeesPerLiquidity",
        components: [
          {
            name: "value0",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "value1",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "initializePool",
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
        name: "tick",
        type: "int32",
        internalType: "int32",
      },
    ],
    outputs: [
      {
        name: "sqrtRatio",
        type: "uint96",
        internalType: "SqrtRatio",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "lock",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "nextInitializedTick",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        internalType: "PoolId",
      },
      {
        name: "fromTick",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "tickSpacing",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "skipAhead",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "tick",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "isInitialized",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "prevInitializedTick",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        internalType: "PoolId",
      },
      {
        name: "fromTick",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "tickSpacing",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "skipAhead",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "tick",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "isInitialized",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "registerExtension",
    inputs: [
      {
        name: "expectedCallPoints",
        type: "tuple",
        internalType: "struct CallPoints",
        components: [
          {
            name: "beforeInitializePool",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "afterInitializePool",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "beforeSwap",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "afterSwap",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "beforeUpdatePosition",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "afterUpdatePosition",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "beforeCollectFees",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "afterCollectFees",
            type: "bool",
            internalType: "bool",
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setExtraData",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        internalType: "PoolId",
      },
      {
        name: "positionId",
        type: "bytes32",
        internalType: "PositionId",
      },
      {
        name: "_extraData",
        type: "bytes16",
        internalType: "bytes16",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "sload",
    inputs: [],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "startPayments",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "swap_6269342730",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "tload",
    inputs: [],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "updateDebt",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "updatePosition",
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
        name: "positionId",
        type: "bytes32",
        internalType: "PositionId",
      },
      {
        name: "liquidityDelta",
        type: "int128",
        internalType: "int128",
      },
    ],
    outputs: [
      {
        name: "balanceUpdate",
        type: "bytes32",
        internalType: "PoolBalanceUpdate",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "updateSavedBalances",
    inputs: [
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
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "delta0",
        type: "int256",
        internalType: "int256",
      },
      {
        name: "delta1",
        type: "int256",
        internalType: "int256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "ExtensionRegistered",
    inputs: [
      {
        name: "extension",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "FeesAccumulated",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: false,
        internalType: "PoolId",
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
    name: "PoolInitialized",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        indexed: false,
        internalType: "PoolId",
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
        name: "tick",
        type: "int32",
        indexed: false,
        internalType: "int32",
      },
      {
        name: "sqrtRatio",
        type: "uint96",
        indexed: false,
        internalType: "SqrtRatio",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PositionFeesCollected",
    inputs: [
      {
        name: "locker",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "poolId",
        type: "bytes32",
        indexed: false,
        internalType: "PoolId",
      },
      {
        name: "positionId",
        type: "bytes32",
        indexed: false,
        internalType: "PositionId",
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
    name: "PositionUpdated",
    inputs: [
      {
        name: "locker",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "poolId",
        type: "bytes32",
        indexed: false,
        internalType: "PoolId",
      },
      {
        name: "positionId",
        type: "bytes32",
        indexed: false,
        internalType: "PositionId",
      },
      {
        name: "liquidityDelta",
        type: "int128",
        indexed: false,
        internalType: "int128",
      },
      {
        name: "balanceUpdate",
        type: "bytes32",
        indexed: false,
        internalType: "PoolBalanceUpdate",
      },
      {
        name: "stateAfter",
        type: "bytes32",
        indexed: false,
        internalType: "PoolState",
      },
    ],
    anonymous: false,
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
    name: "DebtsNotZeroed",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "ExtensionAlreadyRegistered",
    inputs: [],
  },
  {
    type: "error",
    name: "ExtensionNotRegistered",
    inputs: [],
  },
  {
    type: "error",
    name: "FailedRegisterInvalidCallPoints",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidCenterTick",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidSqrtRatioLimit",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidStableswapAmplification",
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
    name: "InvalidTickSpacing",
    inputs: [],
  },
  {
    type: "error",
    name: "LockerOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "MaxLiquidityPerTickExceeded",
    inputs: [
      {
        name: "tick",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "liquidityNet",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "maxLiquidityPerTick",
        type: "uint128",
        internalType: "uint128",
      },
    ],
  },
  {
    type: "error",
    name: "MinMaxBounds",
    inputs: [],
  },
  {
    type: "error",
    name: "NotLocked",
    inputs: [],
  },
  {
    type: "error",
    name: "PaymentOverflow",
    inputs: [],
  },
  {
    type: "error",
    name: "PoolAlreadyInitialized",
    inputs: [],
  },
  {
    type: "error",
    name: "PoolNotInitialized",
    inputs: [],
  },
  {
    type: "error",
    name: "SavedBalanceOverflow",
    inputs: [],
  },
  {
    type: "error",
    name: "SavedBalanceTokensNotSorted",
    inputs: [],
  },
  {
    type: "error",
    name: "SqrtRatioLimitOutOfRange",
    inputs: [],
  },
  {
    type: "error",
    name: "SqrtRatioLimitWrongDirection",
    inputs: [],
  },
  {
    type: "error",
    name: "StableswapMustBeFullRange",
    inputs: [],
  },
  {
    type: "error",
    name: "TokensMustBeSorted",
    inputs: [],
  },
  {
    type: "error",
    name: "UpdateDebtMessageLength",
    inputs: [],
  },
] as const;

export const POSITIONS_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "core",
        type: "address",
        internalType: "contract ICore",
      },
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
      {
        name: "_swapProtocolFeeX64",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "_withdrawalProtocolFeeDenominator",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "SWAP_PROTOCOL_FEE_X64",
    inputs: [],
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
    name: "WITHDRAWAL_PROTOCOL_FEE_DENOMINATOR",
    inputs: [],
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
    name: "approve",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "baseUrl",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "burn",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "cancelOwnershipHandover",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "collectFees",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
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
        name: "tickLower",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "tickUpper",
        type: "int32",
        internalType: "int32",
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
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "collectFees",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
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
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "completeOwnershipHandover",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "deposit",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
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
        name: "tickLower",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "tickUpper",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "maxAmount0",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "maxAmount1",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "minLiquidity",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [
      {
        name: "liquidity",
        type: "uint128",
        internalType: "uint128",
      },
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
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "getApproved",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPositionFeesAndLiquidity",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
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
    outputs: [
      {
        name: "liquidity",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "principal0",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "principal1",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "fees0",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "fees1",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getProtocolFees",
    inputs: [
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
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isApprovedForAll",
    inputs: [
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
      {
        name: "operator",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "bool",
        internalType: "bool",
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
    name: "maybeInitializePool",
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
        name: "tick",
        type: "int32",
        internalType: "int32",
      },
    ],
    outputs: [
      {
        name: "initialized",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "sqrtRatio",
        type: "uint96",
        internalType: "SqrtRatio",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [],
    outputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "mintAndDeposit",
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
        name: "tickLower",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "tickUpper",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "maxAmount0",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "maxAmount1",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "minLiquidity",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "liquidity",
        type: "uint128",
        internalType: "uint128",
      },
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
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "mintAndDepositWithSalt",
    inputs: [
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
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
        name: "tickLower",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "tickUpper",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "maxAmount0",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "maxAmount1",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "minLiquidity",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "liquidity",
        type: "uint128",
        internalType: "uint128",
      },
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
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "multicall",
    inputs: [
      {
        name: "data",
        type: "bytes[]",
        internalType: "bytes[]",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes[]",
        internalType: "bytes[]",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [
      {
        name: "result",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ownerOf",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ownershipHandoverExpiresAt",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refundNativeToken",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "renounceOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "requestOwnershipHandover",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "safeTransferFrom",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "safeTransferFrom",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "data",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "saltToId",
    inputs: [
      {
        name: "minter",
        type: "address",
        internalType: "address",
      },
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setApprovalForAll",
    inputs: [
      {
        name: "operator",
        type: "address",
        internalType: "address",
      },
      {
        name: "isApproved",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setMetadata",
    inputs: [
      {
        name: "newName",
        type: "string",
        internalType: "string",
      },
      {
        name: "newSymbol",
        type: "string",
        internalType: "string",
      },
      {
        name: "newBaseUrl",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "supportsInterface",
    inputs: [
      {
        name: "interfaceId",
        type: "bytes4",
        internalType: "bytes4",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transferFrom",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [
      {
        name: "newOwner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
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
        name: "tickLower",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "tickUpper",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "liquidity",
        type: "uint128",
        internalType: "uint128",
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
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
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
        name: "tickLower",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "tickUpper",
        type: "int32",
        internalType: "int32",
      },
      {
        name: "liquidity",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
      {
        name: "withFees",
        type: "bool",
        internalType: "bool",
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
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "withdrawProtocolFees",
    inputs: [
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
        name: "amount0",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "amount1",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ApprovalForAll",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "operator",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "isApproved",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipHandoverCanceled",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipHandoverRequested",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      {
        name: "oldOwner",
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
    type: "event",
    name: "Transfer",
    inputs: [
      {
        name: "from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AccountBalanceOverflow",
    inputs: [],
  },
  {
    type: "error",
    name: "AlreadyInitialized",
    inputs: [],
  },
  {
    type: "error",
    name: "BalanceQueryForZeroAddress",
    inputs: [],
  },
  {
    type: "error",
    name: "BaseLockerAccountantOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "CoreOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "DepositFailedDueToSlippage",
    inputs: [
      {
        name: "liquidity",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "minLiquidity",
        type: "uint128",
        internalType: "uint128",
      },
    ],
  },
  {
    type: "error",
    name: "DepositOverflow",
    inputs: [],
  },
  {
    type: "error",
    name: "ExpectedRevertWithinLock",
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
    name: "NewOwnerIsZeroAddress",
    inputs: [],
  },
  {
    type: "error",
    name: "NoHandoverRequest",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOwnerNorApproved",
    inputs: [],
  },
  {
    type: "error",
    name: "NotUnauthorizedForToken",
    inputs: [
      {
        name: "caller",
        type: "address",
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "TokenAlreadyExists",
    inputs: [],
  },
  {
    type: "error",
    name: "TokenDoesNotExist",
    inputs: [],
  },
  {
    type: "error",
    name: "TransferFromIncorrectOwner",
    inputs: [],
  },
  {
    type: "error",
    name: "TransferToNonERC721ReceiverImplementer",
    inputs: [],
  },
  {
    type: "error",
    name: "TransferToZeroAddress",
    inputs: [],
  },
  {
    type: "error",
    name: "Unauthorized",
    inputs: [],
  },
  {
    type: "error",
    name: "WithdrawOverflow",
    inputs: [],
  },
] as const;

export const ORACLE_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "core",
        type: "address",
        internalType: "contract ICore",
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
        name: "key",
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
    stateMutability: "nonpayable",
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
        name: "params",
        type: "bytes32",
        internalType: "SwapParameters",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
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
        name: "",
        type: "bytes32",
        internalType: "PositionId",
      },
      {
        name: "liquidityDelta",
        type: "int128",
        internalType: "int128",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "expandCapacity",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "minCapacity",
        type: "uint32",
        internalType: "uint32",
      },
    ],
    outputs: [
      {
        name: "capacity",
        type: "uint32",
        internalType: "uint32",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "extrapolateSnapshot",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "atTime",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "secondsPerLiquidityCumulative",
        type: "uint160",
        internalType: "uint160",
      },
      {
        name: "tickCumulative",
        type: "int64",
        internalType: "int64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "findPreviousSnapshot",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "time",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "count",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "logicalIndex",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "snapshot",
        type: "bytes32",
        internalType: "Snapshot",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getExtrapolatedSnapshotsForSortedTimestamps",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "timestamps",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    outputs: [
      {
        name: "observations",
        type: "bytes32[]",
        internalType: "Observation[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPoolKey",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
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
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "sload",
    inputs: [],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tload",
    inputs: [],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "error",
    name: "CallPointNotImplemented",
    inputs: [],
  },
  {
    type: "error",
    name: "CoreOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "EndTimeLessThanStartTime",
    inputs: [],
  },
  {
    type: "error",
    name: "FeeMustBeZero",
    inputs: [],
  },
  {
    type: "error",
    name: "FullRangePoolOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "FutureTime",
    inputs: [],
  },
  {
    type: "error",
    name: "NoPreviousSnapshotExists",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "time",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "PairsWithNativeTokenOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "TimestampsNotSorted",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroTimestampsProvided",
    inputs: [],
  },
] as const;

export const TWAMM_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "core",
        type: "address",
        internalType: "contract ICore",
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
        name: "key",
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
    stateMutability: "nonpayable",
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
        name: "",
        type: "bytes32",
        internalType: "SwapParameters",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
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
    stateMutability: "nonpayable",
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
    name: "getRewardRateInside",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        internalType: "PoolId",
      },
      {
        name: "config",
        type: "bytes32",
        internalType: "OrderConfig",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "lockAndExecuteVirtualOrders",
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
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "locked_6416899205",
    inputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "sload",
    inputs: [],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tload",
    inputs: [],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "OrderProceedsWithdrawn",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "salt",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "orderKey",
        type: "tuple",
        indexed: false,
        internalType: "struct OrderKey",
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
            internalType: "OrderConfig",
          },
        ],
      },
      {
        name: "amount",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OrderUpdated",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "salt",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "orderKey",
        type: "tuple",
        indexed: false,
        internalType: "struct OrderKey",
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
            internalType: "OrderConfig",
          },
        ],
      },
      {
        name: "saleRateDelta",
        type: "int112",
        indexed: false,
        internalType: "int112",
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
    name: "CallPointNotImplemented",
    inputs: [],
  },
  {
    type: "error",
    name: "CoreOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "FullRangePoolOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidTimestamps",
    inputs: [],
  },
  {
    type: "error",
    name: "MaxSaleRateDeltaPerTime",
    inputs: [],
  },
  {
    type: "error",
    name: "OrderAlreadyEnded",
    inputs: [],
  },
  {
    type: "error",
    name: "PoolNotInitialized",
    inputs: [],
  },
  {
    type: "error",
    name: "TimeNumOrdersOverflow",
    inputs: [],
  },
] as const;

export const ORDERS_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "core",
        type: "address",
        internalType: "contract ICore",
      },
      {
        name: "_twamm",
        type: "address",
        internalType: "contract ITWAMM",
      },
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "TWAMM_EXTENSION",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract ITWAMM",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "baseUrl",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "burn",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "cancelOwnershipHandover",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "collectProceeds",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "orderKey",
        type: "tuple",
        internalType: "struct OrderKey",
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
            internalType: "OrderConfig",
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
        name: "proceeds",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "collectProceeds",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "orderKey",
        type: "tuple",
        internalType: "struct OrderKey",
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
            internalType: "OrderConfig",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "proceeds",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "completeOwnershipHandover",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "decreaseSaleRate",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "orderKey",
        type: "tuple",
        internalType: "struct OrderKey",
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
            internalType: "OrderConfig",
          },
        ],
      },
      {
        name: "saleRateDecrease",
        type: "uint112",
        internalType: "uint112",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "refund",
        type: "uint112",
        internalType: "uint112",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "decreaseSaleRate",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "orderKey",
        type: "tuple",
        internalType: "struct OrderKey",
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
            internalType: "OrderConfig",
          },
        ],
      },
      {
        name: "saleRateDecrease",
        type: "uint112",
        internalType: "uint112",
      },
    ],
    outputs: [
      {
        name: "refund",
        type: "uint112",
        internalType: "uint112",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "executeVirtualOrdersAndGetCurrentOrderInfo",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "orderKey",
        type: "tuple",
        internalType: "struct OrderKey",
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
            internalType: "OrderConfig",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "saleRate",
        type: "uint112",
        internalType: "uint112",
      },
      {
        name: "amountSold",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "remainingSellAmount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "purchasedAmount",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getApproved",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "increaseSellAmount",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "orderKey",
        type: "tuple",
        internalType: "struct OrderKey",
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
            internalType: "OrderConfig",
          },
        ],
      },
      {
        name: "amount",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "maxSaleRate",
        type: "uint112",
        internalType: "uint112",
      },
    ],
    outputs: [
      {
        name: "saleRate",
        type: "uint112",
        internalType: "uint112",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "isApprovedForAll",
    inputs: [
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
      {
        name: "operator",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "bool",
        internalType: "bool",
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
    name: "mint",
    inputs: [],
    outputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "mintAndIncreaseSellAmount",
    inputs: [
      {
        name: "orderKey",
        type: "tuple",
        internalType: "struct OrderKey",
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
            internalType: "OrderConfig",
          },
        ],
      },
      {
        name: "amount",
        type: "uint112",
        internalType: "uint112",
      },
      {
        name: "maxSaleRate",
        type: "uint112",
        internalType: "uint112",
      },
    ],
    outputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "saleRate",
        type: "uint112",
        internalType: "uint112",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "multicall",
    inputs: [
      {
        name: "data",
        type: "bytes[]",
        internalType: "bytes[]",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes[]",
        internalType: "bytes[]",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [
      {
        name: "result",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ownerOf",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ownershipHandoverExpiresAt",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refundNativeToken",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "renounceOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "requestOwnershipHandover",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "safeTransferFrom",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "safeTransferFrom",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "data",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "saltToId",
    inputs: [
      {
        name: "minter",
        type: "address",
        internalType: "address",
      },
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setApprovalForAll",
    inputs: [
      {
        name: "operator",
        type: "address",
        internalType: "address",
      },
      {
        name: "isApproved",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setMetadata",
    inputs: [
      {
        name: "newName",
        type: "string",
        internalType: "string",
      },
      {
        name: "newSymbol",
        type: "string",
        internalType: "string",
      },
      {
        name: "newBaseUrl",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "supportsInterface",
    inputs: [
      {
        name: "interfaceId",
        type: "bytes4",
        internalType: "bytes4",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transferFrom",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [
      {
        name: "newOwner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ApprovalForAll",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "operator",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "isApproved",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipHandoverCanceled",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipHandoverRequested",
    inputs: [
      {
        name: "pendingOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      {
        name: "oldOwner",
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
    type: "event",
    name: "Transfer",
    inputs: [
      {
        name: "from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AccountBalanceOverflow",
    inputs: [],
  },
  {
    type: "error",
    name: "AlreadyInitialized",
    inputs: [],
  },
  {
    type: "error",
    name: "BalanceQueryForZeroAddress",
    inputs: [],
  },
  {
    type: "error",
    name: "BaseLockerAccountantOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "CoreOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "ExpectedRevertWithinLock",
    inputs: [],
  },
  {
    type: "error",
    name: "MaxSaleRateExceeded",
    inputs: [],
  },
  {
    type: "error",
    name: "NewOwnerIsZeroAddress",
    inputs: [],
  },
  {
    type: "error",
    name: "NoHandoverRequest",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOwnerNorApproved",
    inputs: [],
  },
  {
    type: "error",
    name: "NotUnauthorizedForToken",
    inputs: [
      {
        name: "caller",
        type: "address",
        internalType: "address",
      },
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "OrderAlreadyEnded",
    inputs: [],
  },
  {
    type: "error",
    name: "TokenAlreadyExists",
    inputs: [],
  },
  {
    type: "error",
    name: "TokenDoesNotExist",
    inputs: [],
  },
  {
    type: "error",
    name: "TransferFromIncorrectOwner",
    inputs: [],
  },
  {
    type: "error",
    name: "TransferToNonERC721ReceiverImplementer",
    inputs: [],
  },
  {
    type: "error",
    name: "TransferToZeroAddress",
    inputs: [],
  },
  {
    type: "error",
    name: "Unauthorized",
    inputs: [],
  },
] as const;

export const INCENTIVES_ABI = [
  {
    type: "function",
    name: "claim",
    inputs: [
      {
        name: "key",
        type: "tuple",
        internalType: "struct DropKey",
        components: [
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "root",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
      {
        name: "c",
        type: "tuple",
        internalType: "struct ClaimKey",
        components: [
          {
            name: "index",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "account",
            type: "address",
            internalType: "address",
          },
          {
            name: "amount",
            type: "uint128",
            internalType: "uint128",
          },
        ],
      },
      {
        name: "proof",
        type: "bytes32[]",
        internalType: "bytes32[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "fund",
    inputs: [
      {
        name: "key",
        type: "tuple",
        internalType: "struct DropKey",
        components: [
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "root",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
      {
        name: "minimum",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [
      {
        name: "fundedAmount",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "multicall",
    inputs: [
      {
        name: "data",
        type: "bytes[]",
        internalType: "bytes[]",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes[]",
        internalType: "bytes[]",
      },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "refund",
    inputs: [
      {
        name: "key",
        type: "tuple",
        internalType: "struct DropKey",
        components: [
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "root",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "refundAmount",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "sload",
    inputs: [],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tload",
    inputs: [],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Funded",
    inputs: [
      {
        name: "key",
        type: "tuple",
        indexed: false,
        internalType: "struct DropKey",
        components: [
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "root",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
      {
        name: "amountNext",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      {
        name: "key",
        type: "tuple",
        indexed: false,
        internalType: "struct DropKey",
        components: [
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "root",
            type: "bytes32",
            internalType: "bytes32",
          },
        ],
      },
      {
        name: "refundAmount",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AlreadyClaimed",
    inputs: [],
  },
  {
    type: "error",
    name: "DropOwnerOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "InsufficientFunds",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidProof",
    inputs: [],
  },
] as const;

export const TOKEN_WRAPPER_FACTORY_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "_core",
        type: "address",
        internalType: "contract ICore",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "CORE",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract ICore",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "deployWrapper",
    inputs: [
      {
        name: "underlyingToken",
        type: "address",
        internalType: "contract IERC20",
      },
      {
        name: "unlockTime",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "tokenWrapper",
        type: "address",
        internalType: "contract TokenWrapper",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "TokenWrapperDeployed",
    inputs: [
      {
        name: "underlyingToken",
        type: "address",
        indexed: false,
        internalType: "contract IERC20",
      },
      {
        name: "unlockTime",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "tokenWrapper",
        type: "address",
        indexed: false,
        internalType: "contract TokenWrapper",
      },
    ],
    anonymous: false,
  },
] as const;

export const BOOSTED_FEES_ABI = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "core",
        "type": "address",
        "internalType": "contract ICore"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "afterCollectFees",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "Locker"
      },
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "token0",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token1",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "config",
            "type": "bytes32",
            "internalType": "PoolConfig"
          }
        ]
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "PositionId"
      },
      {
        "name": "",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "afterInitializePool",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "poolKey",
        "type": "tuple",
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "token0",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token1",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "config",
            "type": "bytes32",
            "internalType": "PoolConfig"
          }
        ]
      },
      {
        "name": "",
        "type": "int32",
        "internalType": "int32"
      },
      {
        "name": "",
        "type": "uint96",
        "internalType": "SqrtRatio"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "afterSwap",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "Locker"
      },
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "token0",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token1",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "config",
            "type": "bytes32",
            "internalType": "PoolConfig"
          }
        ]
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "SwapParameters"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "PoolBalanceUpdate"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "PoolState"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "afterUpdatePosition",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "Locker"
      },
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "token0",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token1",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "config",
            "type": "bytes32",
            "internalType": "PoolConfig"
          }
        ]
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "PositionId"
      },
      {
        "name": "",
        "type": "int128",
        "internalType": "int128"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "PoolBalanceUpdate"
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "PoolState"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beforeCollectFees",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "Locker"
      },
      {
        "name": "poolKey",
        "type": "tuple",
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "token0",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token1",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "config",
            "type": "bytes32",
            "internalType": "PoolConfig"
          }
        ]
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "PositionId"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beforeInitializePool",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "token0",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token1",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "config",
            "type": "bytes32",
            "internalType": "PoolConfig"
          }
        ]
      },
      {
        "name": "",
        "type": "int32",
        "internalType": "int32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beforeSwap",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "Locker"
      },
      {
        "name": "poolKey",
        "type": "tuple",
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "token0",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token1",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "config",
            "type": "bytes32",
            "internalType": "PoolConfig"
          }
        ]
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "SwapParameters"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "beforeUpdatePosition",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "Locker"
      },
      {
        "name": "poolKey",
        "type": "tuple",
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "token0",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token1",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "config",
            "type": "bytes32",
            "internalType": "PoolConfig"
          }
        ]
      },
      {
        "name": "",
        "type": "bytes32",
        "internalType": "PositionId"
      },
      {
        "name": "",
        "type": "int128",
        "internalType": "int128"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "forwarded_2374103877",
    "inputs": [
      {
        "name": "original",
        "type": "bytes32",
        "internalType": "Locker"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "locked_6416899205",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "maybeAccumulateFees",
    "inputs": [
      {
        "name": "poolKey",
        "type": "tuple",
        "internalType": "struct PoolKey",
        "components": [
          {
            "name": "token0",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "token1",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "config",
            "type": "bytes32",
            "internalType": "PoolConfig"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sload",
    "inputs": [],
    "outputs": [],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "tload",
    "inputs": [],
    "outputs": [],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "PoolBoosted",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "PoolId"
      },
      {
        "name": "startTime",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "endTime",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "rate0",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "rate1",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BaseForwardeeAccountantOnly",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CallPointNotImplemented",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CoreOnly",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidTimestamps",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MaxRateDeltaPerTime",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PoolNotInitialized",
    "inputs": []
  }
]as const;
