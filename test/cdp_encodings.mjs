import { writeFileSync } from "fs";

const CDP = process.env.CDP_URL || "http://localhost:9226";
const PAGE = process.env.PAGE_URL || "http://localhost:6002/";
const OUT = process.env.OUT_FILE || "/tmp/opencode/encodings.json";

const TESTS = [
  { name: "brotli", url: "https://api.daniel.priv.no/http-tests/encodings/brotli/decompress", expect: "br" },
  { name: "zstd", url: "https://api.daniel.priv.no/http-tests/encodings/zstd/decompress", expect: "zstd" },
  { name: "gzip", url: "https://httpbin.org/gzip", expect: "gzip" },
  { name: "deflate", url: "https://httpbin.org/deflate", expect: "deflate" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = (e) => rej(new Error("ws connect error"));
  });
}

let id = 0;
function rpc(ws, method, params = {}) {
  return new Promise((res, rej) => {
    const mid = ++id;
    const handler = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id === mid) {
        ws.removeEventListener("message", handler);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

const evalJs = async (ws, expression) => {
  const { result } = await rpc(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) return { error: result.exceptionDetails.text };
  return { value: result.value };
};

const list = await (await fetch(`${CDP}/json/list`)).json();
const tab = list.find((t) => t.type === "page");
const ws = await connect(tab.webSocketDebuggerUrl);
await rpc(ws, "Page.enable");
await rpc(ws, "Runtime.enable");

await rpc(ws, "Page.navigate", { url: PAGE });
let ready = false;
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  const tt = await evalJs(ws, `document.title`);
  if (tt.value && String(tt.value).includes("ready")) { ready = true; break; }
}
console.log("libcurl loaded:", ready);

const results = [];
for (const t of TESTS) {
  await evalJs(ws, `document.getElementById("url").value = ${JSON.stringify(t.url)}`);
  await evalJs(ws, `document.getElementById("raw").textContent = ""`);
  await evalJs(ws, `document.getElementById("body").textContent = "loading..."`);
  await evalJs(ws, `document.getElementById("go").click()`);

  let body = "";
  let raw = "";
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    body = (await evalJs(ws, `document.getElementById("body").textContent`)).value || "";
    raw = (await evalJs(ws, `document.getElementById("raw").textContent`)).value || "";
    if (body && body !== "loading..." && body.length > 60) break;
    if (raw.includes("Error")) break;
  }
  let ok = false;
  let parsed = null;
  try { parsed = JSON.parse(body); ok = true; } catch (e) {}
  results.push({
    name: t.name,
    url: t.url,
    got_json: ok,
    body_len: body.length,
    body_preview: body.slice(0, 400),
    raw_last: raw.split("\n").filter(l => /content-encoding|content-type|accept-encoding|HTTP\/|error|Error/i.test(l)).slice(-8),
  });
  console.log(`--- ${t.name}: ${ok ? "JSON_OK" : "FAIL"} len=${body.length}`);
}

writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log("done ->", OUT);
process.exit(0);