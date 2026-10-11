// ZeroSeedLaunch ABI, frozen with EkuboProtocol/evm-contracts 39ca1918e4d16b1c9fd4db5ed70761ef7b12c6ae
// (tree b95e7484). Verbatim from the frozen ZeroSeedLaunch.abi.json, whose
// `jq -cS . | sha256sum` is ZERO_SEED_LAUNCH_ABI_SHA256; a test recomputes it.
// Any change here is an interface change and needs a new CTO freeze.
export const ZERO_SEED_LAUNCH_ABI_SHA256 =
  "28d05c07218cbe7101dee3410f356820dbfcaa31b08e015aee5940a96950f23d";

export const ZERO_SEED_LAUNCH_ABI = [
  {
    "inputs": [
      {
        "internalType": "contract ICore",
        "name": "core",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [
      {
        "internalType": "Locker",
        "name": "",
        "type": "bytes32"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "token0",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token1",
            "type": "address"
          },
          {
            "internalType": "PoolConfig",
            "name": "config",
            "type": "bytes32"
          }
        ],
        "internalType": "struct PoolKey",
        "name": "",
        "type": "tuple"
      },
      {
        "internalType": "PositionId",
        "name": "",
        "type": "bytes32"
      },
      {
        "internalType": "uint128",
        "name": "",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "",
        "type": "uint128"
      }
    ],
    "name": "afterCollectFees",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "token0",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token1",
            "type": "address"
          },
          {
            "internalType": "PoolConfig",
            "name": "config",
            "type": "bytes32"
          }
        ],
        "internalType": "struct PoolKey",
        "name": "",
        "type": "tuple"
      },
      {
        "internalType": "int32",
        "name": "",
        "type": "int32"
      },
      {
        "internalType": "SqrtRatio",
        "name": "",
        "type": "uint96"
      }
    ],
    "name": "afterInitializePool",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Locker",
        "name": "",
        "type": "bytes32"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "token0",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token1",
            "type": "address"
          },
          {
            "internalType": "PoolConfig",
            "name": "config",
            "type": "bytes32"
          }
        ],
        "internalType": "struct PoolKey",
        "name": "",
        "type": "tuple"
      },
      {
        "internalType": "SwapParameters",
        "name": "",
        "type": "bytes32"
      },
      {
        "internalType": "PoolBalanceUpdate",
        "name": "",
        "type": "bytes32"
      },
      {
        "internalType": "PoolState",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "afterSwap",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Locker",
        "name": "",
        "type": "bytes32"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "token0",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token1",
            "type": "address"
          },
          {
            "internalType": "PoolConfig",
            "name": "config",
            "type": "bytes32"
          }
        ],
        "internalType": "struct PoolKey",
        "name": "",
        "type": "tuple"
      },
      {
        "internalType": "PositionId",
        "name": "",
        "type": "bytes32"
      },
      {
        "internalType": "int128",
        "name": "",
        "type": "int128"
      },
      {
        "internalType": "PoolBalanceUpdate",
        "name": "",
        "type": "bytes32"
      },
      {
        "internalType": "PoolState",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "afterUpdatePosition",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Locker",
        "name": "",
        "type": "bytes32"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "token0",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token1",
            "type": "address"
          },
          {
            "internalType": "PoolConfig",
            "name": "config",
            "type": "bytes32"
          }
        ],
        "internalType": "struct PoolKey",
        "name": "",
        "type": "tuple"
      },
      {
        "internalType": "PositionId",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "beforeCollectFees",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "token0",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token1",
            "type": "address"
          },
          {
            "internalType": "PoolConfig",
            "name": "config",
            "type": "bytes32"
          }
        ],
        "internalType": "struct PoolKey",
        "name": "",
        "type": "tuple"
      },
      {
        "internalType": "int32",
        "name": "",
        "type": "int32"
      }
    ],
    "name": "beforeInitializePool",
    "outputs": [],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Locker",
        "name": "",
        "type": "bytes32"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "token0",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token1",
            "type": "address"
          },
          {
            "internalType": "PoolConfig",
            "name": "config",
            "type": "bytes32"
          }
        ],
        "internalType": "struct PoolKey",
        "name": "",
        "type": "tuple"
      },
      {
        "internalType": "SwapParameters",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "beforeSwap",
    "outputs": [],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Locker",
        "name": "",
        "type": "bytes32"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "token0",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token1",
            "type": "address"
          },
          {
            "internalType": "PoolConfig",
            "name": "config",
            "type": "bytes32"
          }
        ],
        "internalType": "struct PoolKey",
        "name": "",
        "type": "tuple"
      },
      {
        "internalType": "PositionId",
        "name": "",
        "type": "bytes32"
      },
      {
        "internalType": "int128",
        "name": "",
        "type": "int128"
      }
    ],
    "name": "beforeUpdatePosition",
    "outputs": [],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "token0",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token1",
            "type": "address"
          },
          {
            "internalType": "PoolConfig",
            "name": "config",
            "type": "bytes32"
          }
        ],
        "internalType": "struct PoolKey",
        "name": "poolKey",
        "type": "tuple"
      },
      {
        "internalType": "address",
        "name": "recipient",
        "type": "address"
      }
    ],
    "name": "claimFees",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "",
        "type": "uint128"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "quoteToken",
            "type": "address"
          },
          {
            "internalType": "string",
            "name": "name",
            "type": "string"
          },
          {
            "internalType": "string",
            "name": "symbol",
            "type": "string"
          },
          {
            "internalType": "uint8",
            "name": "decimals",
            "type": "uint8"
          },
          {
            "internalType": "uint128",
            "name": "supply",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "liquidity",
            "type": "uint128"
          },
          {
            "internalType": "int32",
            "name": "askTick",
            "type": "int32"
          },
          {
            "internalType": "int32",
            "name": "upperTick",
            "type": "int32"
          },
          {
            "internalType": "uint32",
            "name": "tickSpacing",
            "type": "uint32"
          },
          {
            "internalType": "uint64",
            "name": "tradingStart",
            "type": "uint64"
          },
          {
            "internalType": "uint32",
            "name": "feeDuration",
            "type": "uint32"
          },
          {
            "internalType": "uint64",
            "name": "initialFee",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "finalFee",
            "type": "uint64"
          },
          {
            "internalType": "bytes32",
            "name": "salt",
            "type": "bytes32"
          }
        ],
        "internalType": "struct IZeroSeedLaunch.LaunchParameters",
        "name": "parameters",
        "type": "tuple"
      }
    ],
    "name": "create",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "token",
            "type": "address"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "token0",
                "type": "address"
              },
              {
                "internalType": "address",
                "name": "token1",
                "type": "address"
              },
              {
                "internalType": "PoolConfig",
                "name": "config",
                "type": "bytes32"
              }
            ],
            "internalType": "struct PoolKey",
            "name": "poolKey",
            "type": "tuple"
          },
          {
            "internalType": "PositionId",
            "name": "positionId",
            "type": "bytes32"
          },
          {
            "internalType": "int32",
            "name": "initialTick",
            "type": "int32"
          },
          {
            "internalType": "uint128",
            "name": "liquidity",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "installedSupply",
            "type": "uint128"
          }
        ],
        "internalType": "struct IZeroSeedLaunch.Installation",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "token0",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token1",
            "type": "address"
          },
          {
            "internalType": "PoolConfig",
            "name": "config",
            "type": "bytes32"
          }
        ],
        "internalType": "struct PoolKey",
        "name": "poolKey",
        "type": "tuple"
      }
    ],
    "name": "creatorFees",
    "outputs": [
      {
        "internalType": "uint128",
        "name": "",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "",
        "type": "uint128"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "PoolId",
        "name": "poolId",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "timestamp",
        "type": "uint256"
      }
    ],
    "name": "feeAt",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "Locker",
        "name": "original",
        "type": "bytes32"
      }
    ],
    "name": "forwarded_2374103877",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "PoolId",
        "name": "poolId",
        "type": "bytes32"
      }
    ],
    "name": "getLaunch",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "creator",
            "type": "address"
          },
          {
            "internalType": "uint64",
            "name": "tradingStart",
            "type": "uint64"
          },
          {
            "internalType": "uint32",
            "name": "feeDuration",
            "type": "uint32"
          },
          {
            "internalType": "uint64",
            "name": "initialFee",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "finalFee",
            "type": "uint64"
          },
          {
            "internalType": "int32",
            "name": "tickLower",
            "type": "int32"
          },
          {
            "internalType": "int32",
            "name": "tickUpper",
            "type": "int32"
          }
        ],
        "internalType": "struct IZeroSeedLaunch.Launch",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "id",
        "type": "uint256"
      }
    ],
    "name": "locked_6416899205",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "creator",
        "type": "address"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "quoteToken",
            "type": "address"
          },
          {
            "internalType": "string",
            "name": "name",
            "type": "string"
          },
          {
            "internalType": "string",
            "name": "symbol",
            "type": "string"
          },
          {
            "internalType": "uint8",
            "name": "decimals",
            "type": "uint8"
          },
          {
            "internalType": "uint128",
            "name": "supply",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "liquidity",
            "type": "uint128"
          },
          {
            "internalType": "int32",
            "name": "askTick",
            "type": "int32"
          },
          {
            "internalType": "int32",
            "name": "upperTick",
            "type": "int32"
          },
          {
            "internalType": "uint32",
            "name": "tickSpacing",
            "type": "uint32"
          },
          {
            "internalType": "uint64",
            "name": "tradingStart",
            "type": "uint64"
          },
          {
            "internalType": "uint32",
            "name": "feeDuration",
            "type": "uint32"
          },
          {
            "internalType": "uint64",
            "name": "initialFee",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "finalFee",
            "type": "uint64"
          },
          {
            "internalType": "bytes32",
            "name": "salt",
            "type": "bytes32"
          }
        ],
        "internalType": "struct IZeroSeedLaunch.LaunchParameters",
        "name": "parameters",
        "type": "tuple"
      }
    ],
    "name": "previewInstallation",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "token",
            "type": "address"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "token0",
                "type": "address"
              },
              {
                "internalType": "address",
                "name": "token1",
                "type": "address"
              },
              {
                "internalType": "PoolConfig",
                "name": "config",
                "type": "bytes32"
              }
            ],
            "internalType": "struct PoolKey",
            "name": "poolKey",
            "type": "tuple"
          },
          {
            "internalType": "PositionId",
            "name": "positionId",
            "type": "bytes32"
          },
          {
            "internalType": "int32",
            "name": "initialTick",
            "type": "int32"
          },
          {
            "internalType": "uint128",
            "name": "liquidity",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "installedSupply",
            "type": "uint128"
          }
        ],
        "internalType": "struct IZeroSeedLaunch.Installation",
        "name": "installation",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "PoolId",
        "name": "poolId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "creator",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "recipient",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "amount0",
        "type": "uint128"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "amount1",
        "type": "uint128"
      }
    ],
    "name": "CreatorFeesClaimed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "PoolId",
        "name": "poolId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "creator",
        "type": "address"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "token0",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "token1",
            "type": "address"
          },
          {
            "internalType": "PoolConfig",
            "name": "config",
            "type": "bytes32"
          }
        ],
        "indexed": false,
        "internalType": "struct PoolKey",
        "name": "poolKey",
        "type": "tuple"
      },
      {
        "indexed": false,
        "internalType": "PositionId",
        "name": "positionId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "liquidity",
        "type": "uint128"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "quoteToken",
            "type": "address"
          },
          {
            "internalType": "string",
            "name": "name",
            "type": "string"
          },
          {
            "internalType": "string",
            "name": "symbol",
            "type": "string"
          },
          {
            "internalType": "uint8",
            "name": "decimals",
            "type": "uint8"
          },
          {
            "internalType": "uint128",
            "name": "supply",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "liquidity",
            "type": "uint128"
          },
          {
            "internalType": "int32",
            "name": "askTick",
            "type": "int32"
          },
          {
            "internalType": "int32",
            "name": "upperTick",
            "type": "int32"
          },
          {
            "internalType": "uint32",
            "name": "tickSpacing",
            "type": "uint32"
          },
          {
            "internalType": "uint64",
            "name": "tradingStart",
            "type": "uint64"
          },
          {
            "internalType": "uint32",
            "name": "feeDuration",
            "type": "uint32"
          },
          {
            "internalType": "uint64",
            "name": "initialFee",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "finalFee",
            "type": "uint64"
          },
          {
            "internalType": "bytes32",
            "name": "salt",
            "type": "bytes32"
          }
        ],
        "indexed": false,
        "internalType": "struct IZeroSeedLaunch.LaunchParameters",
        "name": "parameters",
        "type": "tuple"
      }
    ],
    "name": "LaunchCreated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "PoolId",
        "name": "poolId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "locker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "int128",
        "name": "delta0",
        "type": "int128"
      },
      {
        "indexed": false,
        "internalType": "int128",
        "name": "delta1",
        "type": "int128"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "feeRate",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "feeAmount",
        "type": "uint128"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "feeIsToken1",
        "type": "bool"
      }
    ],
    "name": "LaunchSwapped",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "BaseForwardeeAccountantOnly",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BaseLockerAccountantOnly",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BoundsOrder",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BoundsTickSpacing",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CallPointNotImplemented",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CoreOnly",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CreatorOnly",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ExpectedRevertWithinLock",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FeeTooHigh",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InitializeThroughCreateOnly",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidFeeSchedule",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidParameters",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidRecipient",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "int32",
        "name": "tick",
        "type": "int32"
      }
    ],
    "name": "InvalidTick",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidTradingStart",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint128",
        "name": "liquidity",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "cap",
        "type": "uint128"
      }
    ],
    "name": "LiquidityAboveTickCap",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "MinMaxBounds",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PositionsThroughCreateOnly",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "StableswapMustBeFullRange",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint128",
        "name": "requested",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "installable",
        "type": "uint128"
      }
    ],
    "name": "SupplyNotExactlyInstallable",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SwapsThroughForwardOnly",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TradingNotStarted",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UnknownLaunch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UnsupportedQuoteToken",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroLiquidity",
    "type": "error"
  }
] as const;
