export const CORE_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
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
    outputs: [],
    stateMutability: "nonpayable",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "bounds",
        type: "tuple",
        internalType: "struct Bounds",
        components: [
          {
            name: "lower",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upper",
            type: "int32",
            internalType: "int32",
          },
        ],
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
    name: "completePayment",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "payable",
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
      {
        name: "data",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getPoolFeesPerLiquidityInside",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "bounds",
        type: "tuple",
        internalType: "struct Bounds",
        components: [
          {
            name: "lower",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upper",
            type: "int32",
            internalType: "int32",
          },
        ],
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
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
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "load",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "amount",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "lock",
    inputs: [
      {
        name: "data",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "nextInitializedTick",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "fromTick",
        type: "int32",
        internalType: "int32",
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
    name: "prevInitializedTick",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "fromTick",
        type: "int32",
        internalType: "int32",
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
    name: "save",
    inputs: [
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
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "amount",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "sload",
    inputs: [
      {
        name: "slot",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "startPayment",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "swap",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "params",
        type: "tuple",
        internalType: "struct SwapParameters",
        components: [
          {
            name: "amount",
            type: "int128",
            internalType: "int128",
          },
          {
            name: "isToken1",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "sqrtRatioLimit",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "skipAhead",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "delta0",
        type: "int128",
        internalType: "int128",
      },
      {
        name: "delta1",
        type: "int128",
        internalType: "int128",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "tload",
    inputs: [
      {
        name: "slot",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "view",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "params",
        type: "tuple",
        internalType: "struct UpdatePositionParameters",
        components: [
          {
            name: "salt",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "bounds",
            type: "tuple",
            internalType: "struct Bounds",
            components: [
              {
                name: "lower",
                type: "int32",
                internalType: "int32",
              },
              {
                name: "upper",
                type: "int32",
                internalType: "int32",
              },
            ],
          },
          {
            name: "liquidityDelta",
            type: "int128",
            internalType: "int128",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "delta0",
        type: "int128",
        internalType: "int128",
      },
      {
        name: "delta1",
        type: "int128",
        internalType: "int128",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdrawProtocolFees",
    inputs: [
      {
        name: "recipient",
        type: "address",
        internalType: "address",
      },
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
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
    name: "LoadedBalance",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "token",
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
    name: "PoolInitialized",
    inputs: [
      {
        name: "key",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
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
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PositionFeesCollected",
    inputs: [
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "positionKey",
        type: "tuple",
        indexed: false,
        internalType: "struct PositionKey",
        components: [
          {
            name: "salt",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "bounds",
            type: "tuple",
            internalType: "struct Bounds",
            components: [
              {
                name: "lower",
                type: "int32",
                internalType: "int32",
              },
              {
                name: "upper",
                type: "int32",
                internalType: "int32",
              },
            ],
          },
        ],
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "params",
        type: "tuple",
        indexed: false,
        internalType: "struct UpdatePositionParameters",
        components: [
          {
            name: "salt",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "bounds",
            type: "tuple",
            internalType: "struct Bounds",
            components: [
              {
                name: "lower",
                type: "int32",
                internalType: "int32",
              },
              {
                name: "upper",
                type: "int32",
                internalType: "int32",
              },
            ],
          },
          {
            name: "liquidityDelta",
            type: "int128",
            internalType: "int128",
          },
        ],
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
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ProtocolFeesPaid",
    inputs: [
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "positionKey",
        type: "tuple",
        indexed: false,
        internalType: "struct PositionKey",
        components: [
          {
            name: "salt",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "owner",
            type: "address",
            internalType: "address",
          },
          {
            name: "bounds",
            type: "tuple",
            internalType: "struct Bounds",
            components: [
              {
                name: "lower",
                type: "int32",
                internalType: "int32",
              },
              {
                name: "upper",
                type: "int32",
                internalType: "int32",
              },
            ],
          },
        ],
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
    name: "ProtocolFeesWithdrawn",
    inputs: [
      {
        name: "recipient",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "token",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SavedBalance",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "token",
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
    name: "Swapped",
    inputs: [
      {
        name: "locker",
        type: "address",
        indexed: false,
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "params",
        type: "tuple",
        indexed: false,
        internalType: "struct SwapParameters",
        components: [
          {
            name: "amount",
            type: "int128",
            internalType: "int128",
          },
          {
            name: "isToken1",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "sqrtRatioLimit",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "skipAhead",
            type: "uint256",
            internalType: "uint256",
          },
        ],
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
        name: "sqrtRatioAfter",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "tickAfter",
        type: "int32",
        indexed: false,
        internalType: "int32",
      },
      {
        name: "liquidityAfter",
        type: "uint128",
        indexed: false,
        internalType: "uint128",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AllowanceOverflow",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "delta",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "AlreadyInitialized",
    inputs: [],
  },
  {
    type: "error",
    name: "Amount0DeltaOverflow",
    inputs: [],
  },
  {
    type: "error",
    name: "Amount1DeltaOverflow",
    inputs: [],
  },
  {
    type: "error",
    name: "AmountBeforeFeeOverflow",
    inputs: [],
  },
  {
    type: "error",
    name: "BalanceDeltaNotEqualAllowance",
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
    name: "BalanceTooGreat",
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
    name: "CallStartPaymentFirst",
    inputs: [],
  },
  {
    type: "error",
    name: "CannotAccumulateFeesWithZeroLiquidity",
    inputs: [],
  },
  {
    type: "error",
    name: "CannotTransferFromETH",
    inputs: [],
  },
  {
    type: "error",
    name: "DeltasNotZeroed",
    inputs: [
      {
        name: "count",
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
    inputs: [
      {
        name: "extension",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "FailedRegisterInvalidCallPoints",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidSqrtRatio",
    inputs: [
      {
        name: "sqrtRatio",
        type: "uint256",
        internalType: "uint256",
      },
    ],
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
    name: "InvalidTokens",
    inputs: [],
  },
  {
    type: "error",
    name: "LiquidityOverflow",
    inputs: [],
  },
  {
    type: "error",
    name: "LiquidityUnderflow",
    inputs: [],
  },
  {
    type: "error",
    name: "LockerOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "MinMaxBounds",
    inputs: [],
  },
  {
    type: "error",
    name: "MustCollectFeesBeforeWithdrawingAllLiquidity",
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
    name: "NoPaymentMade",
    inputs: [],
  },
  {
    type: "error",
    name: "OnlyCallableByExtension",
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
    name: "SqrtRatioLimitWrongDirection",
    inputs: [],
  },
  {
    type: "error",
    name: "TokenAmountTooLarge",
    inputs: [],
  },
  {
    type: "error",
    name: "Unauthorized",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroLiquidityNextSqrtRatioFromAmount0",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroLiquidityNextSqrtRatioFromAmount1",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroSqrtRatio",
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
        internalType: "contract Core",
      },
      {
        name: "_tokenURIGenerator",
        type: "address",
        internalType: "contract ITokenURIGenerator",
      },
    ],
    stateMutability: "nonpayable",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "bounds",
        type: "tuple",
        internalType: "struct Bounds",
        components: [
          {
            name: "lower",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upper",
            type: "int32",
            internalType: "int32",
          },
        ],
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "bounds",
        type: "tuple",
        internalType: "struct Bounds",
        components: [
          {
            name: "lower",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upper",
            type: "int32",
            internalType: "int32",
          },
        ],
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
    name: "getPoolPrice",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
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
    name: "locked",
    inputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "data",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes",
        internalType: "bytes",
      },
    ],
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "tick",
        type: "int32",
        internalType: "int32",
      },
    ],
    outputs: [],
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "bounds",
        type: "tuple",
        internalType: "struct Bounds",
        components: [
          {
            name: "lower",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upper",
            type: "int32",
            internalType: "int32",
          },
        ],
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
    stateMutability: "pure",
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
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "pure",
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
    stateMutability: "pure",
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
    name: "tokenURIGenerator",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract ITokenURIGenerator",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "bounds",
        type: "tuple",
        internalType: "struct Bounds",
        components: [
          {
            name: "lower",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upper",
            type: "int32",
            internalType: "int32",
          },
        ],
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
        name: "minAmount0",
        type: "uint128",
        internalType: "uint128",
      },
      {
        name: "minAmount1",
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
    name: "BalanceQueryForZeroAddress",
    inputs: [],
  },
  {
    type: "error",
    name: "CannotTransferFromETH",
    inputs: [],
  },
  {
    type: "error",
    name: "CoreOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "InsufficientAmountWithdrawn",
    inputs: [],
  },
  {
    type: "error",
    name: "InsufficientLiquidityReceived",
    inputs: [
      {
        name: "liquidity",
        type: "uint128",
        internalType: "uint128",
      },
    ],
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
    name: "MaxLiquidityForToken1Overflow",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOwnerNorApproved",
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
    name: "UnexpectedCallTypeByte",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroSqrtRatio",
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
        internalType: "contract Core",
      },
      {
        name: "_oracleToken",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "MAX_TICK_AT_MAX_TICK_SPACING",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "int32",
        internalType: "int32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "afterCollectFees",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct Bounds",
        components: [
          {
            name: "lower",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upper",
            type: "int32",
            internalType: "int32",
          },
        ],
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
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
        type: "uint256",
        internalType: "uint256",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct SwapParameters",
        components: [
          {
            name: "amount",
            type: "int128",
            internalType: "int128",
          },
          {
            name: "isToken1",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "sqrtRatioLimit",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "skipAhead",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
      {
        name: "",
        type: "int128",
        internalType: "int128",
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
    name: "afterUpdatePosition",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct UpdatePositionParameters",
        components: [
          {
            name: "salt",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "bounds",
            type: "tuple",
            internalType: "struct Bounds",
            components: [
              {
                name: "lower",
                type: "int32",
                internalType: "int32",
              },
              {
                name: "upper",
                type: "int32",
                internalType: "int32",
              },
            ],
          },
          {
            name: "liquidityDelta",
            type: "int128",
            internalType: "int128",
          },
        ],
      },
      {
        name: "",
        type: "int128",
        internalType: "int128",
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
    name: "beforeCollectFees",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct Bounds",
        components: [
          {
            name: "lower",
            type: "int32",
            internalType: "int32",
          },
          {
            name: "upper",
            type: "int32",
            internalType: "int32",
          },
        ],
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct SwapParameters",
        components: [
          {
            name: "amount",
            type: "int128",
            internalType: "int128",
          },
          {
            name: "isToken1",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "sqrtRatioLimit",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "skipAhead",
            type: "uint256",
            internalType: "uint256",
          },
        ],
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
            name: "fee",
            type: "uint128",
            internalType: "uint128",
          },
          {
            name: "tickSpacing",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "extension",
            type: "address",
            internalType: "address",
          },
        ],
      },
      {
        name: "params",
        type: "tuple",
        internalType: "struct UpdatePositionParameters",
        components: [
          {
            name: "salt",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "bounds",
            type: "tuple",
            internalType: "struct Bounds",
            components: [
              {
                name: "lower",
                type: "int32",
                internalType: "int32",
              },
              {
                name: "upper",
                type: "int32",
                internalType: "int32",
              },
            ],
          },
          {
            name: "liquidityDelta",
            type: "int128",
            internalType: "int128",
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "oracleToken",
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
    type: "function",
    name: "secondsSinceOffset",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint32",
        internalType: "uint32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "secondsSinceOffsetToTimestamp",
    inputs: [
      {
        name: "sso",
        type: "uint32",
        internalType: "uint32",
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
    name: "sload",
    inputs: [
      {
        name: "slot",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "snapshotCount",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "count",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "snapshots",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "index",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "secondsSinceOffset",
        type: "uint32",
        internalType: "uint32",
      },
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
    name: "timestampOffset",
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
    name: "tload",
    inputs: [
      {
        name: "slot",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "SnapshotEvent",
    inputs: [
      {
        name: "token",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "index",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "timestamp",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
      {
        name: "secondsPerLiquidityCumulative",
        type: "uint160",
        indexed: false,
        internalType: "uint160",
      },
      {
        name: "tickCumulative",
        type: "int64",
        indexed: false,
        internalType: "int64",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "BoundsMustBeMaximum",
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
    name: "FeeMustBeZero",
    inputs: [],
  },
  {
    type: "error",
    name: "PairsWithOracleTokenOnly",
    inputs: [],
  },
  {
    type: "error",
    name: "TickSpacingMustBeMaximum",
    inputs: [],
  },
] as const;
