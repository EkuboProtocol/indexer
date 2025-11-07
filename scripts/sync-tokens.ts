import "../src/config";
import postgres from "postgres";
import { tokens as UNISWAP_DEFAULT_TOKENS } from "@uniswap/default-token-list";
import ETH_MAINNET_TOKENS from "./tokens/eth_mainnet.json";
import ETH_SEPOLIA_TOKENS from "./tokens/eth_sepolia.json";
import EVM_TOKEN_LOGOS from "./tokens/evm_logos.json";
import STARKNET_MAINNET_TOKENS from "./tokens/starknet_mainnet.json";
import STARKNET_SEPOLIA_TOKENS from "./tokens/starknet_sepolia.json";
import STARKNET_TOKEN_LOGOS from "./tokens/starknet_logos.json";

const sql = postgres(process.env.PG_CONNECTION_STRING, {
  connect_timeout: 5,
});

async function addTokens(
  tokens: {
    chain_id: string;
    token_address: string;
    token_name: string;
    token_symbol: string;
    token_decimals: number;
    total_supply: string | null;
    logo_url: string | null;
    visibility_priority: number;
    sort_order: number;
  }[],
  upsert: boolean = false
) {
  if (upsert) {
    return await sql`
      INSERT INTO erc20_tokens ${sql(tokens)}
      ON CONFLICT (chain_id, token_address)
      DO UPDATE
          SET token_name = EXCLUDED.token_name,
              token_symbol = EXCLUDED.token_symbol,
              token_decimals = EXCLUDED.token_decimals,
              logo_url = EXCLUDED.logo_url,
              visibility_priority = EXCLUDED.visibility_priority,
              sort_order = EXCLUDED.sort_order,
              total_supply = EXCLUDED.total_supply;
    `;
  } else {
    return await sql`
      INSERT INTO erc20_tokens ${sql(tokens)}
      ON CONFLICT (chain_id, token_address)
      DO NOTHING;
    `;
  }
}

async function main() {
  await sql.begin(async (sql) => {
    const existingTokensCount = await sql<
      {
        num_tokens: bigint;
      }[]
    >`SELECT count(1) as num_tokens FROM erc20_tokens`;

    console.log(
      `Database has ${existingTokensCount[0]?.num_tokens ?? 0} tokens`
    );

    const { count: ethMainnetTokensInserted } = await addTokens(
      ETH_MAINNET_TOKENS.map((token) => ({
        chain_id: "1",
        token_address: token.token_address,
        token_name: token.name,
        token_symbol: token.symbol,
        token_decimals: token.decimals,
        total_supply:
          token.total_supply !== null
            ? BigInt(
                Math.floor(token.total_supply * 10 ** token.decimals)
              ).toString()
            : null,
        logo_url:
          (EVM_TOKEN_LOGOS as Record<string, string>)[token.symbol] ?? null,
        visibility_priority: token.hidden ? -1 : 1,
        sort_order: token.sort_order,
      })),
      true
    );

    console.log(
      `Inserted/updated ${ethMainnetTokensInserted} rows from hard coded list for Ethereum Mainnet`
    );

    const { count: ethSepoliaTokensInserted } = await addTokens(
      ETH_SEPOLIA_TOKENS.map((token) => ({
        chain_id: "11155111",
        token_address: token.token_address,
        token_name: token.name,
        token_symbol: token.symbol,
        token_decimals: token.decimals,
        total_supply:
          token.total_supply !== null
            ? BigInt(
                Math.floor(token.total_supply * 10 ** token.decimals)
              ).toString()
            : null,
        logo_url:
          (EVM_TOKEN_LOGOS as Record<string, string>)[token.symbol] ?? null,
        visibility_priority: 1,
        sort_order: token.sort_order,
      })),
      true
    );

    console.log(
      `Inserted/updated ${ethSepoliaTokensInserted} rows from hard coded list for Ethereum Sepolia`
    );

    const { count: starknetMainnetTokensInserted } = await addTokens(
      STARKNET_MAINNET_TOKENS.map((token) => ({
        chain_id: "0x534e5f4d41494e",
        token_address: token.l2_token_address,
        token_name: token.name,
        token_symbol: token.symbol,
        token_decimals: token.decimals,
        total_supply:
          token.total_supply !== null
            ? BigInt(
                Math.floor(token.total_supply * 10 ** token.decimals)
              ).toString()
            : null,
        logo_url:
          (STARKNET_TOKEN_LOGOS as Record<string, string>)[token.symbol] ??
          null,
        visibility_priority: 1,
        sort_order: token.sort_order,
      })),
      true
    );

    console.log(
      `Inserted/updated ${starknetMainnetTokensInserted} rows from hard coded list for starknet mainnet`
    );

    const { count: starknetSepoliaTokensInserted } = await addTokens(
      STARKNET_SEPOLIA_TOKENS.map((token) => ({
        chain_id: "0x534e5f4d41494f",
        token_address: token.l2_token_address,
        token_name: token.name,
        token_symbol: token.symbol,
        token_decimals: token.decimals,
        total_supply:
          token.total_supply !== null
            ? BigInt(
                Math.floor(token.total_supply * 10 ** token.decimals)
              ).toString()
            : null,
        logo_url:
          (STARKNET_TOKEN_LOGOS as Record<string, string>)[token.symbol] ??
          null,
        visibility_priority: 1,
        sort_order: token.sort_order,
      })),
      true
    );

    console.log(
      `Inserted/updated ${starknetSepoliaTokensInserted} rows from hard coded list for starknet mainnet`
    );

    const { count: registrationTokensCount } = await sql`
      INSERT INTO erc20_tokens (chain_id,token_address,token_name,token_symbol,token_decimals,total_supply,visibility_priority,sort_order)
        (SELECT chain_id, address, name, symbol, decimals, total_supply, -1 as visibility_priority, 0 as sort_order 
        FROM latest_token_registrations_view)
        ON CONFLICT (chain_id, token_address) DO NOTHING;
    `;

    console.log(
      `Inserted ${registrationTokensCount} from manual token registration events`
    );

    const { count: uniswapTokensInserted } = await addTokens(
      UNISWAP_DEFAULT_TOKENS.filter((t) =>
        [1, 11155111].includes(t.chainId)
      ).map((token) => ({
        chain_id: String(token.chainId),
        token_address: token.address,
        token_name: token.name,
        token_symbol: token.symbol,
        token_decimals: token.decimals,
        logo_url: token.logoURI,
        visibility_priority: 0,
        sort_order: 0,
      }))
    );

    console.log(
      `Inserted ${uniswapTokensInserted} rows from Uniswap's default token list`
    );
  });

  await sql.end({ timeout: 5 });
}

main()
  .catch((err) => {
    console.error("Token sync failed", err);
    process.exit(1);
  })
  .finally(() => sql.end({ timeout: 5 }));
