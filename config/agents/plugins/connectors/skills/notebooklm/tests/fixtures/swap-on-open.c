// Test-only interposer for the packaged executable (DYLD_INSERT_LIBRARIES).
// On the first non-following, non-blocking open of a path ending in
// SWAP_TRIGGER, it renames SWAP_DIR aside and puts a symlink to SWAP_TARGET in
// its place, then performs the open. This lands a directory swap exactly
// between the executable's path check and its open, deterministically.
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern int openat_nocancel(int, const char *, int, ...) __asm("_openat$NOCANCEL");

static int swapped = 0;

static int ends_with(const char *value, const char *suffix) {
	size_t a = strlen(value), b = strlen(suffix);
	return a >= b && strcmp(value + a - b, suffix) == 0;
}

static int swap_open(int dir, const char *file, int flags, ...) {
	va_list args;
	va_start(args, flags);
	int mode = va_arg(args, int);
	va_end(args);
	const char *trigger = getenv("SWAP_TRIGGER"), *target = getenv("SWAP_DIR"), *outside = getenv("SWAP_TARGET");
	if (!swapped && trigger && target && outside && file && (flags & O_NOFOLLOW) && (flags & O_NONBLOCK) && ends_with(file, trigger)) {
		char aside[4096];
		snprintf(aside, sizeof aside, "%s.aside", target);
		swapped = rename(target, aside) == 0 && symlink(outside, target) == 0;
		char note[64];
		int length = snprintf(note, sizeof note, "SWAP_DONE=%d\n", swapped);
		const char *log = getenv("SWAP_LOG");
		if (log) {
			int fd = openat_nocancel(AT_FDCWD, log, O_WRONLY | O_CREAT | O_APPEND, 0600);
			if (fd >= 0) { write(fd, note, (size_t)length); close(fd); }
		}
	}
	return openat_nocancel(dir, file, flags, mode);
}

__attribute__((used)) static struct { const void *replacement; const void *replacee; } interpose_openat
	__attribute__((section("__DATA,__interpose"))) = { (const void *)(unsigned long)&swap_open, (const void *)(unsigned long)&openat_nocancel };
