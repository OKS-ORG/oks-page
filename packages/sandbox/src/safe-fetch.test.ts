// Spec 04 acceptance test PL-30.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { safeFetch } from "./safe-fetch.js";

describe("safeFetch", () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => res.end("safe-response"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
  });

  test("PL-30 the core connects to the checked address, not to a second lookup of the same name", async () => {
    let calls = 0;
    const resolve = async () => {
      calls++;
      if (calls === 1) return [{ address: "127.0.0.1", family: 4 }];
      // A name that answers differently the second time: if safeFetch looked it up again right
      // before connecting (the trick this test exists to catch), it would land here instead.
      return [{ address: "10.0.0.1", family: 4 }];
    };

    const result = await safeFetch(new URL(`http://this-name-lies.example:${port}/`), {
      allowPrivateForTests: true,
      resolve,
    });

    expect(result.status).toBe(200);
    expect(result.text).toBe("safe-response");
    expect(calls).toBe(1);
  });

  test("every address a name resolves to is checked, not only the one that is used", async () => {
    const resolve = async () => [
      { address: "127.0.0.1", family: 4 },
      { address: "169.254.169.254", family: 4 }, // the cloud metadata address
    ];

    await expect(
      safeFetch(new URL(`https://multi-address.example:${port}/`), { resolve }),
    ).rejects.toMatchObject({ code: "ssrf" });
  });
});
