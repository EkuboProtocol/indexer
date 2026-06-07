import { config } from "dotenv";
import type { NetworkType } from "./entrypoints/types";

export function loadConfig(networkType: NetworkType) {
  config({
    path: `./.env.${networkType}.${process.env.NETWORK}.local`,
  });
  config({ path: `./.env.${networkType}.${process.env.NETWORK}` });
  config({ path: `./.env.${networkType}.local` });
  config({ path: `./.env.${networkType}` });
  config({ path: `./.env.local` });
  config({ path: `./.env` });
}
