import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION, clientCommandSchema } from "@five-days/protocol";

test("rejects out-of-range player input", () => {
  const result = clientCommandSchema.safeParse({
    v: PROTOCOL_VERSION,
    type: "player.input",
    seq: 1,
    clientTime: 0,
    payload: { x: 99, y: 0, aim: 0, buttons: 0 },
  });
  assert.equal(result.success, false);
});
