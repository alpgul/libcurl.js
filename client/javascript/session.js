class CurlSession {
  constructor(options={}) {
    check_loaded(true);

    this.options = options;
    this.session_ptr = _session_create();
    this.active_requests = 0;
    this.event_loop = null;
    this.requests_list = [];
    this.to_remove = [];
  
    this.end_callback_ptr = Module.addFunction((request_id, error) => {
      this.end_callback(request_id, error);
    }, "vii");
    this.headers_callback_ptr = Module.addFunction((request_id, chunk_ptr, chunk_size) => {
      this.headers_callback(request_id, chunk_ptr, chunk_size)
    }, "viii");
    this.data_callback_ptr = Module.addFunction((request_id, chunk_ptr, chunk_size) => {
      this.data_callback(request_id, chunk_ptr, chunk_size)
    }, "viii");
    this.request_callbacks = {};
    this.last_request_id = 0;
  }

  assert_ready() {
    if (!this.session_ptr) {
      throw new Error("session has been removed");
    }
  }

  set_connections(connections_limit, cache_limit, host_conn_limit=0) {
    this.assert_ready();
    _session_set_options(this.session_ptr, connections_limit, cache_limit, host_conn_limit);
  }

  end_callback(request_id, error) {
    this.active_requests--;
    this.request_callbacks[request_id].end(error);
    delete this.request_callbacks[request_id];
  }

  data_callback(request_id, chunk_ptr, chunk_size) {
    let data = Module.HEAPU8.subarray(chunk_ptr, chunk_ptr + chunk_size);
    let chunk = new Uint8Array(data);
    this.request_callbacks[request_id].data(chunk);
  }

  headers_callback(request_id, chunk_ptr, chunk_size) {
    let data = Module.HEAPU8.subarray(chunk_ptr, chunk_ptr + chunk_size);
    let chunk = new Uint8Array(data);
    this.request_callbacks[request_id].headers(chunk);
  }

  create_request(url, js_data_callback, js_end_callback, js_headers_callback) {
    this.assert_ready();
    let request_id = this.last_request_id++;
    this.request_callbacks[request_id] = {
      end: js_end_callback,
      data: js_data_callback,
      headers: js_headers_callback
    }
  
    let request_ptr = c_func(_create_request, [
      url, request_id, this.data_callback_ptr, this.end_callback_ptr, this.headers_callback_ptr
    ]);
    return request_ptr;
  }

  remove_request_now(request_ptr) {
    if (this.session_ptr) {
      _session_remove_request(this.session_ptr, request_ptr);
    }
    _request_cleanup(request_ptr);
    
    let request_index = this.requests_list.indexOf(request_ptr);
    if (request_index !== -1) {
      this.requests_list.splice(request_index, 1);
    }
  }

  //remove the request on the next iteration of the loop
  remove_request(request_ptr) {
    this.assert_ready();
    setTimeout(() => {
      this.remove_request_now(request_ptr);
    }, 1)
  }

  start_request(request_ptr) {
    this.assert_ready();
    _session_add_request(this.session_ptr, request_ptr);
    _session_perform(this.session_ptr);

    this.active_requests++;
    this.requests_list.push(request_ptr);
  
    if (this.event_loop) {
      return;
    }
    
    this.event_loop = setInterval(() => {
      this.event_loop_func();
    }, 0);
  }

  event_loop_func() {
    let libcurl_active = _session_get_active(this.session_ptr);
    if (libcurl_active || this.active_requests) {
      _session_perform(this.session_ptr);
    }
    else {
      clearInterval(this.event_loop);
      this.event_loop = null;
    }
  }

  close_now() {
    for (let request_ptr of this.requests_list) {
      this.remove_request_now(request_ptr);
    }
    _session_cleanup(this.session_ptr);
    this.session_ptr = null;
    Module.removeFunction(this.end_callback_ptr);
    Module.removeFunction(this.headers_callback_ptr);
    Module.removeFunction(this.data_callback_ptr);
  }

  close() {
    this.assert_ready();
    setTimeout(() => {
      this.close_now();
    }, 1);
  }

  //wrap request callbacks using a readable stream and return the new callbacks
  stream_response(url, headers_callback, end_callback, abort_signal) {
    let stream_controller;
    let aborted = false;
    let headers_received = false;

    let stream = new ReadableStream({
      start(controller) {
        stream_controller = controller;
      }
    });

    if (abort_signal instanceof AbortSignal) {
      abort_signal.addEventListener("abort", () => {
        if (aborted) return;
        aborted = true;
        if (headers_received) {
          stream_controller.error("The operation was aborted.");
        }
        real_end_callback(-1);
      });
    }

    let real_data_callback = (new_data) => {
      if (!headers_received) {
        headers_received = true;
        headers_callback(stream);
      }

      try {
        stream_controller.enqueue(new_data);
      }
      catch (e) {
        //the readable stream has been closed elsewhere, so cancel the request
        if (aborted) return;
        aborted = true;
        if (e instanceof TypeError) {
          end_callback(-1);
        }
        else {
          throw e;
        }
      }
    }

    let real_end_callback = (error) => {
      if (!headers_received && error === 0) {
        headers_received = true;
        headers_callback(stream);
      }

      try {
        stream_controller.close();
      }
      catch {}
      end_callback(error);
    }

    return this.create_request(url, real_data_callback, real_end_callback, () => {});
  }

  //typed JS->C bridge: set a curl option on a single per-request easy handle.
  //this is the escape hatch for options that the fixed JSON params mapping
  //(libcurl/javascript/http.js) doesn't cover. call it after stream_response()
  //and before start_request(). exceptions on unknown/unsafe options:
  //  set_curl_option(handle, "CURLOPT_TIMEOUT", 30)
  //  set_curl_option(handle, {opt: "CURLOPT_USERAGENT", type: "string", value: "..."})
  //supported types: "long" (number/boolean), "string", "header-list"
  //(newline-separated "Name: value" lines appended to the request headers).
  set_curl_option(request_ptr, opt, value) {
    return set_curl_option(request_ptr, opt, value);
  }
}

//free-form variant, also exposed as api.set_curl_option
function set_curl_option(http_handle, opt, value) {
  let opt_name, opt_type;
  if (typeof opt === "object" && opt !== null) {
    opt_name = opt.opt;
    opt_type = opt.type;
    value = opt.value;
  }
  else {
    opt_name = opt;
  }

  if (typeof opt_name !== "string") {
    throw new TypeError("curl option name must be a string");
  }
  if (value === undefined) {
    throw new TypeError(`no value given for curl option "${opt_name}"`);
  }

  if (!opt_type) {
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      opt_type = "long";
    }
    else if (typeof value === "string") {
      opt_type = "string";
    }
    else {
      throw new TypeError(`invalid value type for curl option "${opt_name}": ${typeof value}`);
    }
  }

  let value_str;
  if (opt_type === "long") {
    if (typeof value === "boolean") value_str = value ? "1" : "0";
    else if (typeof value === "number" || typeof value === "bigint") value_str = String(value);
    else throw new TypeError(`value for curl option "${opt_name}" must be a number`);
  }
  else if (opt_type === "string" || opt_type === "header-list") {
    if (typeof value !== "string") throw new TypeError(`value for curl option "${opt_name}" must be a string`);
    value_str = value;
  }
  else {
    throw new TypeError(`unsupported curl option type "${opt_type}"`);
  }

  let result = c_func(_set_request_option, [http_handle, opt_name, opt_type, value_str]);
  if (result === 1) return true;
  if (result === 0) throw new Error(`curl option "${opt_name}" is not supported`);
  if (result === -1) throw new Error(`cannot apply curl option "${opt_name}": invalid request handle`);
  if (result === -2) throw new TypeError(`value for curl option "${opt_name}" must be a number`);
  if (result === -3) throw new TypeError(`type "${opt_type}" is not valid for curl option "${opt_name}"`);
  throw new Error(`unexpected error applying curl option "${opt_name}"`);
}