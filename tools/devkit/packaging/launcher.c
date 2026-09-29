#if !defined(__linux__) || !defined(__x86_64__)
#error This launcher is only for the verified Linux x64 distribution.
#endif
#include <asm/unistd.h>

/* No libc or ELF interpreter: LD_PRELOAD cannot execute before environment
 * filtering. This is a fixed Linux x64 exec launcher, not a general shell. */
static long call3(long number, long a, long b, long c) {
    long result;
    __asm__ volatile ("syscall" : "=a" (result) : "a" (number), "D" (a), "S" (b), "d" (c)
        : "rcx", "r11", "memory");
    return result;
}

static int prefix(const char *text, const char *start) {
    while (*start) if (*text++ != *start++) return 0;
    return 1;
}

__attribute__((noreturn)) void launch(long *stack) {
    long argc = *stack;
    char **argv = (char **) (stack + 1);
    char **env = argv + argc + 1;
    char root[4097], node[4130], entry[4130];
    long length = call3(__NR_readlink, (long) "/proc/self/exe", (long) root, 4096);
    if (argc > 0 && argc < 32768 && length > 0 && length < 4096) {
        while (length && root[length - 1] != '/') --length;
        if (length) {
            for (long i = 0; i < length; ++i) node[i] = entry[i] = root[i];
            const char *a = "runtime/node", *b = "app/launch.mjs";
            long i = length;
            do { node[i++] = *a; } while (*a++);
            i = length;
            do { entry[i++] = *b; } while (*b++);
            char *args[argc + 3];
            args[0] = node;
            args[1] = "--no-global-search-paths";
            args[2] = entry;
            for (i = 1; i < argc; ++i) args[i + 2] = argv[i];
            args[argc + 2] = 0;
            const char *deny[] = { "NODE_", "LD_", "DYLD_", "BUN_", "npm_", "NPM_", "OPENSSL_", "SSLKEYLOGFILE=", 0 };
            long kept = 0;
            for (i = 0; env[i]; ++i) {
                int blocked = 0;
                for (long j = 0; deny[j]; ++j) if (prefix(env[i], deny[j])) blocked = 1;
                if (!blocked) env[kept++] = env[i];
            }
            env[kept] = 0;
            call3(__NR_execve, (long) node, (long) args, (long) env);
        }
    }
    const char error[] = "cocos4: bundled Node could not start; verify this Linux x64 package and host libraries.\n";
    call3(__NR_write, 2, (long) error, sizeof(error) - 1);
    call3(__NR_exit, 72, 0, 0);
    __builtin_unreachable();
}

__asm__(".global _start\n_start:\nmov %rsp,%rdi\nand $-16,%rsp\ncall launch\n");
