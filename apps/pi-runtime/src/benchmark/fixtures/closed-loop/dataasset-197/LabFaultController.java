package com.mbkj.dap.lab;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;

/**
 * Explicit lab-only HTTP faults. Production advice, telemetry and the JFR
 * recorder stay untouched: each route throws a real JVM failure and lets the
 * running application handle it exactly as it handles any other.
 */
@RestController
@Profile("real-dataasset-lab")
@ConditionalOnProperty(prefix = "lab.fault", name = "enabled", havingValue = "true", matchIfMissing = false)
public final class LabFaultController {

    private static final int ALLOCATION_BLOCK_BYTES = 8 * 1024 * 1024;

    @GetMapping("/auth/lab/server-fault")
    public void serverFault() {
        throw new IllegalStateException("Real DataAsset lab fault injection");
    }

    /**
     * Real heap exhaustion. The blocks are released before rethrowing so the JVM
     * survives and stays available for the remaining checks.
     */
    @GetMapping("/auth/lab/heap-oom")
    public void heapOom() {
        List<byte[]> blocks = new ArrayList<>();
        try {
            while (true) {
                blocks.add(new byte[ALLOCATION_BLOCK_BYTES]);
            }
        } catch (OutOfMemoryError exhausted) {
            blocks.clear();
            throw exhausted;
        }
    }

    /** Real stack exhaustion from unbounded recursion. */
    @GetMapping("/auth/lab/stack-overflow")
    public void stackOverflow() {
        recurse(0);
    }

    private int recurse(int depth) {
        return recurse(depth + 1) + depth;
    }
}
