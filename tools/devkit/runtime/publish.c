#define _GNU_SOURCE
#if !defined(__linux__)
#error Publication requires Linux procfs and renameat2, not a portable rename fallback.
#endif
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/fs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Parent-only v1 protocol: VERSION SOURCE_PIN_COUNT NAME, then PATH DEV INO
 * MODE for fds 3 onward. Two complete /-rooted chains identify staging/output
 * and the destination parent. Roles are derived, never arbitrary fd arguments.
 * The parent owns content validation, trusted ancestors and cancellation. */
static uintmax_t number(const char *text) {
    size_t length = strnlen(text, 21);
    if (!length || length > 20 || (length > 1 && *text == '0')) exit(64);
    uintmax_t value = 0;
    for (size_t i = 0; i < length; ++i) {
        if (text[i] < '0' || text[i] > '9') exit(64);
        unsigned int digit = (unsigned int) (text[i] - '0');
        if (value > (UINTMAX_MAX - digit) / 10) exit(64);
        value = value * 10 + digit;
    }
    return value;
}

static int component(const char *name) {
    size_t length = strnlen(name, NAME_MAX + 1);
    if (!length || length > NAME_MAX || !strcmp(name, ".") || !strcmp(name, "..")) return 0;
    for (size_t i = 0; i < length; ++i) {
        unsigned char c = (unsigned char) name[i];
        if (c < 32 || c == 127 || c == '/' || c == '\\') return 0;
    }
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 20 || (argc - 4) % 4 || (argc - 4) / 4 > 196
        || strcmp(argv[1], "cocos4-publish-v1")) return 64;
    int count = (argc - 4) / 4;
    uintmax_t source_count = number(argv[2]);
    if (source_count < 3 || source_count >= (uintmax_t) count) return 64;
    int split = (int) source_count;
    int from = split + 1, source = split + 2, to = count + 2;
    const char *name = argv[3];
    if (!component(name)) return 64;
    for (int i = 0; i < count; ++i) {
        const char *path = argv[4 + i * 4];
        uintmax_t dev = number(argv[5 + i * 4]);
        uintmax_t ino = number(argv[6 + i * 4]);
        uintmax_t mode = number(argv[7 + i * 4]);
        struct stat opened, linked;
        char proc[64], target[PATH_MAX + 1];
        size_t length = strnlen(path, PATH_MAX);
        if (!length || length >= PATH_MAX || path[0] != '/') return 64;
        if (i == 0 || i == split) {
            if (strcmp(path, "/")) return 64;
        } else {
            const char *parent = argv[4 + (i - 1) * 4];
            size_t prefix = strcmp(parent, "/") ? strlen(parent) : 0;
            if (length <= prefix || strncmp(path, parent, prefix) || path[prefix] != '/'
                || !component(path + prefix + 1)) return 64;
            if (i == split - 1 && strcmp(path + prefix + 1, "output")) return 64;
        }
        if (fstat(i + 3, &opened) || lstat(path, &linked)) return 73;
        if (!S_ISDIR(opened.st_mode) || (uintmax_t) opened.st_dev != dev
            || (uintmax_t) opened.st_ino != ino || (uintmax_t) opened.st_mode != mode
            || (uintmax_t) linked.st_dev != dev || (uintmax_t) linked.st_ino != ino
            || (uintmax_t) linked.st_mode != mode) return 73;
        int written = snprintf(proc, sizeof(proc), "/proc/self/fd/%d", i + 3);
        if (written < 0 || (size_t) written >= sizeof(proc)) return 73;
        ssize_t bytes = readlink(proc, target, PATH_MAX);
        if (bytes < 0 || bytes >= PATH_MAX) return 73;
        target[bytes] = '\0';
        if (strcmp(target, path)) return 73;
    }
    struct stat linked, pinned;
    if (fstatat(from, "output", &linked, AT_SYMLINK_NOFOLLOW) || fstat(source, &pinned)
        || !S_ISDIR(linked.st_mode) || linked.st_dev != pinned.st_dev
        || linked.st_ino != pinned.st_ino || linked.st_mode != pinned.st_mode) return 73;
    /* RENAME_NOREPLACE is one kernel operation. EXDEV/ENOSYS/EINVAL fail closed;
     * neither a copy nor a check-then-rename fallback is safe here. */
    if (syscall(SYS_renameat2, from, "output", to, name, RENAME_NOREPLACE) == 0) return 0;
    return errno == EEXIST || errno == ENOTEMPTY ? 70
        : errno == EACCES || errno == EPERM ? 74 : 72;
}
