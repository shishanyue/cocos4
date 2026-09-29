#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Linux host tool, not an engine backend. fd 3: owner control (G=start,
 * T=stop, EOF=owner loss); fd 4: bounded NDJSON observations; fd 5: runner
 * Node IPC, never retained by a supervisor. No shell or PATH lookup.
 * Two nested subreapers cover loss of either supervisor, including SIGKILL.
 * This is lifetime management for trusted code, NOT hostile-code isolation.
 */
static volatile sig_atomic_t stopping;
static pid_t protected_guard;
static void stop_signal(int sig) { (void)sig; stopping = 1; }
static long long milliseconds(void) {
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC, &time)) _exit(125);
    return (long long)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}
static void nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) _exit(125);
}
static int setup(pid_t parent) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = stop_signal;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)
        || sigaction(SIGHUP, &action, NULL)) return -1;
    signal(SIGPIPE, SIG_IGN);
    if (prctl(PR_SET_CHILD_SUBREAPER, 1) || prctl(PR_SET_PDEATHSIG, SIGTERM)) return -1;
    if (getppid() != parent) stopping = 1;
    int pidfd = (int)syscall(SYS_pidfd_open, getpid(), 0);
    if (pidfd < 0) return -1;
    close(pidfd);
    return 0;
}
static int identity(pid_t pid, pid_t *parent, unsigned long long *start) {
    char name[80], text[4096];
    snprintf(name, sizeof(name), "/proc/%ld/stat", (long)pid);
    int fd = open(name, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t length = read(fd, text, sizeof(text) - 1);
    close(fd);
    if (length <= 0) return -1;
    text[length] = 0;
    char *rest = strrchr(text, ')');
    if (!rest || rest[1] != ' ' || !rest[2] || rest[3] != ' ') return -1;
    rest += 4;
    for (int field = 4; field <= 22; field++) {
        char *end;
        unsigned long long value = strtoull(rest, &end, 10);
        if (end == rest) return -1;
        if (field == 4) *parent = (pid_t)value;
        if (field == 22) *start = value;
        rest = end;
        while (*rest == ' ') rest++;
    }
    return 0;
}
static void event(const char *text) {
    /* Observations must never backpressure process cleanup. Missing observations
     * fail the caller closed; they do not prevent reaping or signal delivery. */
    ssize_t ignored = write(4, text, strlen(text));
    (void)ignored;
}
static void exit_event(int status) {
    char text[160];
    if (WIFEXITED(status)) snprintf(text, sizeof(text), "{\"type\":\"runner_exit\",\"exitCode\":%d,\"signal\":null}\n", WEXITSTATUS(status));
    else snprintf(text, sizeof(text), "{\"type\":\"runner_exit\",\"exitCode\":null,\"signal\":%d}\n", WTERMSIG(status));
    event(text);
}

/* Enumerate all threads' children, not only the main thread. Pin each target
 * with pidfd and recheck parentage before signalling, so PID reuse is harmless.
 * Repeated walks plus subreaper adoption cover setsid/double-fork descendants.
 */
static void signal_descendants(pid_t parent, int sig, int depth, int *budget) {
    if (depth > 64 || *budget <= 0) return;
    char directory[80];
    snprintf(directory, sizeof(directory), "/proc/%ld/task", (long)parent);
    DIR *tasks = opendir(directory);
    if (!tasks) return;
    struct dirent *entry;
    while ((entry = readdir(tasks)) != NULL && *budget > 0) {
        char *end;
        long tid = strtol(entry->d_name, &end, 10);
        if (*end || tid <= 0) continue;
        char name[120];
        snprintf(name, sizeof(name), "/proc/%ld/task/%ld/children", (long)parent, tid);
        FILE *children = fopen(name, "re");
        if (!children) continue;
        long child;
        while (*budget > 0 && fscanf(children, "%ld", &child) == 1) {
            if (child <= 0 || child == (long)getpid()) continue;
            --*budget;
            int fd = (int)syscall(SYS_pidfd_open, (pid_t)child, 0);
            if (fd < 0) continue;
            pid_t ppid = 0;
            unsigned long long start = 0;
            if (identity((pid_t)child, &ppid, &start) == 0 && ppid == parent) {
                signal_descendants((pid_t)child, sig, depth + 1, budget);
                if ((pid_t)child != protected_guard) syscall(SYS_pidfd_send_signal, fd, sig, NULL, 0);
            }
            close(fd);
        }
        fclose(children);
    }
    closedir(tasks);
}
static void sweep(int sig) {
    int budget = 16384;
    signal_descendants(getpid(), sig, 0, &budget);
}
enum { STARTED = 1, EXITED = 2, CLOSED = 3 };
struct observation { int type; pid_t pid; int status; };
static void observe(int channel, int type, pid_t pid, int status, pid_t owner) {
    struct observation value = { type, pid, status };
    if (getppid() != owner) {
        if (type == EXITED) exit_event(status);
        if (type == CLOSED) event("{\"type\":\"closed\"}\n");
    } else {
        ssize_t ignored = send(channel, &value, sizeof(value), MSG_NOSIGNAL);
        (void)ignored;
    }
}
static void guard(int channel, char **command, pid_t owner) {
    if (setup(owner)) _exit(125);
    close(3);
    nonblocking(channel);
    pid_t runner = 0;
    int runner_done = 0, closure_warned = 0;
    long long stop_at = 0;
    for (;;) {
        if (getppid() != owner) stopping = 1;
        char control[16];
        ssize_t length = recv(channel, control, sizeof(control), MSG_DONTWAIT);
        if (length == 0 || (length < 0 && errno != EAGAIN && errno != EINTR)) stopping = 1;
        if (length > 0) for (ssize_t i = 0; i < length; i++) {
            if (control[i] != 'G') stopping = 1;
            else if (!runner && !stopping) {
                pid_t guard_pid = getpid();
                runner = fork();
                if (runner < 0) _exit(125);
                if (runner == 0) {
                    if (setpgid(0, 0) || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != guard_pid) _exit(125);
                    close(channel);
                    close(4);
                    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL); signal(SIGPIPE, SIG_DFL);
                    execv(command[0], command);
                    _exit(127);
                }
                (void)setpgid(runner, runner);
                close(5);
                observe(channel, STARTED, runner, 0, owner);
            }
        }
        int status;
        pid_t child;
        while ((child = waitpid(-1, &status, WNOHANG)) > 0) {
            if (child == runner) { runner_done = 1; observe(channel, EXITED, runner, status, owner); stopping = 1; }
        }
        int empty = child < 0 && errno == ECHILD;
        if (stopping && !stop_at) {
            stop_at = milliseconds();
            if (runner && !runner_done) (void)kill(-runner, SIGTERM);
        }
        if (stop_at) {
            if (empty) { observe(channel, CLOSED, runner, 0, owner); _exit(0); }
            long long elapsed = milliseconds() - stop_at;
            sweep(elapsed >= 5000 ? SIGKILL : SIGTERM);
            if (elapsed >= 9500 && !closure_warned) { closure_warned = 1; event("{\"type\":\"closure_failed\"}\n"); }
        }
        struct pollfd pollfd = { channel, POLLIN | POLLHUP, 0 };
        (void)poll(&pollfd, 1, 25);
        if (pollfd.revents & POLLHUP) { stopping = 1; usleep(25000); }
    }
}

int main(int argc, char **argv) {
    if (argc < 2 || argv[1][0] != '/' || setup(getppid())) return 125;
    close(6); /* Optional pinned executable descriptor supplied by the launcher. */
    nonblocking(3); nonblocking(4);
    int channel[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, channel)) return 125;
    pid_t owner = getpid();
    pid_t guardian = fork();
    if (guardian < 0) return 125;
    if (!guardian) { close(channel[0]); (void)setpgid(0, 0); guard(channel[1], argv + 1, owner); }
    close(channel[1]); close(5);
    protected_guard = guardian;
    (void)setpgid(guardian, guardian);
    nonblocking(channel[0]);
    pid_t unused = 0;
    unsigned long long start = 0, guard_start = 0;
    if (identity(owner, &unused, &start) || identity(guardian, &unused, &guard_start)) stopping = 1;
    char ready[256];
    snprintf(ready, sizeof(ready), "{\"type\":\"ready\",\"pid\":%ld,\"startTime\":\"%llu\",\"guardianPid\":%ld,\"guardianStartTime\":\"%llu\"}\n",
        (long)owner, start, (long)guardian, guard_start);
    event(ready);
    pid_t runner = 0;
    int runner_done = 0, guardian_done = 0, confirmed = 0, failed = 0, started = 0, closure_warned = 0;
    long long stop_at = 0;
    for (;;) {
        char control[16];
        ssize_t length = read(3, control, sizeof(control));
        if (length == 0 || (length < 0 && errno != EAGAIN && errno != EINTR)) stopping = 1;
        if (length > 0) for (ssize_t i = 0; i < length; i++) {
            if (control[i] == 'G' && !started && !stopping) {
                started = 1;
                if (send(channel[0], "G", 1, MSG_NOSIGNAL) != 1) stopping = 1;
            } else stopping = 1;
        }
        struct observation value;
        while (recv(channel[0], &value, sizeof(value), MSG_DONTWAIT) == sizeof(value)) {
            if (value.type == STARTED) {
                runner = value.pid;
                char text[96];
                snprintf(text, sizeof(text), "{\"type\":\"runner_started\",\"pid\":%ld}\n", (long)runner);
                event(text);
            } else if (value.type == EXITED && !runner_done) { runner_done = 1; exit_event(value.status); }
            else if (value.type == CLOSED) confirmed = 1;
            else failed = 1;
        }
        int status;
        pid_t child;
        while ((child = waitpid(-1, &status, WNOHANG)) > 0) {
            if (child == guardian) {
                guardian_done = 1; stopping = 1;
                if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) failed = 1;
            }
            if (child == runner && !runner_done) { runner_done = 1; exit_event(status); }
        }
        int empty = child < 0 && errno == ECHILD;
        if (stopping && !stop_at) {
            stop_at = milliseconds();
            if (!guardian_done) {
                ssize_t ignored = send(channel[0], "T", 1, MSG_NOSIGNAL);
                (void)ignored;
                (void)kill(-guardian, SIGTERM);
            }
        }
        if (stop_at) {
            if (empty) {
                /* Consume any final packet queued just before guardian exit. */
                while (recv(channel[0], &value, sizeof(value), MSG_DONTWAIT) == sizeof(value)) {
                    if (value.type == EXITED && !runner_done) { runner_done = 1; exit_event(value.status); }
                    if (value.type == CLOSED) confirmed = 1;
                }
                event("{\"type\":\"closed\"}\n");
                return failed || (started && (!runner_done || !confirmed)) ? 125 : 0;
            }
            long long elapsed = milliseconds() - stop_at;
            if (elapsed >= 9000) protected_guard = 0;
            sweep(elapsed >= 5000 ? SIGKILL : SIGTERM);
            if (elapsed >= 9500 && !closure_warned) { closure_warned = 1; event("{\"type\":\"closure_failed\"}\n"); }
        }
        struct pollfd polls[2] = { { 3, POLLIN | POLLHUP, 0 }, { channel[0], POLLIN | POLLHUP, 0 } };
        (void)poll(polls, 2, 25);
        if ((polls[0].revents | polls[1].revents) & POLLHUP) usleep(25000);
    }
}
