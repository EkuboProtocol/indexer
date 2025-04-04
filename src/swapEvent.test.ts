import { describe, expect, it } from "vitest";
import { parseSwapEvent } from "./swapEvent.ts";

describe(parseSwapEvent, () => {
  it("works for example", () => {
    expect(
      parseSwapEvent(
        "0x9995855c00494d039ab6792f18e368e530dff93112f9571ed354b82e74b3b03938d2d7d26c61897be74024a7170b8052743de8b9000000000000000000b1a2bc2ec50000fffffffffffffffffffffffff86e62730000000000000000000004114007e32b4000a01a8f32a3986eab505efec98825",
      ),
    ).toMatchInlineSnapshot(`
      {
        "delta0": 50000000000000000n,
        "delta1": -126983565n,
        "liquidityAfter": 4472135213867n,
        "locker": "0x9995855C00494d039aB6792f18e368e530DFf931",
        "poolId": "0x12f9571ed354b82e74b3b03938d2d7d26c61897be74024a7170b8052743de8b9",
        "sqrtRatioAfter": 12989159145539564760192658383568896n,
        "tickAfter": -20346843,
      }
    `);
  });
});
