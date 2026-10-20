import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import jdk.jfr.Event;
import jdk.jfr.Label;
import jdk.jfr.Name;
import jdk.jfr.StackTrace;
import jdk.jfr.consumer.RecordedEvent;
import jdk.jfr.consumer.RecordingStream;

/** Disposable local workload; never expose its control endpoints outside a local test network. */
public class Drill {
    @Name("com.example.OrderFailure")
    @Label("Order failure")
    @StackTrace(true)
    static class OrderFailure extends Event {
        String exceptionClass;
        String message;
        String exceptionStack;
        String operation;
    }

    @Name("com.example.MemoryFailure")
    @Label("Memory failure")
    @StackTrace(true)
    static class MemoryFailure extends Event {
        String exceptionClass;
        String message;
        String exceptionStack;
    }

    static volatile boolean healthy = true;
    static volatile boolean stopping;
    static volatile long cpuUntil;
    static volatile double result;
    static final AtomicBoolean cpuActive = new AtomicBoolean();
    static final AtomicBoolean heapActive = new AtomicBoolean();
    static final ArrayBlockingQueue<String> queue = new ArrayBlockingQueue<>(16);
    static final String service = env("SERVICE_NAME", "order-service");
    static final String nodeId = env("NODE_ID", "local-dev");
    static final String containerName = env("CONTAINER_NAME", "order-service-local");
    static final String runLabel = env("RUN_LABEL", "local");
    static boolean senderEnabled;
    static double threshold;
    static long lastCpuEvent;
    static int cpuSeconds;
    static int cpuThreads;

    static String env(String key, String fallback) {
        String value = System.getenv().getOrDefault(key, fallback);
        if (value.isBlank() || value.length() > 256) throw new IllegalArgumentException(key + " must be 1..256 characters");
        return value;
    }

    static int integer(String key, int fallback, int min, int max) {
        int value = Integer.parseInt(env(key, Integer.toString(fallback)));
        if (value < min || value > max) throw new IllegalArgumentException(key + " out of range");
        return value;
    }

    public static void main(String[] args) throws Exception {
        if (Runtime.version().feature() != 17) throw new IllegalStateException("JDK17 required");
        threshold = Double.parseDouble(env("CPU_THRESHOLD", "0.80"));
        if (!Double.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new IllegalArgumentException("CPU_THRESHOLD must be in (0,1]");
        cpuSeconds = integer("CPU_SECONDS", 10, 1, 30);
        cpuThreads = integer("CPU_THREADS", Math.min(4, Runtime.getRuntime().availableProcessors()), 1, 4);
        String enabled = env("SENDER_ENABLED", "true");
        if (!enabled.equals("true") && !enabled.equals("false")) throw new IllegalArgumentException("SENDER_ENABLED must be true or false");
        senderEnabled = Boolean.parseBoolean(enabled);
        Thread sender = senderEnabled ? startSender() : null;

        var stream = new RecordingStream();
        stream.setMaxSize(16 * 1024 * 1024);
        stream.setMaxAge(Duration.ofSeconds(30));
        stream.enable("jdk.CPULoad").withPeriod(Duration.ofSeconds(1));
        stream.enable("jdk.JavaErrorThrow").withStackTrace();
        stream.enable("com.example.OrderFailure").withStackTrace();
        stream.enable("com.example.MemoryFailure").withStackTrace();
        stream.onEvent("com.example.MemoryFailure", event -> {
            var attributes = attributes(event);
            attributes.put("exceptionClass", event.getString("exceptionClass"));
            attributes.put("exceptionMessage", event.getString("message"));
            attributes.put("stackTrace", event.getString("exceptionStack"));
            attributes.put("jfrStackTrace", String.valueOf(event.getStackTrace()));
            publish(event, "jvm.oom", "critical", event.getEventType().getName() + " " + event.getString("exceptionClass") + ": " + event.getString("message"), attributes);
        });
        stream.onEvent("jdk.CPULoad", Drill::consumeCpu);
        stream.onEvent("jdk.JavaErrorThrow", event -> {
            String exceptionClass = event.getClass("thrownClass").getName();
            if (!exceptionClass.equals("java.lang.OutOfMemoryError")) return;
            var attributes = attributes(event);
            attributes.put("exceptionClass", exceptionClass);
            attributes.put("exceptionMessage", event.getString("message"));
            attributes.put("stackTrace", String.valueOf(event.getStackTrace()));
            // Some JVM allocation paths use preallocated OOME and do not emit this event.
            // Keep any native observation, but normalize only the caught custom event to avoid duplicates.
            System.out.println("JFR " + json(attributes));
        });
        stream.onEvent("com.example.OrderFailure", event -> {
            var attributes = attributes(event);
            attributes.put("exceptionClass", event.getString("exceptionClass"));
            attributes.put("exceptionMessage", event.getString("message"));
            attributes.put("stackTrace", event.getString("exceptionStack"));
            attributes.put("jfrStackTrace", String.valueOf(event.getStackTrace()));
            attributes.put("operation", event.getString("operation"));
            publish(event, "business.error", "error", event.getEventType().getName() + " " + event.getString("exceptionClass") + ": " + event.getString("message"), attributes);
        });
        stream.onError(error -> System.err.println("JFR stream failed: " + error.getClass().getSimpleName()));
        stream.startAsync();

        var executor = Executors.newFixedThreadPool(4);
        var server = HttpServer.create(new InetSocketAddress(env("BIND_ADDRESS", "0.0.0.0"), integer("PORT", 8088, 1, 65535)), 16);
        server.setExecutor(executor);
        server.createContext("/", Drill::handle);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            stopping = true;
            healthy = true;
            cpuUntil = 0;
            server.stop(0);
            executor.shutdownNow();
            stream.close();
            if (sender != null) sender.interrupt();
        }, "shutdown"));
        server.start();
        System.out.println("JDK17 ready; RecordingStream active; sender=" + senderEnabled);
    }

    static Thread startSender() {
        // Secrets stay in environment; no URI, request headers or response body is logged.
        URI endpoint = URI.create(env("PI_OPS_ENDPOINT", "http://pi-ops:8080") + "/v1/events");
        String token = System.getenv("PI_OPS_INGEST_TOKEN");
        if (token == null || token.isBlank()) throw new IllegalArgumentException("PI_OPS_INGEST_TOKEN required when sender enabled");
        var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
        var sender = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    String body = queue.take();
                    var request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(5))
                        .header("Content-Type", "application/json").header("Authorization", "Bearer " + token)
                        .POST(HttpRequest.BodyPublishers.ofString(body)).build();
                    var response = client.send(request, HttpResponse.BodyHandlers.discarding());
                    System.out.println("EventBatch HTTP " + response.statusCode());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } catch (Exception e) {
                    System.err.println("EventBatch delivery failed: " + e.getClass().getSimpleName());
                }
            }
        }, "event-sender");
        sender.setDaemon(true);
        sender.start();
        return sender;
    }

    static Map<String, Object> attributes(RecordedEvent event) {
        var attributes = new LinkedHashMap<String, Object>();
        attributes.put("jfrEventName", event.getEventType().getName());
        attributes.put("jfrStartTime", event.getStartTime().toString());
        attributes.put("jfrEndTime", event.getEndTime().toString());
        attributes.put("containerName", containerName);
        attributes.put("runLabel", runLabel);
        return attributes;
    }

    static void consumeCpu(RecordedEvent event) {
        double user = event.getFloat("jvmUser");
        double system = event.getFloat("jvmSystem");
        double machine = event.getFloat("machineTotal");
        var attributes = attributes(event);
        attributes.put("jvmUser", user);
        attributes.put("jvmSystem", system);
        attributes.put("machineTotal", machine);
        System.out.println("JFR " + json(attributes));
        long now = System.nanoTime();
        // Classification depends only on observed samples, never on the control endpoint/state.
        if (user + system < threshold || (lastCpuEvent != 0 && now - lastCpuEvent < Duration.ofSeconds(10).toNanos())) return;
        lastCpuEvent = now;
        publish(event, "jvm.cpu_pressure", "warning", "jdk.CPULoad jvmUser=" + user + " jvmSystem=" + system + " machineTotal=" + machine, attributes);
    }

    static void publish(RecordedEvent event, String type, String severity, String message, Map<String, Object> attributes) {
        var ops = new LinkedHashMap<String, Object>();
        ops.put("schemaVersion", 1);
        ops.put("id", UUID.randomUUID().toString());
        ops.put("time", event.getStartTime().toString());
        ops.put("source", "jfr");
        ops.put("nodeId", nodeId);
        ops.put("service", service);
        ops.put("type", type);
        ops.put("severity", severity);
        ops.put("message", message);
        ops.put("attributes", attributes);
        String batch = "{\"producer\":" + json(Map.of("id", service + "-jfr", "type", "application", "version", "0.2.0")) + ",\"events\":[" + json(ops) + "]}";
        System.out.println("JFR_EVENT " + batch);
        if (senderEnabled && !queue.offer(batch)) System.err.println("Event queue full; dropped event");
    }

    static void handle(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        if (!(path.equals("/health") ? exchange.getRequestMethod().equals("GET") : exchange.getRequestMethod().equals("POST"))) {
            respond(exchange, 405, "method not allowed");
            return;
        }
        switch (path) {
            case "/health" -> respond(exchange, healthy ? 200 : 503, "{\"healthy\":" + healthy + "}");
            case "/fail" -> { healthy = false; System.out.println("Health unavailable"); respond(exchange, 200, "health unavailable"); }
            case "/ok" -> { healthy = true; System.out.println("Health available"); respond(exchange, 200, "health available"); }
            case "/cpu" -> {
                if (!cpuActive.compareAndSet(false, true)) { respond(exchange, 409, "CPU work in progress"); return; }
                cpuUntil = System.nanoTime() + Duration.ofSeconds(cpuSeconds).toNanos();
                new Thread(() -> {
                    var workers = new ArrayList<Thread>();
                    try {
                        for (int i = 0; i < cpuThreads; i++) {
                            var worker = new Thread(() -> {
                                double value = 1;
                                while (!stopping && System.nanoTime() < cpuUntil) value = Math.sin(value) + Math.sqrt(value * value + 1);
                                result = value;
                            }, "compute-" + i);
                            workers.add(worker);
                            worker.start();
                        }
                        for (Thread worker : workers) worker.join();
                    } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    finally { cpuActive.set(false); System.out.println("CPU work completed"); }
                }, "compute").start();
                respond(exchange, 202, "CPU work accepted");
            }
            case "/heap" -> {
                // Prevent accidental host-scale allocation. Use -Xmx64m..256m; cgroup testing is container-only.
                if (Runtime.getRuntime().maxMemory() > 256L * 1024 * 1024) { respond(exchange, 409, "requires -Xmx at most 256m"); return; }
                if (!heapActive.compareAndSet(false, true)) { respond(exchange, 409, "memory work in progress"); return; }
                new Thread(Drill::exhaustHeap, "allocation").start();
                respond(exchange, 202, "memory work accepted");
            }
            case "/order" -> {
                try {
                    processOrder();
                    respond(exchange, 200, "order accepted");
                } catch (IllegalStateException error) {
                    var event = new OrderFailure();
                    event.exceptionClass = error.getClass().getName();
                    event.message = error.getMessage();
                    event.exceptionStack = exceptionStack(error);
                    event.operation = "submitOrder";
                    event.commit();
                    error.printStackTrace(System.err);
                    respond(exchange, 500, "order processing failed");
                }
            }
            case "/exit", "/exit-nonzero" -> {
                int code = path.equals("/exit") ? 0 : 17;
                respond(exchange, 202, "shutdown accepted");
                new Thread(() -> { System.out.println("Process exiting with code " + code); System.exit(code); }, "process-exit").start();
            }
            default -> respond(exchange, 404, "not found");
        }
    }

    static void processOrder() {
        throw new IllegalStateException("Order cannot be fulfilled: inventory unavailable");
    }

    static void exhaustHeap() {
        ArrayList<byte[]> retained = new ArrayList<>();
        byte[] reserve = new byte[1024 * 1024];
        OutOfMemoryError failure = null;
        long deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos();
        try {
            while (!stopping && System.nanoTime() < deadline) {
                byte[] block = new byte[1024 * 1024];
                // Touch actual pages; necessary for a container memory-limit run as well.
                for (int i = 0; i < block.length; i += 4096) block[i] = 1;
                retained.add(block);
            }
        } catch (OutOfMemoryError error) {
            failure = error;
        } finally {
            retained.clear();
            retained = null;
            reserve = null;
            System.gc();
            heapActive.set(false);
        }
        if (failure != null) {
            failure.printStackTrace(System.err);
            // Commit only after a real VM-thrown OOME and memory release. The stream, not this
            // worker, creates the OpsEvent; never instantiate an OutOfMemoryError as a signal.
            var event = new MemoryFailure();
            event.exceptionClass = failure.getClass().getName();
            event.message = failure.getMessage();
            event.exceptionStack = exceptionStack(failure);
            event.commit();
        } else System.err.println("Allocation stopped before memory exhaustion");
        System.out.println("Allocation work completed; retained memory released");
    }

    static String exceptionStack(Throwable error) {
        StringBuilder out = new StringBuilder(error.toString());
        for (StackTraceElement frame : error.getStackTrace()) {
            if (out.length() > 6000) break;
            out.append("\n\tat ").append(frame);
        }
        return out.toString();
    }

    static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var out = exchange.getResponseBody()) { out.write(bytes); }
        finally { exchange.close(); }
    }

    // Small JSON encoder for this fixed EventBatch contract; only JDK classes are used.
    static String json(Object value) {
        if (value == null) return "null";
        if (value instanceof Number || value instanceof Boolean) return value.toString();
        if (value instanceof Map<?, ?> map) {
            var out = new StringBuilder("{");
            for (var entry : map.entrySet()) {
                if (out.length() > 1) out.append(',');
                out.append(json(entry.getKey().toString())).append(':').append(json(entry.getValue()));
            }
            return out.append('}').toString();
        }
        var out = new StringBuilder("\"");
        for (char c : value.toString().toCharArray()) {
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
                }
            }
        }
        return out.append('"').toString();
    }
}
