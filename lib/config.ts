import { config } from "dotenv";

config({ path: `./.env.${process.env.NETWORK}` });
