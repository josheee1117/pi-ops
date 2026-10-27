#!/usr/bin/env python3
"""Real JDK17 component check, isolated loopback receiver; no Docker/Pi-Ops/model calls."""
import datetime
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request

HOME = Path(__file__).resolve().parent
JDK = Path(os.environ.get("JAVA_HOME", "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home"))
RUN = HOME / ".checks" / datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
RUN.mkdir(parents=True)
BATCHES = []
LOCK = threading.Lock()
GROUND = {"jdk": str(JDK), "actions": [], "workloads": []}


class Receiver(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        assert self.path == "/v1/events"
        assert self.headers.get("Authorization") == "Bearer local-check-token"
        batch = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with LOCK:
            BATCHES.append(batch)
        self.send_response(202)
        self.end_headers()

    def log_message(self, *_):
        pass


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait(predicate, label, timeout=25):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(0.1)
    raise AssertionError("timeout: " + label)


def request(address, path, method="POST"):
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        with urllib.request.urlopen(urllib.request.Request(address + path, method=method), timeout=3) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    if method == "POST":
        GROUND["actions"].append({"address": address, "path": path, "startedAt": started, "status": status})
    return status


def events_in(log):
    return [json.loads(line[len("JFR_EVENT "):])["events"][0]
            for line in log.read_text().split("\n")[:-1] if line.startswith("JFR_EVENT ")]


def validate(batch):
    producer = batch["producer"]
    assert producer == {"id": 'order-"service-jfr', "type": "application", "version": "0.2.0"}
    assert 1 <= len(batch["events"]) <= 1000
    for event in batch["events"]:
        assert event["schemaVersion"] == 1
        assert event["id"] and event["source"] == "jfr"
        assert event["nodeId"] == "check-node" and event["service"] == 'order-"service'
        assert event["severity"] in {"warning", "error", "critical"}
        attributes = event["attributes"]
        assert attributes["containerName"] == "check-container"
        assert attributes["runLabel"] == "check\\label"
        assert event["time"] == attributes["jfrStartTime"]
        assert datetime.datetime.fromisoformat(event["time"].replace("Z", "+00:00"))
        assert attributes["jfrEventName"] in {"jdk.CPULoad", "com.example.MemoryFailure", "com.example.OrderFailure"}
        # Neutral facts; no expected-root-cause annotations in wire messages/identity.
        assert not any(word in event["message"].lower() for word in ("injected", "burst", "drill"))


class App:
    def __init__(self, name, sending, threshold):
        self.log = RUN / (name + ".log")
        self.address = "http://127.0.0.1:" + str(port())
        # Do not inherit any ambient Pi-Ops secret or JVM option.
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("PI_OPS_") and key not in
                       {"JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"}}
        environment.update(SENDER_ENABLED=str(sending).lower(), PORT=self.address.rsplit(":", 1)[1],
                           BIND_ADDRESS="127.0.0.1", SERVICE_NAME='order-"service', NODE_ID="check-node",
                           CONTAINER_NAME="check-container", RUN_LABEL="check\\label", CPU_SECONDS="4",
                           CPU_THREADS="1", CPU_THRESHOLD=str(threshold),
                           PI_OPS_ENDPOINT="http://127.0.0.1:" + str(receiver.server_port))
        if sending:
            environment["PI_OPS_INGEST_TOKEN"] = "local-check-token"
        GROUND["workloads"].append({"name": name, "address": self.address, "sender": sending,
                                    "cpuThreshold": threshold, "cpuThreads": 1, "cpuSeconds": 4,
                                    "jvmOptions": ["-Xms32m", "-Xmx64m", "-XX:ActiveProcessorCount=2"]})
        self.output = self.log.open("w")
        self.process = subprocess.Popen([str(JDK / "bin/java"), "-Xms32m", "-Xmx64m",
                                         "-XX:ActiveProcessorCount=2", "--add-modules", "jdk.httpserver,jdk.jfr",
                                         "-cp", str(RUN), "Drill"], env=environment,
                                        stdout=self.output, stderr=subprocess.STDOUT)

    def ready(self):
        def available():
            if self.process.poll() is not None:
                raise AssertionError("application exited: " + self.log.read_text())
            try:
                return request(self.address, "/health", "GET") == 200
            except OSError:
                return False
        wait(available, "HTTP ready")
        wait(lambda: '"jfrEventName":"jdk.CPULoad"' in self.log.read_text(), "RecordingStream ready")

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.output.close()


receiver = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
thread = threading.Thread(target=receiver.serve_forever, daemon=True)
thread.start()
apps = []
try:
    version = subprocess.run([str(JDK / "bin/java"), "-version"], check=True, text=True, capture_output=True)
    (RUN / "jdk-version.txt").write_text(version.stderr)
    assert 'version "17.' in version.stderr
    subprocess.run([str(JDK / "bin/javac"), "--add-modules", "jdk.httpserver,jdk.jfr", "-Xlint:all",
                    "-d", str(RUN), str(HOME / "Drill.java")], check=True)
    print("PASS real JDK17 compile")
    for sending in (True, False):
        app = App("sender-on" if sending else "sender-off", sending, 0.20)
        apps.append(app)
        app.ready()
        before = len(BATCHES)
        assert request(app.address, "/order", "GET") == 405
        assert request(app.address, "/order") == 500
        assert request(app.address, "/health", "GET") == 200
        wait(lambda: any(e["type"] == "business.error" for e in events_in(app.log)), "committed custom JFR consumed")
        business = next(e for e in events_in(app.log) if e["type"] == "business.error")
        assert business["attributes"]["exceptionClass"] == "java.lang.IllegalStateException"
        assert "processOrder" in business["attributes"]["stackTrace"]
        assert "Order cannot be fulfilled" in app.log.read_text()
        cpu_started = datetime.datetime.now(datetime.timezone.utc)
        assert request(app.address, "/cpu") == 202
        assert request(app.address, "/cpu") == 409
        def workload_cpu_events():
            return [e for e in events_in(app.log) if e["type"] == "jvm.cpu_pressure" and
                    datetime.datetime.fromisoformat(e["time"].replace("Z", "+00:00")) >= cpu_started]
        wait(lambda: bool(workload_cpu_events()), "actual CPULoad after work started")
        wait(lambda: "CPU work completed" in app.log.read_text(), "bounded CPU completion")
        cpu = workload_cpu_events()[0]
        assert cpu["attributes"]["jvmUser"] + cpu["attributes"]["jvmSystem"] >= 0.20
        for key in ("jvmUser", "jvmSystem", "machineTotal"):
            assert 0 <= cpu["attributes"][key] <= 1
        assert request(app.address, "/heap") == 202
        wait(lambda: "retained memory released" in app.log.read_text(), "heap memory release")
        wait(lambda: any(e["type"] == "jvm.oom" for e in events_in(app.log)), "actual OOME JFR")
        oom = next(e for e in events_in(app.log) if e["type"] == "jvm.oom")
        assert oom["attributes"]["jfrEventName"] == "com.example.MemoryFailure"
        assert oom["attributes"]["exceptionClass"] == "java.lang.OutOfMemoryError"
        assert oom["attributes"]["exceptionMessage"] == "Java heap space"
        assert "exhaustHeap" in oom["attributes"]["stackTrace"]
        for _ in range(10):
            assert request(app.address, "/health", "GET") == 200
            time.sleep(0.3)
        assert request(app.address, "/order") == 500  # still handles real requests after OOM
        assert request(app.address, "/health", "GET") == 200
        assert request(app.address, "/fail") == 200
        assert request(app.address, "/health", "GET") == 503
        assert request(app.address, "/ok") == 200
        assert request(app.address, "/health", "GET") == 200
        if sending:
            wait(lambda: {"business.error", "jvm.cpu_pressure", "jvm.oom"} <=
                 {e["type"] for b in BATCHES[before:] for e in b["events"]}, "HTTP EventBatch delivery")
            for batch in BATCHES[before:]:
                validate(batch)
            assert request(app.address, "/exit") == 202
            assert app.process.wait(timeout=10) == 0
        else:
            time.sleep(2)
            assert len(BATCHES) == before, "disabled sender performed HTTP"
            assert request(app.address, "/exit-nonzero") == 202
            assert app.process.wait(timeout=10) == 17
        app.stop()
        print("PASS", "sender-on" if sending else "sender-off", "actual CPU/custom JFR/heap OOME; health 200; 503->200; exit", 0 if sending else 17)

    app = App("below-threshold", True, 1.0)
    apps.append(app)
    app.ready()
    before = len(BATCHES)
    assert request(app.address, "/cpu") == 202
    wait(lambda: "CPU work completed" in app.log.read_text(), "low CPU completion")
    time.sleep(3)
    samples = [json.loads(line[4:]) for line in app.log.read_text().split("\n")[:-1] if line.startswith("JFR ")]
    assert samples and all(s["jvmUser"] + s["jvmSystem"] < 1.0 for s in samples)
    assert not any(e["type"] == "jvm.cpu_pressure" for e in events_in(app.log))
    assert not any(e["type"] == "jvm.cpu_pressure" for b in BATCHES[before:] for e in b["events"])
    assert request(app.address, "/health", "GET") == 200
    assert request(app.address, "/exit") == 202
    assert app.process.wait(timeout=10) == 0
    app.stop()
    print("PASS below-threshold actual CPULoad with detector enabled; no pressure event")
finally:
    for app in apps:
        app.stop()
    receiver.shutdown()
    receiver.server_close()
    (RUN / "received-batches.json").write_text(json.dumps(BATCHES, indent=2))
    (RUN / "ground-truth.json").write_text(json.dumps(GROUND, indent=2))
    print("Evidence:", RUN)
