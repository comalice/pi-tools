"""Dependency-free synthetic tests: python3 -m unittest -v test_server.py"""

import http.client
import io
import json
import threading
import unittest
from contextlib import redirect_stderr
from http.server import HTTPServer

from server import DIMENSION, MAX_BODY_BYTES, MODEL, QUERY_PREFIX, MemoryService, make_handler


class FakeEngine:
    def __init__(self):
        self.called = None
        self.fail = False
        self.bad_vector = False

    def _embed(self, kind, texts):
        self.called = (kind, list(texts))
        if self.fail:
            raise RuntimeError("synthetic failure containing private input")
        value = float("nan") if self.bad_vector else 0.25
        return [[value] * DIMENSION for _ in texts]

    def query_embed(self, texts):
        return self._embed("query", texts)

    def passage_embed(self, texts):
        return self._embed("passage", texts)


class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = FakeEngine()
        cls.service = MemoryService(cls.engine, "a" * 64)
        cls.stderr = io.StringIO()
        cls.server = HTTPServer(("127.0.0.1", 0), make_handler(cls.service))
        # Capture unexpected server diagnostics while verifying requests are not logged.
        def serve():
            with redirect_stderr(cls.stderr):
                cls.server.serve_forever()
        cls.thread = threading.Thread(target=serve, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def request(self, method="POST", path="/embed", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, payload)
        connection.close()
        return result

    def post_json(self, payload):
        return self.request(
            body=json.dumps(payload),
            headers={"Content-Type": "application/json"},
        )

    def test_health_reports_ready_model_identity(self):
        status, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {
            "status": "ok", "model": MODEL, "revision": "a" * 64,
            "dimension": 384, "max_tokens": 512, "service_version": 1,
        })

    def test_query_and_passage_dispatch_preserve_order(self):
        for kind in ("query", "passage"):
            status, body = self.post_json({"texts": ["first", "second"], "input_type": kind})
            self.assertEqual(status, 200)
            result = json.loads(body)
            expected = [QUERY_PREFIX + text for text in ["first", "second"]] if kind == "query" else ["first", "second"]
            self.assertEqual(self.engine.called, (kind, expected))
            self.assertEqual((result["model"], result["dimension"]), (MODEL, DIMENSION))
            self.assertEqual(result["revision"], "a" * 64)
            self.assertEqual(len(result["vectors"]), 2)
            self.assertTrue(all(len(vector) == DIMENSION for vector in result["vectors"]))

    def test_idle_client_does_not_block_another_request(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request("GET", "/health")
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.getheader("Connection"), "close")
            self.assertEqual(self.request("GET", "/health")[0], 200)
        finally:
            connection.close()

    def test_rejects_bad_method_route_content_type_and_chunked_body(self):
        self.assertEqual(self.request("PUT", "/embed")[0], 405)
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request(body="{}", headers={"Content-Type": "text/plain"})[0], 415)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.putrequest("POST", "/embed")
        connection.putheader("Transfer-Encoding", "chunked")
        connection.putheader("Content-Type", "application/json")
        connection.endheaders()
        response = connection.getresponse()
        response.read()
        self.assertEqual(response.status, 400)
        connection.close()

    def test_rejects_invalid_shapes_types_and_lengths(self):
        invalid = [
            [],
            {"texts": "not an array", "input_type": "query"},
            {"texts": [], "input_type": "query"},
            {"texts": ["x"] * 33, "input_type": "query"},
            {"texts": [""], "input_type": "query"},
            {"texts": ["x" * 8001], "input_type": "query"},
            {"texts": ["x"], "input_type": "other"},
            {"texts": [None], "input_type": "passage"},
        ]
        for payload in invalid:
            with self.subTest(payload=str(payload)[:40]):
                self.assertEqual(self.post_json(payload)[0], 400)
        self.assertEqual(self.request(body="not json", headers={"Content-Type": "application/json"})[0], 400)

    def test_rejects_oversized_content_length_without_reading_body(self):
        status, _ = self.request(
            body=None,
            headers={"Content-Type": "application/json", "Content-Length": str(MAX_BODY_BYTES + 1)},
        )
        self.assertEqual(status, 413)

    def test_nonfinite_model_output_is_generic_500(self):
        self.engine.bad_vector = True
        status, body = self.post_json({"texts": ["synthetic private text"], "input_type": "query"})
        self.engine.bad_vector = False
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body), {"error": "Embedding failed"})

    def test_model_failure_does_not_echo_input_or_log_requests(self):
        self.engine.fail = True
        status, body = self.post_json({"texts": ["synthetic private text"], "input_type": "passage"})
        self.engine.fail = False
        self.assertEqual(status, 500)
        self.assertNotIn(b"synthetic private text", body)
        self.assertNotIn("synthetic private text", self.stderr.getvalue())
        self.assertNotIn("POST /embed", self.stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
