import { writeFileSync } from "fs";

const CDP = process.env.CDP_URL || "http://localhost:9226";
const PAGE = process.env.PAGE_URL || "http://localhost:6002/";
const TARGET_URL = process.env.TARGET_URL || "https://tls.browserleaks.com/json";
const OUT = process.env.OUT_FILE || "/tmp/opencode/fingerprint.json";
const MODE = process.env.MODE || "libcurl";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = (e) => rej(new Error("ws connect error: " + JSON.stringify(e)));
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
  if (result.exceptionDetails) {
    return { error: result.exceptionDetails.text };
  }
  return { value: result.value };
};

const list = await (await fetch(`${CDP}/json/list`)).json();
const tab = list.find((t) => t.type === "page");
if (!tab) {
  console.error("no page tab found");
  process.exit(1);
}
const ws = await connect(tab.webSocketDebuggerUrl);
await rpc(ws, "Page.enable");
await rpc(ws, "Runtime.enable");

const result = { mode: MODE, page: PAGE, target: TARGET_URL, cdp: CDP, at: new Date().toISOString() };

try {
  if (MODE === "libcurl") {
    await rpc(ws, "Page.navigate", { url: PAGE });

    let ready = false;
    for (let i = 0; i < 180; i++) {
      const st = await evalJs(ws, `document.getElementById("status").textContent`);
      await sleep(1000);
      const tt = await evalJs(ws, `document.title`);
      if (tt.value && tt.value.includes("ready")) {
        ready = true;
        result.ready_after = `${i + 1}s`;
        break;
      }
      if ((i + 1) % 10 === 0) console.log(`waiting for libcurl load... status=${st.value}`);
    }
    result.loaded = ready;
    if (!ready) {
      result.status = await evalJs(ws, `document.getElementById("status").textContent`);
      result.raw = await evalJs(ws, `document.getElementById("raw").textContent`);
      writeFileSync(OUT, JSON.stringify(result, null, 2));
      console.error("libcurl.js did not load in time");
      process.exit(2);
    }

    await evalJs(ws, `document.getElementById("url").value = ${JSON.stringify(TARGET_URL)}`);
    await evalJs(ws, `document.getElementById("go").click()`);

    let body = "";
    let raw = "";
    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      body = (await evalJs(ws, `document.getElementById("body").textContent`)).value || "";
      raw = (await evalJs(ws, `document.getElementById("raw").textContent`)).value || "";
      if (body.length > 200 && !body.startsWith("Error")) break;
      if (raw.includes("Error")) {
        result.raw = raw;
        writeFileSync(OUT, JSON.stringify(result, null, 2));
        console.error("error in raw output:", raw.split("\n").slice(-5).join("\n"));
        process.exit(3);
      }
      if ((i + 1) % 10 === 0) console.log(`waiting for response... len=${body.length}`);
    }
    result.body_len = body.length;
    result.body = body;
    result.raw = raw;
    result.status = (await evalJs(ws, `document.getElementById("status").textContent`)).value;
  } else {
    await rpc(ws, "Page.navigate", { url: TARGET_URL });
    let text = "";
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      const t = (await evalJs(ws, `document.body.innerText`)).value || "";
      if (t.startsWith("{") && t.length > 50) {
        text = t;
        break;
      }
    }
    result.body = text;
  }
} catch (e) {
  result.error = String(e);
}

writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log("done ->", OUT, "body_len:", result.body_len);