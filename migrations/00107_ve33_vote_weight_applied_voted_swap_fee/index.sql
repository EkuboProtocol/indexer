ALTER TABLE ve33_vote_weight_applied
    ADD COLUMN voted_swap_fee NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE ve33_vote_weight_applied
    ALTER COLUMN voted_swap_fee DROP DEFAULT;
