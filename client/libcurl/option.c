#include <stdlib.h>
#include <string.h>

#include "curl/curl.h"

#include "types.h"
#include "util.h"

//typed JS->C bridge for per-request curl options (see set_curl_option in
//javascript/session.js). Only options on this allowlist can be set: scalars
//(long) and strings (curl copies them synchronously) or a header-list (curl
//copies each line into the list). Anything that needs a raw pointer, a
//callback, or a memory buffer that must outlive the call is deliberately not
//exported — the JSON params mapping in http.c stays the canonical surface.

enum opt_type { OPT_LONG = 1, OPT_STRING = 2, OPT_HEADER_LIST = 3 };

struct allowed_opt {
  const char* name;
  CURLoption opt;
  enum opt_type type;
};

static const struct allowed_opt g_allowed_opts[] = {
  //long options
  { "CURLOPT_TIMEOUT",              CURLOPT_TIMEOUT,              OPT_LONG },
  { "CURLOPT_CONNECTTIMEOUT",       CURLOPT_CONNECTTIMEOUT,       OPT_LONG },
  { "CURLOPT_LOW_SPEED_LIMIT",      CURLOPT_LOW_SPEED_LIMIT,      OPT_LONG },
  { "CURLOPT_LOW_SPEED_TIME",       CURLOPT_LOW_SPEED_TIME,       OPT_LONG },
  { "CURLOPT_MAXREDIRS",            CURLOPT_MAXREDIRS,            OPT_LONG },
  { "CURLOPT_FOLLOWLOCATION",       CURLOPT_FOLLOWLOCATION,       OPT_LONG },
  { "CURLOPT_AUTOREFERER",          CURLOPT_AUTOREFERER,          OPT_LONG },
  { "CURLOPT_BUFFERSIZE",           CURLOPT_BUFFERSIZE,           OPT_LONG },
  { "CURLOPT_RESUME_FROM",          CURLOPT_RESUME_FROM,          OPT_LONG },
  { "CURLOPT_MAXFILESIZE",          CURLOPT_MAXFILESIZE,          OPT_LONG },
  { "CURLOPT_HTTP_VERSION",         CURLOPT_HTTP_VERSION,         OPT_LONG },
  { "CURLOPT_TCP_NODELAY",          CURLOPT_TCP_NODELAY,          OPT_LONG },
  //string options (copied by curl at setopt time)
  { "CURLOPT_USERAGENT",            CURLOPT_USERAGENT,            OPT_STRING },
  { "CURLOPT_REFERER",              CURLOPT_REFERER,              OPT_STRING },
  { "CURLOPT_RANGE",                CURLOPT_RANGE,                OPT_STRING },
  { "CURLOPT_CUSTOMREQUEST",        CURLOPT_CUSTOMREQUEST,        OPT_STRING },
  { "CURLOPT_ACCEPT_ENCODING",      CURLOPT_ACCEPT_ENCODING,      OPT_STRING },
  { "CURLOPT_COOKIE",               CURLOPT_COOKIE,               OPT_STRING },
  { "CURLOPT_USERNAME",             CURLOPT_USERNAME,             OPT_STRING },
  { "CURLOPT_PASSWORD",             CURLOPT_PASSWORD,             OPT_STRING },
  //header-list option (each newline-separated "Name: value" line is appended
  //to the request's header list)
  { "CURLOPT_HTTPHEADER_APPEND",    CURLOPT_HTTPHEADER,           OPT_HEADER_LIST },
};

//returns:
//  1  option applied
//  0  option is not on the allowlist
// -1  invalid arguments (null opt/type/value, or missing request info)
// -2  invalid numeric value for a "long" option
// -3  the given type does not match the allowlisted option
int set_request_option(CURL* http_handle, const char* opt_name, const char* opt_type, const char* value) {
  if (!http_handle || !opt_name || !opt_type || !value) return -1;

  const struct allowed_opt* allowed = NULL;
  size_t n_opts = sizeof(g_allowed_opts) / sizeof(g_allowed_opts[0]);
  for (size_t i = 0; i < n_opts; i++) {
    if (strcmp(g_allowed_opts[i].name, opt_name) == 0) {
      allowed = &g_allowed_opts[i];
      break;
    }
  }
  if (!allowed) return 0;

  if (strcmp(opt_type, "long") == 0 && allowed->type == OPT_LONG) {
    char* end = NULL;
    long parsed = strtol(value, &end, 10);
    if (end == value || *end != '\0') return -2;
    curl_easy_setopt(http_handle, allowed->opt, parsed);
    return 1;
  }

  if (strcmp(opt_type, "string") == 0 && allowed->type == OPT_STRING) {
    curl_easy_setopt(http_handle, allowed->opt, value);
    return 1;
  }

  if (strcmp(opt_type, "header-list") == 0 && allowed->type == OPT_HEADER_LIST) {
    struct RequestInfo *request_info = get_request_info(http_handle);
    if (!request_info) return -1;

    char* copy = strdup(value);
    size_t len = strlen(copy);
    size_t start = 0;
    for (size_t i = 0; i <= len; i++) {
      if (copy[i] != '\n' && copy[i] != '\0') continue;
      size_t line_len = i - start;
      while (line_len > 0 && copy[start + line_len - 1] == '\r') line_len--;
      if (line_len > 0) {
        char saved = copy[start + line_len];
        copy[start + line_len] = '\0';
        request_info->headers_list = curl_slist_append(request_info->headers_list, copy + start);
        copy[start + line_len] = saved;
      }
      start = i + 1;
    }
    free(copy);

    if (request_info->headers_list != NULL) {
      curl_easy_setopt(http_handle, allowed->opt, request_info->headers_list);
    }
    return 1;
  }

  return -3;
}