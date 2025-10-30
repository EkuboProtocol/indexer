import { config } from "dotenv";

config({ path: `./.env.local` });
config({
  path: `./.env.${process.env.NETWORK_TYPE}.${process.env.NETWORK}.local`,
});
config({ path: `./.env.${process.env.NETWORK_TYPE}.${process.env.NETWORK}` });
config({ path: `./.env.${process.env.NETWORK_TYPE}.local` });
config({ path: `./.env.${process.env.NETWORK_TYPE}` });
config({ path: `./.env` });
