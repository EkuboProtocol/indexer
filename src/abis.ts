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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
            internalType: "Config",
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
            internalType: "Config",
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
            internalType: "Config",
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
    name: "load",
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
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
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
        internalType: "bytes32",
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
    name: "pay",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "payment",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "prevInitializedTick",
    inputs: [
      {
        name: "poolId",
        type: "bytes32",
        internalType: "bytes32",
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
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
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
    stateMutability: "payable",
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
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "swap_611415377",
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
            internalType: "Config",
          },
        ],
      },
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
        type: "uint96",
        internalType: "SqrtRatio",
      },
      {
        name: "skipAhead",
        type: "uint256",
        internalType: "uint256",
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
    stateMutability: "payable",
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
        name: "",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
    stateMutability: "payable",
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
        name: "poolId",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
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
        name: "poolId",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
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
            internalType: "Config",
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
        name: "poolId",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
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
        name: "locker",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "poolId",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
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
    name: "FullRangeOnlyPool",
    inputs: [],
  },
  {
    type: "error",
    name: "InsufficientSavedBalance",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidSqrtRatioLimit",
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
    name: "NotLocked",
    inputs: [],
  },
  {
    type: "error",
    name: "PayReentrance",
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
    name: "TokensMustBeSorted",
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
        name: "tokenURIGenerator",
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
    name: "checkDeadline",
    inputs: [
      {
        name: "deadline",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "checkMaximumInputNotExceeded",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "maximumInput",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "checkMinimumOutputReceived",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "minimumOutput",
        type: "uint256",
        internalType: "uint256",
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
            internalType: "Config",
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
            internalType: "Config",
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
            internalType: "Config",
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
            internalType: "Config",
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
            internalType: "Config",
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
            internalType: "Config",
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
            internalType: "Config",
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
    name: "payCallback",
    inputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
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
    name: "permit",
    inputs: [
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
      {
        name: "deadline",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "v",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "r",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "s",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "recordBalanceForSlippageCheck",
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
    name: "refundNativeToken",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
            internalType: "Config",
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
    name: "MaximumInputExceeded",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "maximumInput",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "MinimumOutputNotReceived",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "minimumOutput",
        type: "uint256",
        internalType: "uint256",
      },
    ],
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
    name: "TransactionExpired",
    inputs: [
      {
        name: "deadline",
        type: "uint256",
        internalType: "uint256",
      },
    ],
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
    inputs: [
      {
        name: "b",
        type: "bytes1",
        internalType: "bytes1",
      },
    ],
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
            internalType: "Config",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
            internalType: "Config",
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
        type: "bool",
        internalType: "bool",
      },
      {
        name: "",
        type: "uint96",
        internalType: "SqrtRatio",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
          },
        ],
      },
      {
        name: "amount",
        type: "int128",
        internalType: "int128",
      },
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "",
        type: "uint96",
        internalType: "SqrtRatio",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
    name: "counts",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "index",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "count",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "capacity",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
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
        type: "uint64",
        internalType: "uint64",
      },
    ],
    outputs: [
      {
        name: "capacity",
        type: "uint64",
        internalType: "uint64",
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
        type: "uint64",
        internalType: "uint64",
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
        type: "uint64",
        internalType: "uint64",
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
        type: "tuple",
        internalType: "struct Oracle.Snapshot",
        components: [
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
        type: "uint64[]",
        internalType: "uint64[]",
      },
    ],
    outputs: [
      {
        name: "observations",
        type: "tuple[]",
        internalType: "struct Oracle.Observation[]",
        components: [
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
            internalType: "Config",
          },
        ],
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
        name: "",
        type: "bytes32",
        internalType: "bytes32",
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
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
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
        type: "uint64",
        internalType: "uint64",
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
    name: "TickSpacingMustBeMaximum",
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
            internalType: "Config",
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
            internalType: "Config",
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
            internalType: "Config",
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
        type: "bool",
        internalType: "bool",
      },
      {
        name: "",
        type: "uint96",
        internalType: "SqrtRatio",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
            internalType: "Config",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
        type: "bool",
        internalType: "bool",
      },
      {
        name: "",
        type: "uint96",
        internalType: "SqrtRatio",
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
            name: "config",
            type: "bytes32",
            internalType: "Config",
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
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "forwarded",
    inputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "originalLocker",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
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
        name: "",
        type: "bytes32",
        internalType: "bytes32",
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
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
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
            name: "sellToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "buyToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "fee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "startTime",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "endTime",
            type: "uint256",
            internalType: "uint256",
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
            name: "sellToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "buyToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "fee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "startTime",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "endTime",
            type: "uint256",
            internalType: "uint256",
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
    name: "InvalidTimestamps",
    inputs: [],
  },
  {
    type: "error",
    name: "MaxSaleRateDeltaPerTick",
    inputs: [],
  },
  {
    type: "error",
    name: "MustCollectProceedsBeforeCanceling",
    inputs: [],
  },
  {
    type: "error",
    name: "OrderAlreadyEnded",
    inputs: [],
  },
  {
    type: "error",
    name: "TickSpacingMustBeMaximum",
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
        internalType: "contract TWAMM",
      },
      {
        name: "tokenURIGenerator",
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
    name: "checkDeadline",
    inputs: [
      {
        name: "deadline",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "checkMaximumInputNotExceeded",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "maximumInput",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "checkMinimumOutputReceived",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "minimumOutput",
        type: "uint256",
        internalType: "uint256",
      },
    ],
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
            name: "sellToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "buyToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "fee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "startTime",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "endTime",
            type: "uint256",
            internalType: "uint256",
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
            name: "sellToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "buyToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "fee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "startTime",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "endTime",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
      {
        name: "saleRateDecrease",
        type: "uint112",
        internalType: "uint112",
      },
      {
        name: "minRefund",
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
            name: "sellToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "buyToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "fee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "startTime",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "endTime",
            type: "uint256",
            internalType: "uint256",
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
    name: "locked",
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
            name: "sellToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "buyToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "fee",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "startTime",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "endTime",
            type: "uint256",
            internalType: "uint256",
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
    name: "payCallback",
    inputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
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
    name: "permit",
    inputs: [
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
      {
        name: "deadline",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "v",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "r",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "s",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "recordBalanceForSlippageCheck",
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
    name: "refundNativeToken",
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
    name: "twamm",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract TWAMM",
      },
    ],
    stateMutability: "view",
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
    name: "InvalidDuration",
    inputs: [],
  },
  {
    type: "error",
    name: "MaxSaleRateExceeded",
    inputs: [],
  },
  {
    type: "error",
    name: "MaximumInputExceeded",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "maximumInput",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "MinimumOutputNotReceived",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "minimumOutput",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "MinimumRefund",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOwnerNorApproved",
    inputs: [],
  },
  {
    type: "error",
    name: "OrderAlreadyEnded",
    inputs: [],
  },
  {
    type: "error",
    name: "SaleRateOverflow",
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
    name: "TransactionExpired",
    inputs: [
      {
        name: "deadline",
        type: "uint256",
        internalType: "uint256",
      },
    ],
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
    inputs: [
      {
        name: "b",
        type: "bytes1",
        internalType: "bytes1",
      },
    ],
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
        internalType: "struct Claim",
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
    name: "claimed",
    inputs: [
      {
        name: "id",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "Bitmap",
      },
    ],
    stateMutability: "view",
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
    name: "getRemaining",
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
        name: "",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isAvailable",
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
        name: "index",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "amount",
        type: "uint128",
        internalType: "uint128",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isClaimed",
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
        name: "index",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
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
