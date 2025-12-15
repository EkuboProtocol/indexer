import "../src/config";
import postgres, { type Sql } from "postgres";

const sql = postgres(process.env.PG_CONNECTION_STRING!, {
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

async function addTokens({
  sql,
  tokens,
  upsert = false,
}: {
  sql: Sql;
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
  }[];
  upsert?: boolean;
}): Promise<number> {
  if (!tokens.length) return 0;

  if (upsert) {
    const { count } = await sql`
      INSERT INTO erc20_tokens ${sql(tokens)}
      ON CONFLICT (chain_id, token_address)
      DO UPDATE
          SET token_name = EXCLUDED.token_name,
              token_symbol = EXCLUDED.token_symbol,
              token_decimals = EXCLUDED.token_decimals,
              logo_url = EXCLUDED.logo_url,
              visibility_priority = EXCLUDED.visibility_priority,
              sort_order = EXCLUDED.sort_order,
              total_supply = EXCLUDED.total_supply
          WHERE
            erc20_tokens.token_name != EXCLUDED.token_name OR
            erc20_tokens.token_symbol != EXCLUDED.token_symbol OR
            erc20_tokens.token_decimals != EXCLUDED.token_decimals OR
            erc20_tokens.logo_url != EXCLUDED.logo_url OR
            erc20_tokens.visibility_priority != EXCLUDED.visibility_priority OR
            erc20_tokens.sort_order != EXCLUDED.sort_order OR
            erc20_tokens.total_supply != EXCLUDED.total_supply;
    `;
    return count;
  } else {
    const { count } = await sql`
      INSERT INTO erc20_tokens ${sql(tokens)}
      ON CONFLICT (chain_id, token_address)
      DO NOTHING;
    `;
    return count;
  }
}

type BridgeRelationship = {
  source_chain_id: string;
  source_token_address: string;
  source_bridge_address: string | null;
  dest_chain_id: string;
  dest_token_address: string;
};

async function addBridgeRelationships({
  sql,
  relationships,
}: {
  sql: Sql;
  relationships: BridgeRelationship[];
}) {
  if (relationships.length === 0) {
    return 0;
  }

  const { count } = await sql`
    INSERT INTO erc20_tokens_bridge_relationships ${sql(relationships)}
    ON CONFLICT (source_chain_id, source_token_address, source_bridge_address)
    DO NOTHING;
  `;
  return count;
}

async function main() {
  await sql.begin(async (sql) => {
    const existingTokensCount = await sql<
      {
        chain_id: bigint;
        num_tokens: bigint;
      }[]
    >`SELECT chain_id, count(1) as num_tokens FROM erc20_tokens GROUP BY chain_id ORDER BY 2 DESC`;

    console.log(
      `Database has tokens (by chain ID):\n${existingTokensCount
        .map(({ chain_id, num_tokens }) => `\t${chain_id}: ${num_tokens}`)
        .join("\n")}`
    );

    const defaultTokensResponse = await fetch(
      "https://raw.githubusercontent.com/EkuboProtocol/default-tokens/refs/heads/main/tokens.json"
    );
    if (!defaultTokensResponse.ok) {
      console.warn(
        `Failed to fetch default tokens (${defaultTokensResponse.status}): ${defaultTokensResponse.statusText}`
      );
    } else {
      const defaultTokens = (await defaultTokensResponse.json()) as {
        chain_id: string;
        token_address: string;
        token_name: string;
        token_symbol: string;
        token_decimals: number;
        logo_url: string;
        visibility_priority: number;
        sort_order: number;
      }[];

      const numDefaultTokensUpserted = await addTokens({
        sql,
        tokens: defaultTokens.map((t) => ({
          ...t,
          total_supply: null,
        })) satisfies Parameters<typeof addTokens>[0]["tokens"],
        upsert: true,
      });

      console.log(
        `Upserted ${numDefaultTokensUpserted} rows from default token list`
      );
    }

    const registeredTokens = await sql<
      {
        chain_id: bigint;
        token_address: string;
        token_name: string;
        token_symbol: string;
        token_decimals: number;
        total_supply: string;
        symbol_registration_index: bigint;
      }[]
    >`
      SELECT chain_id,
            address  AS token_address,
            name     AS token_name,
            symbol   AS token_symbol,
            decimals AS token_decimals,
            total_supply
      FROM latest_token_registrations_view;
    `;

    const userRegistrationTokensCount = await addTokens({
      sql,
      tokens: registeredTokens.map((t) => ({
        chain_id: t.chain_id.toString(),
        sort_order: -1,
        visibility_priority: -1,
        token_address: t.token_address,
        token_decimals: t.token_decimals,
        token_name: t.token_name,
        token_symbol: t.token_symbol,
        total_supply: t.total_supply,
        logo_url: null,
      })),
    });

    console.log(
      `Inserted ${userRegistrationTokensCount} from user token registration events`
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

        const listTokensImported = await addTokens({
          sql,
          tokens: list.tokens
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
            })),
        });

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
          const bridgeRelationshipsUpserted = await addBridgeRelationships({
            sql,
            relationships,
          });
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
