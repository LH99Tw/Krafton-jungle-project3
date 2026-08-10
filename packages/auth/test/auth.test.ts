import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  decryptSecret,
  encryptSecret,
  safeReturnPath,
  signGameTicket,
  verifyGameTicket,
} from "../src/index";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();

test("encrypts OAuth and refresh-token material with authenticated encryption", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptSecret("secret", key);
  assert.notEqual(encrypted, "secret");
  assert.equal(decryptSecret(encrypted, key), "secret");
  assert.throws(() => decryptSecret(`${encrypted}broken`, key));
});

test("accepts only local return paths", () => {
  assert.equal(safeReturnPath("/play?mode=full"), "/play?mode=full");
  assert.equal(safeReturnPath("https://evil.example"), "/");
  assert.equal(safeReturnPath("//evil.example"), "/");
  assert.equal(safeReturnPath("/api/auth/callback"), "/");
});

test("signs a short-lived game ticket and rejects expiration", async () => {
  const valid = await signGameTicket({
    userId: "user-1",
    displayName: "용사",
    privateKeyPem: privatePem,
    expiresInSeconds: 90,
  });
  const claims = await verifyGameTicket(valid.token, publicPem);
  assert.equal(claims.sub, "user-1");
  assert.equal(claims.scope, "room:join");

  const expired = await signGameTicket({
    userId: "user-1",
    displayName: "용사",
    privateKeyPem: privatePem,
    expiresInSeconds: -1,
  });
  await assert.rejects(() => verifyGameTicket(expired.token, publicPem));
});
