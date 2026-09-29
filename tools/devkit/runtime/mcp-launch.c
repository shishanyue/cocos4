#if !defined(__linux__) || !defined(__x86_64__)
#error This launcher is only for the verified Linux x64 distribution.
#endif
#include <asm/unistd.h>

/* No libc, ELF interpreter or inherited environment access. The trusted kit
 * supplies Node/CLI paths; only this fixed MCP invocation can be constructed. */
static long call3(long number, long a, long b, long c) {
    long result;
    __asm__ volatile ("syscall" : "=a" (result) : "a" (number), "D" (a), "S" (b), "d" (c)
        : "rcx", "r11", "memory");
    return result;
}

static int equal(const char *a, const char *b) {
    while (*a && *a == *b) { ++a; ++b; }
    return *a == *b;
}

static int absolute(const char *text) {
    if (*text != '/') return 0;
    long part = 1, length = 0;
    for (; text[length]; ++length) {
        unsigned char ch = (unsigned char) text[length];
        if (length >= 4096 || ch < 32 || ch == 127 || ch == '*' || ch == '?' || ch == '[' || ch == ']'
            || ch == '{' || ch == '}' || ch == '\\') return 0;
        if (length && ch == '/') {
            if (part == length || (length - part == 1 && text[part] == '.')
                || (length - part == 2 && text[part] == '.' && text[part + 1] == '.')) return 0;
            part = length + 1;
        }
    }
    return length == 1 || (part < length && !(length - part == 1 && text[part] == '.')
        && !(length - part == 2 && text[part] == '.' && text[part + 1] == '.'));
}

static void join(char *out, const char *prefix, const char *session, const char *suffix) {
    while (*prefix) *out++ = *prefix++;
    while (*session) *out++ = *session++;
    while (*suffix) *out++ = *suffix++;
    *out = 0;
}

__attribute__((noreturn)) void launch(long *stack) {
    long argc = *stack;
    char **argv = (char **) (stack + 1);
    int valid = argc == 18;
    if (valid) {
        const char *keys[] = { "--node", "--cli", "--session", "--sdk-root", "--workspace", "--state-root", "--mode", "--preview" };
        valid = equal(argv[1], "cocos4-mcp-launch-v1");
        for (long i = 0; i < 8; ++i) if (!equal(argv[2 + i * 2], keys[i])) valid = 0;
        for (long i = 0; i < 6; ++i) if (!absolute(argv[3 + i * 2])) valid = 0;
        if (!equal(argv[15], "read-only") && !equal(argv[15], "develop")) valid = 0;
        if (!equal(argv[17], "false") && !(equal(argv[15], "develop") && equal(argv[17], "true"))) valid = 0;
    }
    if (!valid) {
        const char error[] = "cocos4: invalid fixed MCP launch arguments.\n";
        call3(__NR_write, 2, (long) error, sizeof(error) - 1);
        call3(__NR_exit, 64, 0, 0);
        __builtin_unreachable();
    }
    char home[4120], temporary[4120];
    join(home, "HOME=", argv[7], "/mcp-home");
    join(temporary, "TMPDIR=", argv[7], "/tmp");
    char *env[] = { "PATH=", home, temporary, "LANG=C.UTF-8", "LC_ALL=C.UTF-8", 0 };
    char *args[] = { argv[3], "--no-global-search-paths", argv[5], "mcp", "--sdk-root", argv[9],
        "--workspace", argv[11], "--state-root", argv[13], "--mode", argv[15], "--preview", argv[17], 0 };
    call3(__NR_execve, (long) argv[3], (long) args, (long) env);
    const char error[] = "cocos4: trusted MCP Node could not start; verify the complete Linux x64 kit.\n";
    call3(__NR_write, 2, (long) error, sizeof(error) - 1);
    call3(__NR_exit, 72, 0, 0);
    __builtin_unreachable();
}

__asm__(".global _start\n_start:\nmov %rsp,%rdi\nand $-16,%rsp\ncall launch\n");
