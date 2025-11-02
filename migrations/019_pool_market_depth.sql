
CREATE VIEW pool_market_depth_view AS
WITH depth_percentages AS (
	SELECT
		(power(1.21, generate_series(0, 40)) * 0.00005)::float AS depth_percent
),
last_swap_per_pair AS (
	SELECT
		s.chain_id,
		token0,
		token1,
		max(event_id) AS event_id
	FROM
		swaps s
		JOIN pool_keys pk ON s.pool_key_id = pk.pool_key_id
	WHERE
		liquidity_after != 0
	GROUP BY
		s.chain_id, token0, token1
),
last_swap_time_per_pair AS (
	SELECT
		chain_id,
		ls.token0,
		ls.token1,
		b.block_time
	FROM
		last_swap_per_pair ls
		JOIN swaps USING (chain_id, event_id)
		JOIN blocks b USING (chain_id, block_number)
),
median_ticks AS (
	SELECT
		pk.chain_id,
		pk.token0,
		pk.token1,
		percentile_cont(0.5) WITHIN GROUP (ORDER BY tick_after) AS median_tick
	FROM
		swaps s
		JOIN pool_keys pk USING (pool_key_id)
		JOIN blocks b ON b.chain_id = s.chain_id AND b.block_number = s.block_number
		JOIN last_swap_time_per_pair lstpp ON pk.chain_id = lstpp.chain_id
			AND pk.token0 = lstpp.token0
			AND pk.token1 = lstpp.token1
	WHERE
		b.block_time >= lstpp.block_time - interval '1 hour'
		AND liquidity_after != 0
	GROUP BY
		pk.chain_id, pk.token0, pk.token1
),
pool_states AS (
	SELECT
		pk.pool_key_id,
		pk.token0,
		pk.token1,
		dp.depth_percent,
		floor(ln(1::numeric + dp.depth_percent) / ln(1.000001))::int4 AS depth_in_ticks,
		ceil(log(1::numeric + (pk.fee / pk.fee_denominator)) / log(1.000001))::int4 AS fee_in_ticks,
		round(mt.median_tick)::int4 AS last_tick
	FROM
		pool_keys pk
		CROSS JOIN depth_percentages dp
		LEFT JOIN median_ticks mt ON pk.chain_id = mt.chain_id
			AND pk.token0 = mt.token0
			AND pk.token1 = mt.token1
),
pool_ticks AS (
	SELECT
		pool_key_id,
		sum(net_liquidity_delta_diff) OVER (PARTITION BY ppptliv.pool_key_id ORDER BY ppptliv.tick ROWS UNBOUNDED PRECEDING) AS liquidity,
		tick AS tick_start,
		lead(tick) OVER (PARTITION BY ppptliv.pool_key_id ORDER BY ppptliv.tick) AS tick_end
	FROM
		per_pool_per_tick_liquidity ppptliv
),
depth_liquidity_ranges AS (
	SELECT
		pt.pool_key_id,
		pt.liquidity,
		ps.depth_percent,
		int4range(ps.last_tick - ps.depth_in_ticks, ps.last_tick - ps.fee_in_ticks) * int4range(pt.tick_start, pt.tick_end) AS overlap_range_below,
		int4range(ps.last_tick + ps.fee_in_ticks, ps.last_tick + ps.depth_in_ticks) * int4range(pt.tick_start, pt.tick_end) AS overlap_range_above
	FROM
		pool_ticks pt
		JOIN pool_states ps ON pt.pool_key_id = ps.pool_key_id
	WHERE
		liquidity != 0
		AND ps.fee_in_ticks < ps.depth_in_ticks
),
token_amounts_by_pool AS (
	SELECT
		pool_key_id,
		depth_percent,
		floor(sum(liquidity * (power(1.0000005::numeric, upper(overlap_range_below)) - power(1.0000005::numeric, lower(overlap_range_below))))) AS amount1,
		floor(sum(liquidity * ((1::numeric / power(1.0000005::numeric, lower(overlap_range_above))) - (1::numeric / power(1.0000005::numeric, upper(overlap_range_above)))))) AS amount0
	FROM
		depth_liquidity_ranges
	WHERE
		NOT isempty(overlap_range_below)
		OR NOT isempty(overlap_range_above)
	GROUP BY
		pool_key_id,
		depth_percent
),
total_depth AS (
	SELECT
		pool_key_id,
		depth_percent,
		coalesce(sum(amount0), 0) AS depth0,
		coalesce(sum(amount1), 0) AS depth1
	FROM
		token_amounts_by_pool tabp
	GROUP BY
		pool_key_id,
		depth_percent
)
SELECT
	td.pool_key_id,
	td.depth_percent AS depth_percent,
	td.depth0,
	td.depth1
FROM
	total_depth td;

CREATE MATERIALIZED VIEW pool_market_depth_materialized AS
SELECT
	*
FROM
	pool_market_depth_view;

CREATE UNIQUE INDEX idx_pool_market_depth ON pool_market_depth_materialized (pool_key_id, depth_percent);

SELECT
	cron.schedule ('refresh_pool_market_depth', '*/15 * * * *', $$
		SELECT
			safe_refresh_mv ('pool_market_depth_materialized');

$$);
