import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import jdk.jfr.consumer.RecordingStream;

/** Disposable local workload, not a replacement for DataAsset's sender. */
public class Drill {
    static volatile boolean healthy = true;
    static volatile long cpuUntil;
    static volatile double result;
    static final AtomicBoolean emitted = new AtomicBoolean();
    static final ArrayBlockingQueue<String> queue = new ArrayBlockingQueue<>(16);

    public static void main(String[] args) throws Exception {
        if (Runtime.version().feature() != 17) throw new IllegalStateException("JDK17 required");
        double threshold = Double.parseDouble(System.getenv().getOrDefault("CPU_THRESHOLD", "0.01"));
        if (!Double.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new IllegalArgumentException("CPU_THRESHOLD must be in (0,1]");
        var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        var sender = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    String body = queue.take();
                    var request = HttpRequest.newBuilder(URI.create(System.getenv("PI_OPS_ENDPOINT") + "/v1/events"))
                        .timeout(Duration.ofSeconds(8))
                        .header("Content-Type", "application/json")
                        .header("Authorization", "Bearer " + System.getenv("PI_OPS_INGEST_TOKEN"))
                        .POST(HttpRequest.BodyPublishers.ofString(body)).build();
                    var response = client.send(request, HttpResponse.BodyHandlers.discarding());
                    System.out.println("EventBatch HTTP " + response.statusCode());
                    // ponytail: disposable drill sends once; production retry stays in DataAsset.
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } catch (Exception e) {
                    System.err.println("EventBatch delivery failed: " + e.getClass().getSimpleName());
                }
            }
        }, "event-sender");
        sender.setDaemon(true);
        sender.start();

        var stream = new RecordingStream();
        stream.enable("jdk.CPULoad").withPeriod(Duration.ofSeconds(1));
        stream.onEvent("jdk.CPULoad", event -> {
            double user = event.getFloat("jvmUser");
            double system = event.getFloat("jvmSystem");
            double machine = event.getFloat("machineTotal");
            if (System.nanoTime() >= cpuUntil || user + system < threshold || !emitted.compareAndSet(false, true)) return;
            String body = String.format(Locale.ROOT, """
                {"producer":{"id":"jdk17-local-drill","type":"application","version":"0.1.0"},"events":[{"schemaVersion":1,"id":"%s","time":"%s","source":"jfr","nodeId":"local-dev","service":"dataasset-jdk17-local-本地演练","type":"jvm.cpu_pressure","severity":"warning","message":"Local drill: observed jdk.CPULoad during bounded CPU burst","attributes":{"jvmUser":%.6f,"jvmSystem":%.6f,"machineTotal":%.6f,"containerName":"pi-ops-jdk17-drill"}}]}
                """, UUID.randomUUID(), Instant.now(), user, system, machine);
            if (!queue.offer(body)) System.err.println("Event queue full");
            System.out.printf(Locale.ROOT, "JFR jdk.CPULoad jvmUser=%.6f jvmSystem=%.6f machineTotal=%.6f%n", user, system, machine);
        });
        stream.startAsync();

        var server = HttpServer.create(new InetSocketAddress(8088), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            if (!path.equals("/health") && !exchange.getRequestMethod().equals("POST")) {
                exchange.sendResponseHeaders(405, -1);
                exchange.close();
                return;
            }
            int status = 200;
            String body;
            switch (path) {
                case "/health" -> { status = healthy ? 200 : 503; body = "{\"healthy\":" + healthy + "}"; }
                case "/fail" -> { healthy = false; body = "local health failure"; System.out.println(body); }
                case "/ok" -> { healthy = true; body = "local health recovered"; System.out.println(body); }
                case "/cpu" -> {
                    if (System.nanoTime() < cpuUntil) { status = 409; body = "CPU burst already running"; }
                    else {
                        emitted.set(false);
                        cpuUntil = System.nanoTime() + Duration.ofSeconds(30).toNanos();
                        for (int i = 0; i < Math.min(4, Runtime.getRuntime().availableProcessors()); i++) {
                            new Thread(() -> {
                                double value = 1;
                                while (System.nanoTime() < cpuUntil) value = Math.sin(value) + Math.sqrt(value * value + 1);
                                result = value;
                            }, "local-cpu-burst").start();
                        }
                        body = "bounded 30s CPU burst";
                        System.out.println(body);
                    }
                }
                default -> { status = 404; body = "not found"; }
            }
            byte[] bytes = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, bytes.length);
            try (var out = exchange.getResponseBody()) { out.write(bytes); }
            exchange.close();
        });
        server.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> { server.stop(0); stream.close(); }));
        System.out.println("JDK17 local drill ready; RecordingStream jdk.CPULoad enabled");
    }
}
