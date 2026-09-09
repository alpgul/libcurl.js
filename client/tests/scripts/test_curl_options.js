async function test() {
  let session = new libcurl.HTTPSession();

  //1. non-allowlisted option (a callback, never allowed across the bridge)
  //   must be rejected by the C-side allowlist
  {
    let handle = session.stream_response("https://example.com/", () => {}, () => {});
    let rejected = false;
    try {
      libcurl.set_curl_option(handle, "CURLOPT_WRITEFUNCTION", 0);
    }
    catch (e) {
      rejected = true;
      assert(String(e.message).includes("not supported"), "wrong rejection reason: " + e.message);
    }
    assert(rejected, "non-allowlisted option was accepted");
    session.remove_request(handle);
  }

  //2. invalid numeric value for a long option must throw a TypeError
  {
    let handle = session.stream_response("https://example.com/", () => {}, () => {});
    let failed = false;
    try {
      libcurl.set_curl_option(handle, {opt: "CURLOPT_TIMEOUT", type: "long", value: "not-a-number"});
    }
    catch (e) {
      failed = true;
      assert(/must be a number/.test(e.message), "wrong type error: " + e.message);
    }
    assert(failed, "invalid numeric value was accepted");
    session.remove_request(handle);
  }

  //3. CURLOPT_TIMEOUT end-to-end: a 10s delay endpoint must abort with
  //   CURLE_OPERATION_TIMEDOUT (28) after 2s
  {
    let error_code = await new Promise((resolve) => {
      let handle = session.stream_response("https://httpbin.org/delay/10", () => {}, (error) => resolve(error));
      libcurl.set_curl_option(handle, "CURLOPT_TIMEOUT", 2);
      session.start_request(handle);
      setTimeout(() => resolve(-999), 20000);
    });
    assert(error_code === 28, "timeout option not honored, error = " + error_code);
  }

  //4. object form with a string option must apply cleanly to a successful request
  {
    let error_code = await new Promise((resolve) => {
      let handle = session.stream_response("https://example.com/", () => {}, (error) => resolve(error));
      libcurl.set_curl_option(handle, {opt: "CURLOPT_USERAGENT", type: "string", value: "libcurl-bridge-test"});
      session.start_request(handle);
      setTimeout(() => resolve(-999), 20000);
    });
    assert(error_code === 0, "string-option request failed, error = " + error_code);
  }

  //5. header-list option: append a custom header and confirm the echo endpoint
  //   received it (proves the slist path reaches the actual transfer)
  {
    let result = await new Promise((resolve) => {
      let chunks = [];
      let headers_cb = (stream) => {
        let reader = stream.getReader();
        let pump = () => {
          reader.read().then(({done, value}) => {
            if (done) resolve({error: 0, text: chunks.join("")});
            else {
              chunks.push(new TextDecoder().decode(value));
              pump();
            }
          });
        };
        pump();
      };
      let handle = session.stream_response("https://httpbin.org/headers", headers_cb, (error) => resolve({error, text: chunks.join("")}), null);
      libcurl.set_curl_option(handle, {opt: "CURLOPT_HTTPHEADER_APPEND", type: "header-list", value: "X-Libcurl-Bridge: 1"});
      session.start_request(handle);
      setTimeout(() => resolve({error: -999, text: chunks.join("")}), 20000);
    });
    assert(result.error === 0, "header-list request failed, error = " + result.error);
    let echo = JSON.parse(result.text);
    assert(echo.headers["X-Libcurl-Bridge"] === "1", "custom header not echoed: " + result.text);
  }

  session.close();
}