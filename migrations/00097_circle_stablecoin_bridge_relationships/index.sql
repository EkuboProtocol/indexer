-- Seed Circle stablecoin bridge relationships across EVM chains.
-- Sources (retrieved 2026-03-03):
-- - https://developers.circle.com/stablecoins/usdc-contract-addresses
-- - https://developers.circle.com/stablecoins/eurc-contract-addresses
--
-- We only include EVM chains and treat mainnet/testnet as distinct token universes.

WITH circle_tokens(asset, network, chain_id, token_address) AS (
  VALUES
    -- USDC mainnet (EVM only)
    ('USDC', 'mainnet', 42161, 0xaf88d065e77c8cc2239327c5edb3a432268e5831::NUMERIC), -- Arbitrum
    ('USDC', 'mainnet', 43114, 0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e::NUMERIC), -- Avalanche C-Chain
    ('USDC', 'mainnet', 8453, 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913::NUMERIC), -- Base
    ('USDC', 'mainnet', 81224, 0xd996633a415985dbd7d6d12f4a4343e31f5037cf::NUMERIC), -- Codex
    ('USDC', 'mainnet', 42220, 0xceba9300f2b948710d2653dd7b07f33a8b32118c::NUMERIC), -- Celo
    ('USDC', 'mainnet', 1, 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48::NUMERIC), -- Ethereum
    ('USDC', 'mainnet', 999, 0xb88339cb7199b77e23db6e890353e22632ba630f::NUMERIC), -- HyperEVM
    ('USDC', 'mainnet', 57073, 0x2d270e6886d130d724215a266106e6832161eaed::NUMERIC), -- Ink
    ('USDC', 'mainnet', 59144, 0x176211869ca2b568f2a7d4ee941e073a821ee1ff::NUMERIC), -- Linea
    ('USDC', 'mainnet', 143, 0x754704bc059f8c67012fed69bc8a327a5aafb603::NUMERIC), -- Monad
    ('USDC', 'mainnet', 10, 0x0b2c639c533813f4aa9d7837caf62653d097ff85::NUMERIC), -- OP Mainnet
    ('USDC', 'mainnet', 98866, 0x222365ef19f7947e5484218551b56bb3965aa7af::NUMERIC), -- Plume
    ('USDC', 'mainnet', 137, 0x3c499c542cef5e3811e1192ce70d8cc03d5c3359::NUMERIC), -- Polygon PoS
    ('USDC', 'mainnet', 1329, 0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392::NUMERIC), -- Sei
    ('USDC', 'mainnet', 146, 0x29219dd400f2bf60e5a23d13be72b486d4038894::NUMERIC), -- Sonic
    ('USDC', 'mainnet', 130, 0x078d782b760474a361dda0af3839290b0ef57ad6::NUMERIC), -- Unichain
    ('USDC', 'mainnet', 480, 0x79a02482a880bce3f13e09da970dc34db4cd24d1::NUMERIC), -- World Chain
    ('USDC', 'mainnet', 50, 0xfa2958cb79b0491cc627c1557f441ef849ca8eb1::NUMERIC), -- XDC
    ('USDC', 'mainnet', 324, 0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4::NUMERIC), -- ZKsync Era

    -- USDC testnet (EVM only)
    ('USDC', 'testnet', 421614, 0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d::NUMERIC), -- Arbitrum Sepolia
    ('USDC', 'testnet', 5042002, 0x3600000000000000000000000000000000000000::NUMERIC), -- Arc Testnet
    ('USDC', 'testnet', 43113, 0x5425890298aed601595a70ab815c96711a31bc65::NUMERIC), -- Avalanche Fuji
    ('USDC', 'testnet', 84532, 0x036cbd53842c5426634e7929541ec2318f3dcf7e::NUMERIC), -- Base Sepolia
    ('USDC', 'testnet', 11142220, 0x01c5c0122039549ad1493b8220cabedd739bc44e::NUMERIC), -- Celo Sepolia
    ('USDC', 'testnet', 812242, 0x6d7f141b6819c2c9cc2f818e6ad549e7ca090f8f::NUMERIC), -- Codex Testnet
    ('USDC', 'testnet', 11155111, 0x1c7d4b196cb0c7b01d743fbc6116a902379c7238::NUMERIC), -- Ethereum Sepolia
    ('USDC', 'testnet', 33431, 0x2d9f7cad728051aa35ecdc472a14cf8cdf5cfd6b::NUMERIC), -- EDGE Testnet
    ('USDC', 'testnet', 998, 0x2b3370ee501b4a559b57d449569354196457d8ab::NUMERIC), -- HyperEVM Testnet
    ('USDC', 'testnet', 763373, 0xfabab97dce620294d2b0b0e46c68964e326300ac::NUMERIC), -- Ink Testnet
    ('USDC', 'testnet', 59141, 0xfece4462d57bd51a6a552365a011b95f0e16d9b7::NUMERIC), -- Linea Sepolia
    ('USDC', 'testnet', 10143, 0x534b2f3a21130d7a60830c2df862319e593943a3::NUMERIC), -- Monad Testnet
    ('USDC', 'testnet', 2910, 0x7433b41c6c5e1d58d4da99483609520255ab661b::NUMERIC), -- Morph Hoodi Testnet
    ('USDC', 'testnet', 11155420, 0x5fd84259d66cd46123540766be93dfe6d43130d7::NUMERIC), -- OP Sepolia
    ('USDC', 'testnet', 98867, 0xcb5f30e335672893c7eb944b374c196392c19d18::NUMERIC), -- Plume Testnet
    ('USDC', 'testnet', 80002, 0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582::NUMERIC), -- Polygon PoS Amoy
    ('USDC', 'testnet', 1328, 0x4fcf1784b31630811181f670aea7a7bef803eaed::NUMERIC), -- Sei Testnet
    ('USDC', 'testnet', 14601, 0x0ba304580ee7c9a980cf72e55f5ed2e9fd30bc51::NUMERIC), -- Sonic Testnet
    ('USDC', 'testnet', 57054, 0xa4879fed32ecbef99399e5cbc247e533421c4ec6::NUMERIC), -- Sonic Blaze Testnet
    ('USDC', 'testnet', 1301, 0x31d0220469e10c4e71834a79b1f276d740d3768f::NUMERIC), -- Unichain Sepolia
    ('USDC', 'testnet', 4801, 0x66145f38cbac35ca6f1dfb4914df98f1614aea88::NUMERIC), -- World Chain Sepolia
    ('USDC', 'testnet', 51, 0xb5ab69f7bbada22b28e79c8ffaece55ef1c771d4::NUMERIC), -- XDC Apothem
    ('USDC', 'testnet', 300, 0xae045de5638162fa134807cb558e15a3f5a7f853::NUMERIC), -- ZKsync Era Testnet

    -- EURC mainnet (EVM only)
    ('EURC', 'mainnet', 43114, 0xc891eb4cbdeff6e073e859e987815ed1505c2acd::NUMERIC), -- Avalanche C-Chain
    ('EURC', 'mainnet', 8453, 0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42::NUMERIC), -- Base
    ('EURC', 'mainnet', 1, 0x1abaea1f7c830bd89acc67ec4af516284b1bc33c::NUMERIC), -- Ethereum
    ('EURC', 'mainnet', 480, 0x9d1bb5f9fc7f2f56684b145444a186a7f8f6e0f3::NUMERIC), -- World Chain

    -- EURC testnet (EVM only)
    ('EURC', 'testnet', 59141, 0x163f8c2467924be0ae7b5347228cabf260318753::NUMERIC), -- Linea Sepolia
    ('EURC', 'testnet', 43113, 0xa12fb7a3f8b1c76ab3e52f127272995f72510d33::NUMERIC), -- Avalanche Fuji
    ('EURC', 'testnet', 11155111, 0x08210f81f0739871102d3c846233228f9718e4be::NUMERIC), -- Ethereum Sepolia
    ('EURC', 'testnet', 84532, 0x808456652fdb597867f38412077a9182bf77359f::NUMERIC), -- Base Sepolia
    ('EURC', 'testnet', 4801, 0x98a7f2d0fe5bb5d3f6f23e2b66d8756f4b6f6f66::NUMERIC) -- World Chain Sepolia
),
relationships AS (
  SELECT DISTINCT
    src.chain_id AS source_chain_id,
    src.token_address AS source_token_address,
    NULL::NUMERIC AS source_bridge_address,
    dst.chain_id AS dest_chain_id,
    dst.token_address AS dest_token_address
  FROM circle_tokens src
  JOIN circle_tokens dst
    ON src.asset = dst.asset
   AND src.network = dst.network
   AND src.chain_id <> dst.chain_id
)
INSERT INTO erc20_tokens_bridge_relationships (
  source_chain_id,
  source_token_address,
  source_bridge_address,
  dest_chain_id,
  dest_token_address
)
SELECT
  source_chain_id,
  source_token_address,
  source_bridge_address,
  dest_chain_id,
  dest_token_address
FROM relationships
ON CONFLICT (source_chain_id, source_token_address, dest_chain_id)
DO NOTHING;
