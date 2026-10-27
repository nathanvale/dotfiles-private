"""Local stand-in for the Messages API, so a real Claude turn runs offline.

Usage: claude-mock-messages-api.py PORT_FILE REQUEST_LOG TOOL_COMMAND

The first request that offers tools gets one Bash tool call running
TOOL_COMMAND; every later request gets a final text reply. REQUEST_LOG gets
one line per request naming the tools Claude offered. Claude points at it
through ANTHROPIC_BASE_URL with a placeholder key, so no account is used.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT_FILE, REQUEST_LOG, TOOL_COMMAND = sys.argv[1:]


def events(blocks, stop):
    message = {"id": "msg_mock", "type": "message", "role": "assistant", "model": "claude-mock",
               "content": [], "stop_reason": None, "stop_sequence": None,
               "usage": {"input_tokens": 1, "output_tokens": 1}}
    yield "message_start", {"type": "message_start", "message": message}
    for index, block in enumerate(blocks):
        if block["type"] == "tool_use":
            start = dict(block, input={})
            delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
        else:
            start = {"type": "text", "text": ""}
            delta = {"type": "text_delta", "text": block["text"]}
        yield "content_block_start", {"type": "content_block_start", "index": index, "content_block": start}
        yield "content_block_delta", {"type": "content_block_delta", "index": index, "delta": delta}
        yield "content_block_stop", {"type": "content_block_stop", "index": index}
    yield "message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                            "usage": {"output_tokens": 1}}
    yield "message_stop", {"type": "message_stop"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        with open(REQUEST_LOG, "a") as log:
            log.write(f"POST {self.path} tools={','.join(sorted(t.get('name', '') for t in body.get('tools', [])))}\n")
        if "count_tokens" in self.path:
            return self.reply("application/json", json.dumps({"input_tokens": 1}).encode())
        called = any(isinstance(m.get("content"), list) and any(p.get("type") == "tool_use" for p in m["content"])
                     for m in body.get("messages", []))
        if body.get("tools") and not called:
            blocks = [{"type": "tool_use", "id": "toolu_mock", "name": "Bash",
                       "input": {"command": TOOL_COMMAND, "description": "canary"}}]
            stop = "tool_use"
        else:
            blocks, stop = [{"type": "text", "text": "mock done"}], "end_turn"
        if body.get("stream"):
            data = "".join(f"event: {name}\ndata: {json.dumps(value)}\n\n" for name, value in events(blocks, stop))
            return self.reply("text/event-stream", data.encode())
        message = {"id": "msg_mock", "type": "message", "role": "assistant", "model": "claude-mock",
                   "content": blocks, "stop_reason": stop, "stop_sequence": None,
                   "usage": {"input_tokens": 1, "output_tokens": 1}}
        self.reply("application/json", json.dumps(message).encode())

    def do_GET(self):
        self.reply("application/json", b"{}")

    def reply(self, content_type, data):
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(PORT_FILE, "w") as port_file:
    port_file.write(str(server.server_port))
server.serve_forever()
