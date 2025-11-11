import "../src/config";
import postgres from "postgres";
import DEFAULT_TOKENS from "./tokens/default-tokens.json";

const sql = postgres(process.env.PG_CONNECTION_STRING, {
  connect_timeout: 5,
});

type TokenListBridgeInfo = {
  tokenAddress?: string;
  originBridgeAddress?: string | null;
  destBridgeAddress?: string | null;
};

type TokenListToken = {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  extensions?: {
    bridgeInfo?: Record<string, TokenListBridgeInfo>;
  };
};

type TokenList = {
  name: string;
  tokens: TokenListToken[];
};

const REMOTE_TOKEN_LISTS = [
  {
    name: "Uniswap Default Token List",
    url: "https://ipfs.io/ipns/tokens.uniswap.org",
    visibility_priority: 0,
  },
  {
    name: "1inch Token List",
    url: "https://tokens.1inch.eth.link",
    visibility_priority: 0,
  },
  {
    name: "Coingecko All Token",
    url: "https://tokens.coingecko.com/uniswap/all.json",
  },
  {
    name: "Aave Token List",
    url: "https://tokenlist.aave.eth.link",
  },
  {
    name: "Compound Token List",
    url: "https://raw.githubusercontent.com/compound-finance/token-list/master/compound.tokenlist.json",
  },
];

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

type BridgeRelationship = {
  source_chain_id: string;
  source_token_address: string;
  source_bridge_address: string | null;
  dest_chain_id: string;
  dest_token_address: string;
};

async function addBridgeRelationships(relationships: BridgeRelationship[]) {
  if (relationships.length === 0) {
    return { count: 0 };
  }

  return await sql`
    INSERT INTO erc20_tokens_bridge_relationships ${sql(relationships)}
    ON CONFLICT (source_chain_id, source_token_address, source_bridge_address)
    DO NOTHING;
  `;
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

    const { count: defaultTokensInserted } = await addTokens(
      DEFAULT_TOKENS as Parameters<typeof addTokens>[0],
      true
    );

    console.log(
      `Inserted/updated ${defaultTokensInserted} rows from hard coded default token list`
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

    const ADDRESS_REGEX = /^0x[a-fA-F0-9]+$/;

    for (const { url, name, visibility_priority = -1 } of REMOTE_TOKEN_LISTS) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(
            `Failed to download remote token list ${name} from ${url}: ${response.status}`
          );
          continue;
        }
        const list = (await response.json()) as TokenList;

        const { count: listTokensImported } = await addTokens(
          list.tokens
            .filter((t) => ADDRESS_REGEX.test(t.address))
            .map((token) => ({
              chain_id: String(token.chainId),
              token_address: token.address,
              token_name: token.name,
              token_symbol: token.symbol,
              token_decimals: token.decimals,
              logo_url: token.logoURI ?? null,
              visibility_priority,
              sort_order: 0,
              total_supply: null,
              usd_price: null,
              last_updated: null,
            }))
        );

        console.log(
          `Inserted ${listTokensImported} rows from remote list ${name} at url ${url}`
        );

        const relationships: BridgeRelationship[] = [];
        for (const token of list.tokens) {
          if (!ADDRESS_REGEX.test(token.address)) {
            continue;
          }

          const bridgeInfo = token.extensions?.bridgeInfo;
          if (!bridgeInfo) {
            continue;
          }

          for (const [destChainId, info] of Object.entries(bridgeInfo)) {
            if (!info?.tokenAddress || !ADDRESS_REGEX.test(info.tokenAddress)) {
              continue;
            }

            relationships.push({
              source_chain_id: String(token.chainId),
              source_token_address: token.address,
              source_bridge_address:
                info.originBridgeAddress &&
                ADDRESS_REGEX.test(info.originBridgeAddress)
                  ? info.originBridgeAddress
                  : null,
              dest_chain_id: String(destChainId),
              dest_token_address: info.tokenAddress,
            });
          }
        }

        if (relationships.length > 0) {
          const { count: bridgeRelationshipsUpserted } =
            await addBridgeRelationships(relationships);
          console.log(
            `Inserted ${bridgeRelationshipsUpserted} bridge relationships from remote list ${name}`
          );
        }
      } catch (e) {
        console.error(`Failed to import remote token list ${name}`, e);
      }
    }
  });

  await sql.end({ timeout: 5 });
}

main()
  .catch((err) => {
    console.error("Token sync failed", err);
    process.exit(1);
  })
  .finally(() => sql.end({ timeout: 5 }));
