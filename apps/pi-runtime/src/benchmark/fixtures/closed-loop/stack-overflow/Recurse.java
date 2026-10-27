package com.example;

public final class Recurse {

    /** Unbounded recursion: the frame count grows by one on every call. */
    static int down(int depth) {
        return down(depth + 1) + depth;
    }
}
