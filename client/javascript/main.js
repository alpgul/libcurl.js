/*
ading2210/libcurl.js - A port of libcurl to WASM for the browser.
Copyright (C) 2024 ading2210
Licensed under the GNU LGPL v3. See https://github.com/ading2210/libcurl.js
*/

//everything is wrapped in a function to prevent emscripten from polluting the global scope
const libcurl = (function() {

//emscripten compiled code is inserted here
/* __emscripten_output__ */

//extra client code goes here
/* __extra_libraries__ */

var websocket_url = null;
var wasm_ready = false;
var version_dict = null;
var api = null;
var main_session = null;
const libcurl_version = "__library_version__";
const wisp_version = "__wisp_version__";

function check_loaded(check_websocket) {
  if (!wasm_ready) {
    throw new Error("wasm not loaded yet, please call libcurl.load_wasm first");
  }
  if (!websocket_url && check_websocket) {
    throw new Error("websocket proxy url not set, please call libcurl.set_websocket");
  }
}
function set_websocket_url(url) {
  websocket_url = url;
  if (!main_session && wasm_ready) {
    setup_main_session();
  }
}

//the browser TLS impersonation profile used for new requests
//set to a browser string (e.g. "chrome146", "chrome136", "safari_17_0")
//or null/falsy to disable impersonation entirely
var impersonate_profile = "chrome146";

function set_impersonate_profile(profile) {
  impersonate_profile = profile;
  if (profile) {
    c_func(_set_impersonate_profile, [profile]);
  }
  else {
    c_func(_set_impersonate_profile, [""]);
  }
}

function get_version() {
  if (!wasm_ready) return null;
  if (version_dict) return version_dict;

  let version_ptr = _get_version();
  let version_str = UTF8ToString(version_ptr);
  _free(version_ptr);
  version_dict = JSON.parse(version_str);
  version_dict.lib = libcurl_version;
  version_dict.wisp = wisp_version;
  return version_dict;
}

function get_cacert() {
  return UTF8ToString(_get_cacert());
}

function setup_main_session() {
  main_session = new HTTPSession();
  api.fetch = main_session.fetch.bind(main_session);
}

function main() {
  wasm_ready = true;
  _init_curl();
  set_impersonate_profile(impersonate_profile);

  if (!main_session && websocket_url) {
    setup_main_session();
  }

  let load_event = new Event("libcurl_load");
  api.events.dispatchEvent(load_event);
  api.onload();
  if (ENVIRONMENT_IS_WEB) {
    document.dispatchEvent(load_event);
  }
}

function abort_callback(reason) {
  let abort_event = new CustomEvent("libcurl_abort", {detail: reason});
  api.events.dispatchEvent(abort_event);
  if (ENVIRONMENT_IS_WEB) {
    document.dispatchEvent(abort_event);
  }
}

function load_wasm(url) {
  if (wasm_ready) return;

  //skip this if we are running in single file mode
  if (!wasmBinaryFile || !isDataURI(wasmBinaryFile)) {
    wasmBinaryFile = url;
    createWasm();
    run();  
  }

  return new Promise((resolve, reject) => {
    if (wasm_ready) return resolve();
    api.events.addEventListener("libcurl_load", () => {
      resolve();
    }, {once: true});
    api.events.addEventListener("libcurl_abort", (event) => {
      reject(event.detail);
    }, {once: true});
  });
}

Module.onRuntimeInitialized = main;
Module.onAbort = abort_callback;

api = {
  set_websocket: set_websocket_url,
  load_wasm: load_wasm,
  get_cacert: get_cacert,
  get_error_string: get_error_str,

  wisp: {
    wisp_connections: _wisp_connections,
    WispConnection: WispConnection,
    WispWebSocket: WispWebSocket  
  },

  transport: "wisp",

  WebSocket: FakeWebSocket,
  CurlWebSocket: CurlWebSocket,
  TLSSocket: TLSSocket,
  HTTPSession: HTTPSession,
  set_curl_option: set_curl_option,
  fetch() {
    check_loaded(true);
    throw new Error("not ready")
  },
  
  get copyright() {return copyright_notice},
  get version() {return get_version()},
  get ready() {return wasm_ready},
  get websocket_url() {return websocket_url},

  get impersonate() {return impersonate_profile},
  set impersonate(profile) {set_impersonate_profile(profile)},

  get stdout() {return out},
  set stdout(callback) {out = callback},
  get stderr() {return err},
  set stderr(callback) {err = callback},
  get logger() {return logger},
  set logger(func) {logger = func},

  onload() {},
  events: new EventTarget()
};

return api;

})()